import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { Admin } from '../models/Admin.js';
import { userCache } from '../cache.js';

/** fields hidden by `select: false` are absent from cached records: tell Mongoose so saves/validation skip them */
const NOT_LOADED = Object.fromEntries(
  Object.entries(User.schema.paths)
    .filter(([, t]) => t.options.select === false)
    .map(([k]) => [k, 0]),
);
/** plain user record from the cache (or DB); the cache is evicted by User model hooks on every change */
export async function getUserLean(id) {
  const key = String(id);
  let raw = userCache.get(key);
  if (!raw) {
    raw = await User.findById(key).lean({ virtuals: false });
    if (raw) userCache.set(key, raw);
  }
  return raw || null;
}
export const signToken = (id) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: '14d' });
export const verifyToken = (t) => jwt.verify(t, config.jwtSecret).sub;
/** false when the user changed their password after this token was issued */
export const sessionStillValid = (payload, user) =>
  !user.passwordChangedAt || payload.iat >= Math.floor(+user.passwordChangedAt / 1000);
export async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const payload = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', config.jwtSecret);
    const raw = await getUserLean(payload.sub);
    const user = raw && User.hydrate(raw, NOT_LOADED); // document built from cached data: no DB round trip
    if (!user || !sessionStillValid(payload, user))
      return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Authentication required' });
  }
}
/** email must be verified and a mobile number saved before using the app */
export function requireOnboarded(req, res, next) {
  if (!req.user.emailVerified)
    return res
      .status(403)
      .json({ error: 'Please verify your email first', code: 'EMAIL_NOT_VERIFIED' });
  if (!req.user.phone)
    return res
      .status(403)
      .json({ error: 'Please add your mobile number to continue', code: 'PHONE_REQUIRED' });
  if (req.user.disabled)
    return res.status(403).json({
      error: 'Your account has been disabled by an administrator',
      code: 'ACCOUNT_DISABLED',
    });
  if (!req.user.approved)
    return res
      .status(403)
      .json({ error: 'Your account is waiting for admin approval', code: 'APPROVAL_REQUIRED' });
  next();
}
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const httpError = (status, message, code) =>
  Object.assign(new Error(message), { status, code });

/* ---------- admin panel (separate accounts and signing secret from regular users) ---------- */
export const signAdminToken = (id) =>
  jwt.sign({ sub: id, role: 'admin' }, config.adminJwtSecret, { expiresIn: '12h' });
export async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const payload = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', config.adminJwtSecret);
    if (payload.role !== 'admin') throw new Error('not admin');
    const admin = await Admin.findById(payload.sub);
    if (!admin) return res.status(401).json({ error: 'Invalid session' });
    req.admin = admin;
    next();
  } catch {
    res.status(401).json({ error: 'Admin authentication required' });
  }
}
