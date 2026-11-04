import mongoose from 'mongoose';
import { User } from './models/User.js';
import { chatModels, chatFields } from './models/Conversation.js';
/**
 * One-off, idempotent: accounts created before the approval feature existed have no `approved` field at all.
 * They are already using the app, so mark them approved. New sign-ups always get approved:false explicitly.
 */
export async function approveLegacyUsers() {
  const r = await User.collection.updateMany(
    { approved: { $exists: false } },
    { $set: { approved: true, approvedAt: new Date(), approvedBy: 'system (existing user)' } },
  );
  if (r.modifiedCount) console.log(`[migrate] approved ${r.modifiedCount} existing user(s)`);
  return r.modifiedCount;
}

/**
 * One-off, idempotent: chats used to live in a single `conversations` collection. Move every document into the
 * collection for its kind (groups / channels / direct_chats / saved_chats), keeping its _id so messages still point at it.
 */
export async function splitConversations(db = mongoose.connection.db) {
  const exists = (await db.listCollections({ name: 'conversations' }).toArray()).length > 0;
  if (!exists) return { moved: 0 };
  const legacy = db.collection('conversations');
  const moved = { group: 0, channel: 0, dm: 0, saved: 0, skipped: 0 };
  for await (const doc of legacy.find()) {
    const M = chatModels[doc.type];
    if (!M) {
      moved.skipped++;
      console.warn(
        `[migrate] conversation ${doc._id} has unknown type "${doc.type}" — left in place`,
      );
      continue;
    }
    const keep = new Set([...chatFields[doc.type], '_id', '__v']);
    const clean = Object.fromEntries(Object.entries(doc).filter(([k]) => keep.has(k)));
    try {
      await M.collection.insertOne(clean);
    } catch (e) {
      if (e.code !== 11000) throw e; // already copied by an interrupted earlier run
    }
    await legacy.deleteOne({ _id: doc._id });
    moved[doc.type]++;
  }
  if (!(await legacy.countDocuments())) await legacy.drop().catch(() => {});
  const total = moved.group + moved.channel + moved.dm + moved.saved;
  if (total)
    console.log(
      `[migrate] moved chats into separate collections: ${moved.group} group(s), ${moved.channel} channel(s), ${moved.dm} direct, ${moved.saved} saved`,
    );
  return { moved: total, ...moved };
}

/**
 * Message write-path indexes: the full-text index on `text` (never queried with $text) made every insert
 * expensive, and the single-field `conv` index is already covered by the {conv, createdAt} compound index.
 */
export async function dropLegacyMessageIndexes(db = mongoose.connection.db) {
  const col = db.collection('messages');
  for (const name of ['text_text', 'conv_1']) {
    try {
      await col.dropIndex(name);
      console.log(`[migrate] dropped messages index ${name}`);
    } catch {
      /* not present: nothing to do */
    }
  }
}
