import { chatCache } from './cache.js';
import { chatModels } from './models/Conversation.js';

/**
 * Lightweight, cached view of a chat for the send path: kind, member roles, direct-message state.
 * (No populate, no members' user documents.) Evicted by the model hooks whenever the chat changes.
 */
export async function chatMeta(id) {
  const hit = chatCache.get(id);
  if (hit) return hit;
  const found = await Promise.all(
    Object.entries(chatModels).map(async ([type, M]) => {
      const d = await M.findOne({ _id: id }).select('type members dmStatus requestedBy').lean();
      return d && { M, d };
    }),
  );
  const f = found.find(Boolean);
  if (!f) return null;
  const roles = new Map(f.d.members.map((m) => [String(m.user), m.role]));
  return chatCache.set(id, {
    id,
    M: f.M,
    type: f.d.type,
    roles,
    memberIds: [...roles.keys()],
    dmStatus: f.d.dmStatus || null,
    requestedBy: f.d.requestedBy ? String(f.d.requestedBy) : null,
  });
}
