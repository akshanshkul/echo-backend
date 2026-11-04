import { User } from './models/User.js';
import { Conversation } from './models/Conversation.js';
import { Message } from './models/Message.js';
import { serializeConv } from './serialize.js';
import { deleteObjects } from './s3.js';
import { emitConv, emitUser, getIo } from './realtime.js';

/**
 * Permanently deletes an account and what belongs to it:
 *  - the user document (email / phone / username become free again)
 *  - direct chats and notes-to-self, with all their messages
 *  - every message the user sent in groups / channels
 *  - their membership in groups (ownership passes to the next admin/member; empty groups are deleted)
 *  - their reactions, stars and poll votes, and them in other users' block lists
 *  - their profile picture and uploaded files in S3 (best effort — needs s3:DeleteObject)
 */
export async function purgeUser(user) {
  const uid = user.id;
  const keys = [];
  const collectKeys = async (filter) => {
    const rows = await Message.find({ ...filter, 'attachments.0': { $exists: true } }).select(
      'attachments.key',
    );
    rows.forEach((m) => m.attachments.forEach((a) => keys.push(a.key)));
  };
  if (user.avatarKey) keys.push(user.avatarKey);

  const convs = await Conversation.find({ 'members.user': uid }).populate('members.user');
  const summary = { chats: 0, groups: 0, messages: 0 };
  for (const c of convs) {
    const others = c.members.filter((m) => String(m.user._id) !== uid);
    if (c.type === 'dm' || c.type === 'saved' || !others.length) {
      await collectKeys({ conv: c.id });
      summary.messages += (await Message.deleteMany({ conv: c.id })).deletedCount;
      await Conversation.deleteOne({ _id: c.id });
      summary.chats++;
      others.forEach((m) => emitUser(m.user.id, 'conversation:removed', { id: c.id }));
      continue;
    }
    // group / channel with other members: leave it, keep the conversation
    const me = c.members.find((m) => String(m.user._id) === uid);
    c.members = c.members.filter((m) => m !== me);
    if (me.role === 'owner') {
      const heir = c.members.find((m) => m.role === 'admin') || c.members[0];
      heir.role = 'owner';
    }
    await c.save();
    summary.groups++;
    emitConv(c.id, 'conversation:update', {
      id: c.id,
      members: serializeConv(c, others[0].user.id).members,
    });
  }

  await collectKeys({ sender: uid });
  summary.messages += (await Message.deleteMany({ sender: uid })).deletedCount;
  // remove the user's reactions / stars / votes from remaining messages (only where they can appear)
  const scope = { conv: { $in: convs.map((c) => c._id) } };
  await Message.updateMany({ ...scope, starredBy: user._id }, { $pull: { starredBy: user._id } });
  await Message.updateMany(
    { ...scope, 'reactions.users': user._id },
    { $pull: { 'reactions.$[].users': user._id } },
  );
  await Message.updateMany(
    { ...scope, 'poll.options.votes': user._id },
    { $pull: { 'poll.options.$[].votes': user._id } },
  );
  await User.updateMany({ blocked: user._id }, { $pull: { blocked: user._id } });
  await User.deleteOne({ _id: uid });
  getIo()?.in(`user:${uid}`).disconnectSockets(true);

  summary.files = keys.length;
  summary.filesDeleted = keys.length ? await deleteObjects(keys) : 0;
  return summary;
}
