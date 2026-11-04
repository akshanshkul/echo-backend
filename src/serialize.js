import { signedGetUrl } from './s3.js';
export async function serializeMessage(m, meId) {
  const o = m.toObject ? m.toObject({ virtuals: false }) : m;
  const out = {
    id: String(o._id),
    conv: String(o.conv),
    sender: String(o.sender?._id ?? o.sender),
    type: o.type,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    text: o.deleted ? '' : o.text,
    deleted: o.deleted,
    edited: o.edited,
    pinned: o.pinned,
    replyTo: o.replyTo ? String(o.replyTo._id ?? o.replyTo) : null,
    threadOf: o.threadOf ? String(o.threadOf) : null,
    starred: meId ? (o.starredBy || []).some((u) => String(u) === String(meId)) : false,
    reactions: o.deleted
      ? []
      : (o.reactions || [])
          .filter((r) => r.users.length)
          .map((r) => ({ emoji: r.emoji, users: r.users.map(String) })),
    attachments: [],
    poll: null,
  };
  if (!o.deleted) {
    out.attachments = await Promise.all(
      (o.attachments || []).map(async (a) => ({ ...a, url: await signedGetUrl(a.key) })),
    );
    if (o.poll?.question)
      out.poll = {
        question: o.poll.question,
        multi: o.poll.multi,
        options: o.poll.options.map((x) => ({
          id: String(x._id),
          text: x.text,
          votes: x.votes.map(String),
        })),
      };
  }
  return out;
}
/** invite link: admins always see it; members see it unless the chat is private (then only admins can share) */
function inviteInfo(c, mine) {
  const admin = mine && ['owner', 'admin'].includes(mine.role);
  return {
    ...(c.inviteCode && (admin || (mine && c.privacy !== 'private'))
      ? { inviteCode: c.inviteCode }
      : {}),
    ...(admin ? { pendingRequests: (c.joinRequests || []).length } : {}),
  };
}
/** message-request state of a direct chat, from the point of view of `me` */
export const dmInfo = (c, me) => {
  const status = c.dmStatus || 'accepted';
  const requester = c.requestedBy ? String(c.requestedBy) : null;
  return {
    status,
    requestedBy: requester,
    incoming: status === 'pending' && requester !== String(me), // someone is asking ME for permission
    note: status === 'pending' && requester !== String(me) ? c.requestNote || '' : undefined,
    respondedAt: status === 'declined' ? c.respondedAt : undefined,
  };
};
export const serializeConv = (c, me, extra = {}) => {
  const mine = c.members.find((m) => String(m.user._id ?? m.user) === String(me));
  return {
    id: String(c._id),
    type: c.type,
    name: c.name,
    desc: c.desc,
    createdBy: String(c.createdBy || ''),
    privacy: c.privacy || 'private',
    handle: c.handle || null,
    ...(['group', 'channel'].includes(c.type) ? inviteInfo(c, mine) : {}),
    ...(c.type === 'dm' ? { dm: dmInfo(c, me) } : {}),
    lastMessageAt: c.lastMessageAt,
    members: c.members.map((m) => ({
      user: m.user.toPublic ? m.user.toPublic() : { id: String(m.user) },
      role: m.role,
      lastRead: m.lastRead,
    })),
    me: mine
      ? { muted: mine.muted, pinned: mine.pinned, archived: mine.archived, lastRead: mine.lastRead }
      : null,
    ...extra,
  };
};
