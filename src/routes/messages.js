import { Router } from 'express';
import mongoose from 'mongoose';
import { Message } from '../models/Message.js';
import { Conversation } from '../models/Conversation.js';
import { requireAuth, requireOnboarded, wrap, httpError } from '../middleware/auth.js';
import { serializeMessage } from '../serialize.js';
import { emitConv, emitUser } from '../realtime.js';
import { loadConv, roleOf } from './conversations.js';
import { chatMeta } from '../chatMeta.js';
import { touchChat } from '../activity.js';
import { allowMessage } from '../rateLimit.js';
import { getUserLean } from '../middleware/auth.js';
import { config } from '../config.js';
const r = Router();
r.use(requireAuth, requireOnboarded);
const valid = (id) => mongoose.isValidObjectId(id);
const ser = (m, uid) => serializeMessage(m, uid);

async function loadMsg(id, userId) {
  if (!valid(id)) throw httpError(404, 'Message not found');
  const m = await Message.findById(id);
  if (!m || !(await Conversation.exists({ _id: m.conv, 'members.user': userId })))
    throw httpError(404, 'Message not found');
  return m;
}
async function push(m, ev = 'message:update') {
  // each viewer gets "starred" for themselves, so broadcast the neutral form
  emitConv(m.conv, ev, await serializeMessage(m, null));
}

// history (paged, newest last). ?threadOf= for thread replies, ?pinned=1 for pins
r.get(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    const c = await loadConv(req.params.id, req.user.id);
    const limit = Math.min(+req.query.limit || 50, 100);
    const f = {
      conv: c.id,
      threadOf: valid(req.query.threadOf) ? req.query.threadOf : null,
      hiddenFor: { $ne: req.user._id },
    };
    if (req.query.pinned) f.pinned = true;
    if (valid(req.query.before)) f._id = { $lt: req.query.before };
    const rows = (await Message.find(f).sort({ _id: -1 }).limit(limit)).reverse();
    const counts = Object.fromEntries(
      (
        await Message.aggregate([
          { $match: { threadOf: { $in: rows.map((m) => m._id) } } },
          { $group: { _id: '$threadOf', n: { $sum: 1 } } },
        ])
      ).map((x) => [String(x._id), x.n]),
    );
    const messages = await Promise.all(
      rows.map(async (m) => ({ ...(await ser(m, req.user.id)), replyCount: counts[m.id] || 0 })),
    );
    res.json({ messages, hasMore: rows.length === limit });
  }),
);

r.post(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    // hot path: cached auth + cached chat metadata (no populate, no per-member user documents)
    if (!allowMessage(req.user.id))
      throw httpError(
        429,
        'You are sending messages too quickly. Slow down a little.',
        'RATE_LIMITED',
      );
    if (!valid(req.params.id)) throw httpError(404, 'Conversation not found');
    const c = await chatMeta(req.params.id);
    const myRole = c?.roles.get(req.user.id);
    if (!c || !myRole) throw httpError(404, 'Conversation not found');
    if (c.type === 'channel' && myRole === 'member')
      throw httpError(403, 'Only admins can post in this channel');
    if (c.type === 'dm' && c.dmStatus && c.dmStatus !== 'accepted') {
      const mineRequest = c.requestedBy === req.user.id;
      throw httpError(
        403,
        c.dmStatus === 'pending'
          ? mineRequest
            ? 'Waiting for them to accept your message request'
            : 'Accept the message request to reply'
          : 'This message request was not accepted',
        'REQUEST_PENDING',
      );
    }
    if (c.type === 'dm') {
      // block enforcement in either direction
      const otherId = c.memberIds.find((x) => x !== req.user.id);
      const other = otherId && (await getUserLean(otherId));
      if (
        other &&
        (other.blocked?.some((b) => String(b) === req.user.id) ||
          req.user.blocked?.some((b) => String(b) === String(other._id)))
      )
        throw httpError(403, 'You cannot message this user');
    }
    const { text = '', attachments = [], replyTo, threadOf, poll, type } = req.body || {};
    const doc = {
      conv: c.id,
      sender: req.user.id,
      text: String(text).slice(0, 30000),
      type: 'text',
    };
    if (valid(replyTo)) doc.replyTo = replyTo;
    if (valid(threadOf)) doc.threadOf = threadOf;
    if (attachments.length) {
      if (attachments.length > 10) throw httpError(400, 'At most 10 attachments');
      const prefix = `${config.aws.prefix}/${req.user.id}/`;
      doc.attachments = attachments.map((a) => {
        // keys must come from this user's own presigned uploads
        if (typeof a.key !== 'string' || !a.key.startsWith(prefix))
          throw httpError(400, 'Invalid attachment key');
        const kind = ['image', 'video', 'audio', 'voice', 'file'].includes(a.kind)
          ? a.kind
          : 'file';
        return {
          key: a.key,
          name: String(a.name || '').slice(0, 120),
          size: +a.size || 0,
          mime: String(a.mime || '').slice(0, 100),
          kind,
          width: +a.width || undefined,
          height: +a.height || undefined,
          duration: +a.duration || undefined,
        };
      });
      doc.type = doc.attachments.every((a) => a.kind === 'voice')
        ? 'voice'
        : doc.attachments.every((a) => ['image', 'video'].includes(a.kind))
          ? 'media'
          : 'file';
    }
    if (
      type === 'poll' &&
      poll?.question &&
      Array.isArray(poll.options) &&
      poll.options.length >= 2
    ) {
      doc.type = 'poll';
      doc.poll = {
        question: String(poll.question).slice(0, 200),
        multi: !!poll.multi,
        options: poll.options
          .slice(0, 10)
          .map((t) => ({ text: String(t).slice(0, 100), votes: [] })),
      };
    }
    if (!doc.text.trim() && !doc.attachments?.length && doc.type !== 'poll')
      throw httpError(400, 'Message is empty');
    const m = await Message.create(doc);
    // last-activity / sender-read bookkeeping is merged and written in bulk (see activity.js)
    if (!doc.threadOf) touchChat(c.M, c.id, req.user.id, m.createdAt);
    const out = await serializeMessage(m, null); // a new message is never starred, so one serialization serves everyone
    emitConv(c.id, 'message:new', out);
    res.status(201).json({ message: out });
  }),
);

r.patch(
  '/messages/:id',
  wrap(async (req, res) => {
    const m = await loadMsg(req.params.id, req.user.id);
    if (String(m.sender) !== req.user.id || m.deleted)
      throw httpError(403, 'You can only edit your own messages');
    const text = String(req.body.text ?? '').slice(0, 30000);
    if (!text.trim() && !m.attachments.length) throw httpError(400, 'Message is empty');
    m.text = text;
    m.edited = true;
    await m.save();
    await push(m);
    res.json({ message: await ser(m, req.user.id) });
  }),
);

/** can `user` delete this message for EVERYONE? Own messages: only inside the time window. Group/channel admins may moderate others' messages. */
const windowMs = () => config.messageDeleteWindowMinutes * 60 * 1000;
const inWindow = (m) => !windowMs() || Date.now() - new Date(m.createdAt).getTime() <= windowMs();
function everyoneCheck(m, c, user) {
  if (String(m.sender) === String(user._id)) return inWindow(m) ? null : 'expired';
  const role = roleOf(c, user.id);
  return c.type !== 'dm' && ['owner', 'admin'].includes(role) ? null : 'forbidden';
}
const expiredMessage = () =>
  `You can delete a message for everyone only within ${config.messageDeleteWindowMinutes} minute${config.messageDeleteWindowMinutes === 1 ? '' : 's'} of sending. You can still delete it for yourself.`;
const tombstone = (m) =>
  Object.assign(m, {
    deleted: true,
    text: '',
    attachments: [],
    poll: undefined,
    reactions: [],
    pinned: false,
  });

// client-side limits (so the UI can hide options that would be refused)
r.get('/config', (req, res) =>
  res.json({ messageDeleteWindowMinutes: config.messageDeleteWindowMinutes }),
);

// delete one message for everyone (kept for compatibility; the UI uses POST /messages/delete)
r.delete(
  '/messages/:id',
  wrap(async (req, res) => {
    const m = await loadMsg(req.params.id, req.user.id);
    const c = await loadConv(m.conv, req.user.id);
    const why = everyoneCheck(m, c, req.user);
    if (why === 'forbidden') throw httpError(403, 'Not allowed');
    if (why === 'expired') throw httpError(403, expiredMessage(), 'DELETE_WINDOW_EXPIRED');
    tombstone(m);
    await m.save();
    await push(m);
    res.json({ ok: true });
  }),
);

/**
 * Delete several messages at once.
 *   scope "me":       hide them from this user only (always allowed, no time limit)
 *   scope "everyone": remove the content for all members (own messages within the time window; admins can moderate)
 */
r.post(
  '/messages/delete',
  wrap(async (req, res) => {
    const scope = req.body?.scope;
    const ids = [...new Set((req.body?.ids || []).filter(valid))].slice(0, 100);
    if (!['me', 'everyone'].includes(scope))
      throw httpError(400, 'scope must be "me" or "everyone"');
    if (!ids.length) throw httpError(400, 'Select at least one message');
    const mine = (await Conversation.find({ 'members.user': req.user.id }).select('_id')).map(
      (c) => c._id,
    );
    const msgs = await Message.find({ _id: { $in: ids }, conv: { $in: mine } });
    if (!msgs.length) throw httpError(404, 'Messages not found');

    if (scope === 'me') {
      await Message.updateMany(
        { _id: { $in: msgs.map((m) => m._id) } },
        { $addToSet: { hiddenFor: req.user._id } },
      );
      const done = msgs.map((m) => m.id);
      emitUser(req.user.id, 'messages:hidden', { ids: done }); // also removes them on the user's other devices
      return res.json({ ok: true, scope, ids: done });
    }

    const convs = new Map();
    const blocked = { expired: [], forbidden: [] };
    for (const m of msgs) {
      if (!convs.has(String(m.conv)))
        convs.set(String(m.conv), await loadConv(m.conv, req.user.id));
      const why = everyoneCheck(m, convs.get(String(m.conv)), req.user);
      if (why) blocked[why].push(m.id);
    }
    if (blocked.expired.length || blocked.forbidden.length) {
      // all-or-nothing, so the user never ends up with a half-applied delete
      const expired = blocked.expired.length > 0;
      return res.status(403).json({
        error: expired ? expiredMessage() : 'You can only delete your own messages for everyone',
        code: expired ? 'DELETE_WINDOW_EXPIRED' : 'NOT_ALLOWED',
        notAllowed: [...blocked.expired, ...blocked.forbidden],
      });
    }
    for (const m of msgs) {
      tombstone(m);
      await m.save();
      await push(m);
    }
    res.json({ ok: true, scope, ids: msgs.map((m) => m.id) });
  }),
);

r.post(
  '/messages/:id/reactions',
  wrap(async (req, res) => {
    const m = await loadMsg(req.params.id, req.user.id);
    const emoji = String(req.body.emoji || '').slice(0, 8);
    if (!emoji) throw httpError(400, 'emoji required');
    let rx = m.reactions.find((x) => x.emoji === emoji);
    if (!rx) {
      m.reactions.push({ emoji, users: [req.user.id] });
    } else if (rx.users.some((u) => String(u) === req.user.id))
      rx.users = rx.users.filter((u) => String(u) !== req.user.id);
    else rx.users.push(req.user.id);
    m.reactions = m.reactions.filter((x) => x.users.length);
    await m.save();
    await push(m);
    res.json({ message: await ser(m, req.user.id) });
  }),
);

for (const [path, apply] of [
  [
    'pin',
    (m) => {
      m.pinned = !m.pinned;
    },
  ],
  [
    'star',
    (m, uid) => {
      const has = m.starredBy.some((u) => String(u) === uid);
      m.starredBy = has ? m.starredBy.filter((u) => String(u) !== uid) : [...m.starredBy, uid];
    },
  ],
])
  r.post(
    `/messages/:id/${path}`,
    wrap(async (req, res) => {
      const m = await loadMsg(req.params.id, req.user.id);
      apply(m, req.user.id);
      await m.save();
      if (path === 'pin') await push(m);
      res.json({ message: await ser(m, req.user.id) });
    }),
  );

r.post(
  '/messages/:id/vote',
  wrap(async (req, res) => {
    const m = await loadMsg(req.params.id, req.user.id);
    if (m.type !== 'poll') throw httpError(400, 'Not a poll');
    const opt = m.poll.options.id(req.body.option);
    if (!opt) throw httpError(404, 'Option not found');
    const had = opt.votes.some((u) => String(u) === req.user.id);
    if (!m.poll.multi)
      m.poll.options.forEach((o) => {
        o.votes = o.votes.filter((u) => String(u) !== req.user.id);
      });
    if (had && m.poll.multi) opt.votes = opt.votes.filter((u) => String(u) !== req.user.id);
    else if (!had) opt.votes.push(req.user.id);
    await m.save();
    await push(m);
    res.json({ message: await ser(m, req.user.id) });
  }),
);

// every message the user starred, newest first (only from chats they are still in)
r.get(
  '/starred',
  wrap(async (req, res) => {
    const ids = (await Conversation.find({ 'members.user': req.user.id }).select('_id')).map(
      (c) => c._id,
    );
    const rows = await Message.find({
      conv: { $in: ids },
      starredBy: req.user.id,
      hiddenFor: { $ne: req.user._id },
      deleted: false,
    })
      .sort({ _id: -1 })
      .limit(100);
    res.json({ messages: await Promise.all(rows.map((m) => ser(m, req.user.id))) });
  }),
);

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
r.get(
  '/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 80);
    if (q.length < 2) return res.json({ results: [] });
    const ids = (await Conversation.find({ 'members.user': req.user.id }).select('_id')).map(
      (c) => c._id,
    );
    const rows = await Message.find({
      conv: { $in: ids },
      hiddenFor: { $ne: req.user._id },
      deleted: false,
      type: { $ne: 'system' },
      text: new RegExp(esc(q), 'i'),
    })
      .sort({ _id: -1 })
      .limit(40);
    res.json({ results: await Promise.all(rows.map((m) => ser(m, req.user.id))) });
  }),
);
export default r;
