import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { adminLogin } from '../rateLimits.js';
import { Admin } from '../models/Admin.js';
import { User } from '../models/User.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { signAdminToken, requireAdmin, wrap, httpError } from '../middleware/auth.js';
import { avatarUrl } from '../s3.js';
import { getIo } from '../realtime.js';
import { purgeUser } from '../purgeUser.js';
import { sendMail, approvalEmail, resolveLogoUrl } from '../mailer.js';
import { config } from '../config.js';

const r = Router();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

r.post(
  '/login',
  adminLogin,
  wrap(async (req, res) => {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const admin = await Admin.findOne({ email }).select('+passwordHash');
    if (!admin || !(await bcrypt.compare(String(req.body?.password || ''), admin.passwordHash)))
      throw httpError(401, 'Invalid email or password');
    admin.lastLoginAt = new Date();
    await admin.save();
    res.json({ token: signAdminToken(admin.id), admin: admin.toPublic() });
  }),
);

r.use(requireAdmin);
r.get('/me', (req, res) => res.json({ admin: req.admin.toPublic() }));

const FILTERS = {
  all: {},
  pending: { emailVerified: true, approved: { $ne: true } }, // verified their email, waiting for a decision
  approved: { approved: true },
  unverified: { emailVerified: false },
  disabled: { disabled: true },
};

r.get(
  '/stats',
  wrap(async (req, res) => {
    const [total, approved, pending, unverified, disabled, online] = await Promise.all([
      User.countDocuments(),
      User.countDocuments(FILTERS.approved),
      User.countDocuments(FILTERS.pending),
      User.countDocuments(FILTERS.unverified),
      User.countDocuments(FILTERS.disabled),
      User.countDocuments({ status: 'online' }),
    ]);
    res.json({ total, approved, pending, unverified, disabled, online });
  }),
);

const brief = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  email: u.email,
  phone: u.phone || null,
  emailVerified: u.emailVerified,
  approved: !!u.approved,
  approvedAt: u.approvedAt || null,
  approvedBy: u.approvedBy || null,
  publicProfile: !!u.publicProfile,
  disabled: !!u.disabled,
  disabledAt: u.disabledAt || null,
  disabledBy: u.disabledBy || null,
  status: u.status,
  lastSeen: u.lastSeen,
  createdAt: u.createdAt,
  hasAvatar: !!u.avatarKey,
});

r.get(
  '/users',
  wrap(async (req, res) => {
    const status = FILTERS[req.query.status] ? req.query.status : 'all';
    const limit = Math.min(Math.max(+req.query.limit || 20, 1), 100);
    const page = Math.max(+req.query.page || 1, 1);
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 60);
    const filter = { ...FILTERS[status] };
    if (q) {
      const re = new RegExp(esc(q), 'i');
      filter.$or = [{ name: re }, { username: re }, { email: re }, { phone: re }];
    }
    const [total, rows] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    res.json({ users: rows.map(brief), total, page, pages: Math.max(Math.ceil(total / limit), 1) });
  }),
);

r.get(
  '/users/:id',
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'User not found');
    const u = await User.findById(req.params.id);
    if (!u) throw httpError(404, 'User not found');
    const convIds = (await Conversation.find({ 'members.user': u.id }).select('_id type')).map(
      (c) => c,
    );
    const [messages, files] = await Promise.all([
      Message.countDocuments({ sender: u.id, type: { $ne: 'system' } }),
      Message.countDocuments({ sender: u.id, 'attachments.0': { $exists: true } }),
    ]);
    res.json({
      user: {
        ...brief(u),
        bio: u.bio,
        custom: u.custom?.text ? u.custom : null,
        avatarUrl: u.avatarKey ? await avatarUrl(u.avatarKey) : null,
        blockedCount: u.blocked?.length || 0,
        stats: {
          conversations: convIds.filter((c) => c.type !== 'saved').length,
          groups: convIds.filter((c) => c.type === 'group').length,
          messages,
          files,
        },
      },
    });
  }),
);

async function setApproval(req, res, approved) {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'User not found');
  const u = await User.findById(req.params.id);
  if (!u) throw httpError(404, 'User not found');
  if (approved && !u.emailVerified)
    throw httpError(400, 'This user has not verified their email yet');
  const was = !!u.approved;
  u.approved = approved;
  u.approvedAt = approved ? new Date() : undefined;
  u.approvedBy = approved ? `${req.admin.name} <${req.admin.email}>` : undefined;
  await u.save();
  if (!approved) {
    // revoked: tell the open app first (it then shows the waiting screen), then drop the live connection
    const room = getIo()?.in(`user:${u.id}`);
    room?.emit('access:changed', { approved: false });
    setTimeout(() => room?.disconnectSockets(true), 300);
  }
  if (approved && !was) {
    // tell the user the good news (best effort — approval must not fail because of email)
    resolveLogoUrl()
      .then((logo) => sendMail({ to: u.email, name: u.name, ...approvalEmail(u, logo) }))
      .catch((e) => console.warn('[admin] approval email failed:', e.message));
  }
  res.json({ user: brief(u) });
}
r.post(
  '/users/:id/approve',
  wrap((req, res) => setApproval(req, res, true)),
);
r.post(
  '/users/:id/unapprove',
  wrap((req, res) => setApproval(req, res, false)),
);

// ---- temporary disable / enable (reversible) ----
async function setDisabled(req, res, disabled) {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'User not found');
  const u = await User.findById(req.params.id);
  if (!u) throw httpError(404, 'User not found');
  u.disabled = disabled;
  u.disabledAt = disabled ? new Date() : undefined;
  u.disabledBy = disabled ? `${req.admin.name} <${req.admin.email}>` : undefined;
  if (disabled) u.status = 'offline';
  await u.save();
  const room = getIo()?.in(`user:${u.id}`);
  room?.emit('access:changed', { disabled });
  if (disabled) setTimeout(() => room?.disconnectSockets(true), 300); // sign the live app out
  res.json({ user: brief(u) });
}
r.post(
  '/users/:id/disable',
  wrap((req, res) => setDisabled(req, res, true)),
);
r.post(
  '/users/:id/enable',
  wrap((req, res) => setDisabled(req, res, false)),
);

// ---- permanent delete (requires the username as confirmation) ----
r.delete(
  '/users/:id',
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'User not found');
    const u = await User.findById(req.params.id);
    if (!u) throw httpError(404, 'User not found');
    if (String(req.body?.confirm || '').toLowerCase() !== u.username)
      throw httpError(400, 'Type the username to confirm permanent deletion');
    const summary = await purgeUser(u);
    console.log(
      `[admin] ${req.admin.email} permanently deleted user @${u.username} (${u.email})`,
      summary,
    );
    res.json({ ok: true, deleted: { id: u.id, username: u.username }, summary });
  }),
);

/** creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when no admin exists yet */
export async function bootstrapAdmin() {
  const { email, password, name } = config.adminBootstrap;
  if (!email || !password) return;
  if (await Admin.exists({})) return;
  if (password.length < 10) {
    console.warn('[admin] ADMIN_PASSWORD must be at least 10 characters — admin not created');
    return;
  }
  await Admin.create({ name, email, passwordHash: await bcrypt.hash(password, 11) });
  console.log(`[admin] created first admin ${email} (change ADMIN_PASSWORD in .env afterwards)`);
}
export default r;
