import { Router } from 'express';
import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { requireAuth, requireOnboarded, wrap, httpError } from '../middleware/auth.js';
import { serializeConv, serializeMessage, dmInfo } from '../serialize.js';
import { emitConv, emitUser, joinConv } from '../realtime.js';
import crypto from 'node:crypto';
const r = Router();
r.use(requireAuth, requireOnboarded);
const valid = (id) => mongoose.isValidObjectId(id);
const populate = (q) => q.populate('members.user');

export async function loadConv(id, userId) {
  if (!valid(id)) throw httpError(404, 'Conversation not found');
  const c = await populate(Conversation.findOne({ _id: id, 'members.user': userId }));
  if (!c) throw httpError(404, 'Conversation not found');
  return c;
}
export const roleOf = (c, uid) =>
  c.members.find((m) => String(m.user._id ?? m.user) === String(uid))?.role;

r.get(
  '/',
  wrap(async (req, res) => {
    const convs = await populate(
      Conversation.find({
        'members.user': req.user.id,
        // a declined request is hidden from the person who declined it
        $nor: [{ dmStatus: 'declined', requestedBy: { $ne: req.user.id } }],
      }).sort({ lastMessageAt: -1 }),
    );
    const out = await Promise.all(
      convs.map(async (c) => {
        const me = c.members.find((m) => String(m.user._id) === req.user.id);
        const [last, unread] = await Promise.all([
          Message.findOne({ conv: c.id, threadOf: null, hiddenFor: { $ne: req.user._id } }).sort({
            createdAt: -1,
          }),
          Message.countDocuments({
            conv: c.id,
            threadOf: null,
            hiddenFor: { $ne: req.user._id },
            sender: { $ne: req.user.id },
            createdAt: { $gt: me.lastRead },
          }),
        ]);
        return serializeConv(c, req.user.id, {
          unread,
          lastMessage: last ? await serializeMessage(last, req.user.id) : null,
        });
      }),
    );
    res.json({ conversations: out });
  }),
);

const PRIVACY = ['public', 'approval', 'private'];
const MAX_PENDING_REQUESTS = 30;
const REREQUEST_AFTER_MS = 7 * 24 * 3600 * 1000; // after a decline, the sender may ask again after a week
const HANDLE_RE = /^[a-z0-9_]{4,32}$/;
const isAdmin = (c, uid) => ['owner', 'admin'].includes(roleOf(c, uid));
const newInviteCode = () => crypto.randomBytes(16).toString('base64url');
const slug = (name) =>
  String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
/** a free handle: the requested one (409 if taken) or one derived from the name (random suffix if needed) */
async function allocateHandle(requested, name, selfId) {
  if (requested) {
    const h = String(requested).toLowerCase().replace(/^@/, '').trim();
    if (!HANDLE_RE.test(h))
      throw httpError(400, 'Handle must be 4–32 letters, numbers or underscores', 'BAD_HANDLE');
    if (await Conversation.exists({ handle: h, _id: { $ne: selfId } }))
      throw httpError(409, 'That handle is already taken', 'HANDLE_TAKEN');
    return h;
  }
  let base = slug(name);
  if (base.length < 4) base = (base + '_chat').slice(0, 24);
  for (let i = 0; i < 20; i++) {
    const h = i ? `${base}_${Math.floor(1000 + Math.random() * 9000)}` : base;
    if (!(await Conversation.exists({ handle: h }))) return h;
  }
  return `${base}_${crypto.randomBytes(3).toString('hex')}`;
}
const dirItem = (c, meId) => ({
  id: String(c._id),
  type: c.type,
  name: c.name,
  desc: c.desc,
  handle: c.handle || null,
  privacy: c.privacy,
  memberCount: c.members.length,
  requested: (c.joinRequests || []).some((j) => String(j.user) === String(meId)),
});
async function addMember(conv, user, { announce = true } = {}) {
  if (conv.members.some((m) => String(m.user._id ?? m.user) === user.id)) return;
  conv.members.push({ user: user.id });
  conv.joinRequests = (conv.joinRequests || []).filter((j) => String(j.user) !== user.id);
  await conv.save();
  if (announce && conv.type === 'group')
    await Message.create({
      conv: conv.id,
      sender: user.id,
      type: 'system',
      text: `${user.name} joined`,
    });
  const full = await populate(Conversation.findById(conv.id));
  await joinConv(full);
  emitUser(
    user.id,
    'conversation:new',
    serializeConv(full, user.id, { unread: 0, lastMessage: null }),
  );
  emitConv(conv.id, 'conversation:update', {
    id: conv.id,
    members: serializeConv(full, user.id).members,
  });
}
/** public -> joins now | approval -> pending request for the admins | private -> only via invite link */
async function joinOrRequest(conv, user, { viaLink }) {
  if (conv.members.some((m) => String(m.user._id ?? m.user) === user.id))
    return { status: 'member' };
  if (conv.privacy === 'private' && !viaLink)
    throw httpError(403, 'This is private. Ask an admin for an invite link.', 'PRIVATE');
  if (conv.privacy === 'approval') {
    if (!conv.joinRequests.some((j) => String(j.user) === user.id)) {
      conv.joinRequests.push({ user: user.id });
      await conv.save();
      conv.members
        .filter((m) => ['owner', 'admin'].includes(m.role))
        .forEach((m) =>
          emitUser(String(m.user._id ?? m.user), 'join-request', {
            conv: conv.id,
            name: conv.name,
            user: user.toPublic(),
            count: conv.joinRequests.length,
          }),
        );
    }
    return { status: 'requested' };
  }
  await addMember(conv, user);
  return { status: 'joined' };
}
const findJoinable = async (id) => {
  if (!valid(id)) throw httpError(404, 'Not found');
  const c = await populate(Conversation.findOne({ _id: id, type: { $in: ['group', 'channel'] } }));
  if (!c) throw httpError(404, 'Not found');
  return c;
};
const findByCode = async (code) => {
  const c = await populate(
    Conversation.findOne({ inviteCode: String(code), type: { $in: ['group', 'channel'] } }),
  );
  if (!c) throw httpError(404, 'This invite link is invalid or was reset', 'BAD_INVITE');
  return c;
};

// ---- discover / join / invite links (declared before /:id so they are not shadowed) ----
r.get(
  '/discover',
  wrap(async (req, res) => {
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 40);
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const f = {
      type: { $in: ['group', 'channel'] },
      privacy: { $in: ['public', 'approval'] },
      'members.user': { $ne: req.user._id },
    };
    if (q)
      f.$or = ['name', 'handle', 'desc'].map((k) => ({
        [k]: new RegExp(esc.replace(/^@/, ''), 'i'),
      }));
    const rows = await Conversation.find(f).sort({ lastMessageAt: -1 }).limit(40);
    res.json({ results: rows.map((c) => dirItem(c, req.user.id)) });
  }),
);

r.get(
  '/invite/:code',
  wrap(async (req, res) => {
    const c = await findByCode(req.params.code);
    const isMember = c.members.some((m) => String(m.user._id) === req.user.id);
    res.json({
      invite: {
        ...dirItem(c, req.user.id),
        isMember,
        ...(isMember ? { conversationId: c.id } : {}),
      },
    });
  }),
);
r.post(
  '/invite/:code/join',
  wrap(async (req, res) => {
    const c = await findByCode(req.params.code);
    const out = await joinOrRequest(c, req.user, { viaLink: true });
    res.json({ ...out, conversationId: c.id });
  }),
);
r.post(
  '/:id/join',
  wrap(async (req, res) => {
    const c = await findJoinable(req.params.id);
    const out = await joinOrRequest(c, req.user, { viaLink: false });
    res.json({ ...out, conversationId: c.id });
  }),
);
r.delete(
  '/:id/join-request',
  wrap(async (req, res) => {
    const c = await findJoinable(req.params.id);
    c.joinRequests = c.joinRequests.filter((j) => String(j.user) !== req.user.id);
    await c.save();
    res.json({ ok: true });
  }),
);

r.post(
  '/',
  wrap(async (req, res) => {
    const {
      type,
      userId,
      name,
      desc,
      memberIds = [],
      privacy = 'private',
      handle,
    } = req.body || {};
    let conv;
    if (type === 'dm') {
      if (!valid(userId) || userId === req.user.id) throw httpError(400, 'Valid userId required');
      if (
        !(await User.exists({
          _id: userId,
          emailVerified: true,
          approved: true,
          disabled: { $ne: true },
          phone: { $exists: true },
        }))
      )
        throw httpError(404, 'User not found');
      const target = await User.findById(userId).select('blocked publicProfile name');
      if (
        target.blocked?.some((x) => String(x) === req.user.id) ||
        req.user.blocked?.some((x) => String(x) === userId)
      )
        throw httpError(403, 'You cannot message this user');
      const dmKey = [req.user.id, userId].sort().join(':');
      const note = String(req.body?.note || '')
        .trim()
        .slice(0, 200);
      conv = await Conversation.findOne({ dmKey });
      if (!conv) {
        // public profiles can be messaged directly; everyone else must accept a request first
        const direct = !!target.publicProfile;
        if (!direct) {
          const open = await Conversation.countDocuments({
            requestedBy: req.user.id,
            dmStatus: 'pending',
          });
          if (open >= MAX_PENDING_REQUESTS)
            throw httpError(
              429,
              'You have too many pending message requests. Wait for replies before sending more.',
              'TOO_MANY_REQUESTS',
            );
        }
        conv = await Conversation.create({
          type: 'dm',
          dmKey,
          createdBy: req.user.id,
          members: [{ user: req.user.id }, { user: userId }],
          ...(direct
            ? { dmStatus: 'accepted', respondedAt: new Date() }
            : {
                dmStatus: 'pending',
                requestedBy: req.user.id,
                requestNote: note,
                requestedAt: new Date(),
              }),
        });
      } else if (conv.dmStatus === 'declined' && String(conv.requestedBy) === req.user.id) {
        const since = Date.now() - new Date(conv.respondedAt || 0).getTime();
        if (!target.publicProfile && since < REREQUEST_AFTER_MS)
          throw httpError(
            403,
            `${target.name.split(' ')[0]} hasn't accepted your request. You can ask again in ${Math.ceil((REREQUEST_AFTER_MS - since) / 864e5)} day(s).`,
            'REQUEST_DECLINED',
          );
        Object.assign(
          conv,
          target.publicProfile
            ? { dmStatus: 'accepted', respondedAt: new Date() }
            : {
                dmStatus: 'pending',
                requestNote: note,
                requestedAt: new Date(),
                respondedAt: undefined,
              },
        );
        await conv.save();
      } else if (conv.dmStatus === 'declined') {
        // the person who declined is now reaching out themselves: that counts as accepting
        Object.assign(conv, { dmStatus: 'accepted', respondedAt: new Date() });
        await conv.save();
      } else if (conv.dmStatus === 'pending' && target.publicProfile) {
        Object.assign(conv, { dmStatus: 'accepted', respondedAt: new Date() });
        await conv.save();
      }
    } else if (type === 'group' || type === 'channel') {
      if (!String(name || '').trim()) throw httpError(400, 'Name is required');
      const ids = [...new Set(memberIds.filter(valid).filter((i) => i !== req.user.id))];
      if (!PRIVACY.includes(privacy))
        throw httpError(400, 'privacy must be public, approval or private');
      // a group that anyone can join may start empty; a private one needs at least one invited member
      if (type === 'group' && privacy === 'private' && !ids.length)
        throw httpError(400, 'Add at least one member');
      conv = await Conversation.create({
        type,
        privacy,
        inviteCode: newInviteCode(),
        ...(privacy !== 'private' ? { handle: await allocateHandle(handle, name) } : {}),
        name: String(name).trim(),
        desc: String(desc || '').slice(0, 300),
        createdBy: req.user.id,
        members: [{ user: req.user.id, role: 'owner' }, ...ids.map((user) => ({ user }))],
      });
      await Message.create({
        conv: conv.id,
        sender: req.user.id,
        type: 'system',
        text: `${req.user.name} created ${type === 'group' ? 'the group' : 'the channel'} “${conv.name}”`,
      });
    } else throw httpError(400, 'type must be dm, group or channel');
    const full = await populate(Conversation.findById(conv.id));
    await joinConv(full);
    const payload = (uid) => serializeConv(full, uid, { unread: 0, lastMessage: null });
    full.members.forEach((m) => emitUser(m.user.id, 'conversation:new', payload(m.user.id)));
    res.status(201).json({ conversation: payload(req.user.id) });
  }),
);

r.get(
  '/:id',
  wrap(async (req, res) =>
    res.json({
      conversation: serializeConv(await loadConv(req.params.id, req.user.id), req.user.id),
    }),
  ),
);

r.patch(
  '/:id',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (
      !['owner', 'admin'].includes(roleOf(c, req.user.id)) ||
      !['group', 'channel'].includes(c.type)
    )
      throw httpError(403, 'Only admins can edit this conversation');
    if (req.body.name) c.name = String(req.body.name).trim().slice(0, 60);
    if (req.body.desc !== undefined) c.desc = String(req.body.desc).slice(0, 300);
    if (req.body.privacy !== undefined) {
      if (!PRIVACY.includes(req.body.privacy)) throw httpError(400, 'Invalid privacy setting');
      c.privacy = req.body.privacy;
      if (c.privacy === 'private') {
        c.handle = undefined; // hidden: no public handle, pending requests are dropped
        c.joinRequests = [];
      } else if (req.body.handle || !c.handle) {
        c.handle = await allocateHandle(req.body.handle, c.name, c.id);
      }
      if (c.privacy === 'public') {
        // opened to everyone: let waiting people in
        const waiting = await User.find({ _id: { $in: c.joinRequests.map((j) => j.user) } });
        await c.save();
        for (const u of waiting) await addMember(await populate(Conversation.findById(c.id)), u);
      }
    } else if (req.body.handle && c.privacy !== 'private') {
      c.handle = await allocateHandle(req.body.handle, c.name, c.id);
    }
    await c.save();
    const fresh = await populate(Conversation.findById(c.id));
    const p = serializeConv(fresh, req.user.id);
    emitConv(c.id, 'conversation:update', {
      id: c.id,
      name: c.name,
      desc: c.desc,
      privacy: fresh.privacy,
      handle: fresh.handle || null,
    });
    res.json({ conversation: p });
  }),
);

// per-user flags: mute / pin / archive
r.patch(
  '/:id/me',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    const m = c.members.find((x) => String(x.user._id) === req.user.id);
    for (const k of ['muted', 'pinned', 'archived'])
      if (typeof req.body[k] === 'boolean') m[k] = req.body[k];
    await c.save();
    res.json({ me: { muted: m.muted, pinned: m.pinned, archived: m.archived } });
  }),
);

// owner-only: permanently deletes a group/channel for everyone (messages included)
r.delete(
  '/:id',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (!['group', 'channel'].includes(c.type))
      throw httpError(400, 'Only groups and channels can be deleted');
    if (roleOf(c, req.user.id) !== 'owner')
      throw httpError(403, 'Only the owner can delete this ' + c.type, 'OWNER_ONLY');
    const memberIds = c.members.map((m) => String(m.user._id));
    const asked = c.joinRequests.map((j) => String(j.user));
    await Message.deleteMany({ conv: c.id });
    await Conversation.deleteOne({ _id: c.id });
    [...new Set([...memberIds, ...asked])].forEach((uid) => {
      emitUser(uid, 'conversation:removed', {
        id: c.id,
        deleted: true,
        name: c.name,
        by: req.user.id,
      });
      io_leave(uid, c.id);
    });
    res.json({ ok: true });
  }),
);

r.get(
  '/:id/requests',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (!isAdmin(c, req.user.id)) throw httpError(403, 'Only admins can see join requests');
    const users = await User.find({ _id: { $in: c.joinRequests.map((j) => j.user) } });
    const at = Object.fromEntries(c.joinRequests.map((j) => [String(j.user), j.at]));
    res.json({ requests: users.map((u) => ({ user: u.toPublic(), at: at[u.id] })) });
  }),
);
r.post(
  '/:id/requests/:userId/approve',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (!isAdmin(c, req.user.id)) throw httpError(403, 'Only admins can approve requests');
    if (!c.joinRequests.some((j) => String(j.user) === req.params.userId))
      throw httpError(404, 'No such request');
    const u = await User.findById(req.params.userId);
    if (u) await addMember(c, u);
    emitUser(req.params.userId, 'join-decision', { conv: c.id, name: c.name, approved: true });
    res.json({ ok: true });
  }),
);
r.delete(
  '/:id/requests/:userId',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (!isAdmin(c, req.user.id)) throw httpError(403, 'Only admins can decline requests');
    c.joinRequests = c.joinRequests.filter((j) => String(j.user) !== req.params.userId);
    await c.save();
    emitUser(req.params.userId, 'join-decision', { conv: c.id, name: c.name, approved: false });
    res.json({ ok: true });
  }),
);
r.post(
  '/:id/invite-link/reset',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (!isAdmin(c, req.user.id) || !['group', 'channel'].includes(c.type))
      throw httpError(403, 'Only admins can reset the invite link');
    c.inviteCode = newInviteCode(); // the old link stops working
    await c.save();
    res.json({ inviteCode: c.inviteCode });
  }),
);

// ---- direct message requests ----
async function respondToRequest(req, res, accept) {
  const c = await loadConv(req.params.id, req.user.id);
  if (c.type !== 'dm' || c.dmStatus !== 'pending' || String(c.requestedBy) === req.user.id)
    throw httpError(400, 'There is no pending request to answer here');
  const requesterId = String(c.requestedBy);
  c.dmStatus = accept ? 'accepted' : 'declined';
  c.respondedAt = new Date();
  const note = c.requestNote;
  await c.save();
  if (accept && note) {
    // the intro note becomes the first message in the chat
    const m = await Message.create({ conv: c.id, sender: requesterId, text: note });
    c.lastMessageAt = m.createdAt;
    await c.save();
    emitConv(c.id, 'message:new', await serializeMessage(m, null));
  }
  if (!accept && req.body?.block) {
    const me = await User.findById(req.user.id);
    if (!me.blocked.some((x) => String(x) === requesterId)) me.blocked.push(requesterId);
    await me.save();
  }
  const full = await populate(Conversation.findById(c.id));
  for (const m of full.members) {
    const uid = m.user.id;
    if (!accept && uid === req.user.id)
      emitUser(uid, 'conversation:removed', { id: c.id }); // declined requests disappear for the recipient
    else emitUser(uid, 'conversation:update', { id: c.id, dm: dmInfo(full, uid) });
  }
  res.json({ conversation: serializeConv(full, req.user.id), ok: true });
}
r.post(
  '/:id/accept',
  wrap((req, res) => respondToRequest(req, res, true)),
);
r.post(
  '/:id/decline',
  wrap((req, res) => respondToRequest(req, res, false)),
);

r.post(
  '/:id/read',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    const m = c.members.find((x) => String(x.user._id) === req.user.id);
    m.lastRead = new Date();
    await c.save();
    emitConv(c.id, 'read', { conv: c.id, user: req.user.id, at: m.lastRead });
    res.json({ ok: true });
  }),
);

r.post(
  '/:id/members',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    if (c.type !== 'group' && c.type !== 'channel') throw httpError(400, 'Not a group');
    if (!['owner', 'admin'].includes(roleOf(c, req.user.id)))
      throw httpError(403, 'Only admins can add members');
    const have = new Set(c.members.map((m) => String(m.user._id)));
    const add = (req.body.userIds || []).filter((i) => valid(i) && !have.has(i));
    const users = await User.find({ _id: { $in: add } });
    users.forEach((u) => c.members.push({ user: u.id }));
    await c.save();
    if (users.length)
      await Message.create({
        conv: c.id,
        sender: req.user.id,
        type: 'system',
        text: `${req.user.name} added ${users.map((u) => u.name.split(' ')[0]).join(', ')}`,
      });
    const full = await populate(Conversation.findById(c.id));
    await joinConv(full);
    users.forEach((u) =>
      emitUser(
        u.id,
        'conversation:new',
        serializeConv(full, u.id, { unread: 0, lastMessage: null }),
      ),
    );
    emitConv(c.id, 'conversation:update', {
      id: c.id,
      members: serializeConv(full, req.user.id).members,
    });
    res.json({ conversation: serializeConv(full, req.user.id) });
  }),
);

r.patch(
  '/:id/members/:userId',
  wrap(async (req, res) => {
    // role change (owner only)
    const c = await loadConv(req.params.id, req.user.id);
    if (roleOf(c, req.user.id) !== 'owner') throw httpError(403, 'Only the owner can change roles');
    const m = c.members.find((x) => String(x.user._id) === req.params.userId);
    if (!m || m.role === 'owner') throw httpError(404, 'Member not found');
    if (['admin', 'member'].includes(req.body.role)) m.role = req.body.role;
    await c.save();
    emitConv(c.id, 'conversation:update', {
      id: c.id,
      members: serializeConv(c, req.user.id).members,
    });
    res.json({ ok: true });
  }),
);

r.delete(
  '/:id/members/:userId',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    const self = req.params.userId === req.user.id;
    if (!self && !['owner', 'admin'].includes(roleOf(c, req.user.id)))
      throw httpError(403, 'Only admins can remove members');
    const target = c.members.find((x) => String(x.user._id) === req.params.userId);
    if (!target || target.role === 'owner') throw httpError(400, 'Cannot remove this member');
    c.members = c.members.filter((x) => x !== target);
    await c.save();
    emitUser(req.params.userId, 'conversation:removed', { id: c.id });
    io_leave(req.params.userId, c.id);
    emitConv(c.id, 'conversation:update', {
      id: c.id,
      members: serializeConv(c, req.user.id).members,
    });
    res.json({ ok: true });
  }),
);
import { getIo } from '../realtime.js';
const io_leave = (uid, cid) => getIo()?.in(`user:${uid}`).socketsLeave(`conv:${cid}`);
export default r;
