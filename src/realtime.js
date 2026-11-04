import { Server } from 'socket.io';
import { config } from './config.js';
import jwt from 'jsonwebtoken';
import { sessionStillValid } from './middleware/auth.js';
import { User } from './models/User.js';
import { Conversation } from './models/Conversation.js';

let io;
const online = new Map(); // userId -> socket count
export const getIo = () => io;
export const emitConv = (convId, ev, payload) => io?.to(`conv:${convId}`).emit(ev, payload);
export const emitUser = (userId, ev, payload) => io?.to(`user:${userId}`).emit(ev, payload);
export async function joinConv(conv) {
  // make every connected member join a new/updated conversation room
  for (const m of conv.members)
    io?.in(`user:${m.user._id ?? m.user}`).socketsJoin(`conv:${conv.id}`);
}
export function initRealtime(server) {
  io = new Server(server, { cors: { origin: config.clientOrigin, credentials: true } });
  io.use(async (s, next) => {
    try {
      const payload = jwt.verify(s.handshake.auth?.token || '', config.jwtSecret);
      s.userId = payload.sub;
      const u = await User.findById(s.userId);
      next(
        u?.emailVerified && u.phone && u.approved && !u.disabled && sessionStillValid(payload, u)
          ? undefined
          : new Error('unauthorized'),
      );
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', async (s) => {
    const uid = s.userId;
    try {
      s.join(`user:${uid}`);
      const convs = await Conversation.find({ 'members.user': uid }).select('_id');
      convs.forEach((c) => s.join(`conv:${c.id}`));
      online.set(uid, (online.get(uid) || 0) + 1);
      if (online.get(uid) === 1) await setPresence(uid, 'online', convs);
    } catch (e) {
      console.error('socket init failed:', e.message);
    }
    s.on('typing', ({ conv, kind }) => {
      if (s.rooms.has(`conv:${conv}`))
        s.to(`conv:${conv}`).emit('typing', {
          conv,
          user: uid,
          kind: ['typing', 'recording', 'uploading'].includes(kind) ? kind : 'typing',
        });
    });
    s.on('typing:stop', ({ conv }) =>
      s.to(`conv:${conv}`).emit('typing', { conv, user: uid, kind: null }),
    );
    s.on('disconnect', async () => {
      const n = (online.get(uid) || 1) - 1;
      if (n <= 0) {
        online.delete(uid);
        await setPresence(uid, 'offline');
      } else online.set(uid, n);
    });
  });
  return io;
}
async function setPresence(uid, status, convs) {
  try {
    await setPresenceUnsafe(uid, status, convs);
  } catch (e) {
    console.error('presence update failed:', e.message);
  }
}
async function setPresenceUnsafe(uid, status, convs) {
  const user = await User.findByIdAndUpdate(
    uid,
    { status, lastSeen: new Date() },
    { returnDocument: 'after' },
  );
  if (!user) return;
  convs ??= await Conversation.find({ 'members.user': uid }).select('_id');
  convs.forEach((c) => emitConv(c.id, 'presence', { user: user.toPublic() }));
}
