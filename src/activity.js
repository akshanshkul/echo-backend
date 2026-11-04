import mongoose from 'mongoose';
/**
 * Write-behind for "last activity" data. Every sent message used to rewrite its whole chat document
 * (hot document under load). Now the latest timestamps are merged in memory and flushed in ONE bulk write
 * every FLUSH_MS, using atomic $max updates — so ordering/unread stay correct and nothing is lost on crash
 * beyond a few hundred ms of "last activity" metadata (the messages themselves are always written immediately).
 */
const FLUSH_MS = 250;
const pending = new Map(); // chatId -> { M, at, reads: Map<userId, Date> }

export function touchChat(M, chatId, userId, at) {
  let e = pending.get(chatId);
  if (!e) pending.set(chatId, (e = { M, at, reads: new Map() }));
  if (at > e.at) e.at = at;
  const prev = e.reads.get(userId);
  if (!prev || at > prev) e.reads.set(userId, at);
}

let flushing = false;
export async function flushActivity() {
  if (flushing || !pending.size) return;
  flushing = true;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    const byModel = new Map();
    for (const [id, e] of batch) {
      const ops = byModel.get(e.M) || byModel.set(e.M, []).get(e.M);
      const _id = new mongoose.Types.ObjectId(id);
      ops.push({ updateOne: { filter: { _id }, update: { $max: { lastMessageAt: e.at } } } });
      for (const [uid, at] of e.reads)
        ops.push({
          updateOne: {
            filter: { _id },
            update: { $max: { 'members.$[m].lastRead': at } },
            arrayFilters: [{ 'm.user': new mongoose.Types.ObjectId(uid) }],
          },
        });
    }
    await Promise.all([...byModel].map(([M, ops]) => M.bulkWrite(ops, { ordered: false })));
  } catch (e) {
    console.error('[activity] flush failed:', e.message);
  } finally {
    flushing = false;
  }
}
const timer = setInterval(flushActivity, FLUSH_MS);
timer.unref();
for (const sig of ['SIGTERM', 'SIGINT'])
  process.once(sig, async () => {
    await flushActivity();
    process.exit(0);
  });
