import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import * as limits from '../rateLimits.js';
import { User, emailKey } from '../models/User.js';
import { signToken, requireAuth, wrap, httpError } from '../middleware/auth.js';
import {
  sendMail,
  verificationEmail,
  passwordResetEmail,
  passwordChangedEmail,
  resolveLogoUrl,
} from '../mailer.js';
import { config } from '../config.js';
import { Conversation } from '../models/Conversation.js';
const r = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const COOLDOWN_MS = 60 * 1000;

async function issueVerification(user) {
  const token = crypto.randomBytes(32).toString('hex');
  user.verifyHash = sha(token);
  user.verifyExpires = new Date(Date.now() + 24 * 3600 * 1000);
  user.verifySentAt = new Date();
  await user.save();
  const link = `${config.clientUrl}/verify-email?token=${token}`;
  await sendMail({
    to: user.email,
    name: user.name,
    ...verificationEmail(user, link, await resolveLogoUrl()),
  });
}

r.post(
  '/register',
  limits.register,
  wrap(async (req, res) => {
    const { name, username, email, password } = req.body || {};
    if (!name?.trim() || !username || !email || !password)
      throw httpError(400, 'Name, username, email and password are required');
    if (!EMAIL_RE.test(String(email).trim())) throw httpError(400, 'Enter a valid email address');
    if (String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
    const key = emailKey(email);
    const existing = await User.findOne({ emailKey: key });
    if (existing) {
      if (!existing.emailVerified)
        throw httpError(
          409,
          'This email is already registered but not verified. Check your inbox or resend the verification email.',
          'EMAIL_UNVERIFIED',
        );
      throw httpError(
        409,
        'An account with this email already exists. Sign in instead.',
        'EMAIL_TAKEN',
      );
    }
    if (await User.exists({ username: String(username).toLowerCase().trim() }))
      throw httpError(409, 'That username is taken', 'USERNAME_TAKEN');
    let user;
    try {
      user = await User.create({
        name,
        username,
        email,
        emailKey: key,
        passwordHash: await bcrypt.hash(password, 11),
        purgeAt: new Date(Date.now() + 7 * 864e5),
      });
    } catch (e) {
      if (e.code === 11000)
        throw httpError(409, 'An account with this email or username already exists');
      if (e.name === 'ValidationError')
        throw httpError(400, 'Username must be 3–24 letters, numbers, _ or .');
      throw e;
    }
    try {
      await issueVerification(user);
    } catch (e) {
      await User.deleteOne({ _id: user.id });
      throw e;
    } // don't leave an account nobody can verify
    res.status(201).json({ needsVerification: true, email: user.email });
  }),
);

r.post(
  '/verify-email',
  limits.tokenCheck,
  wrap(async (req, res) => {
    const token = String(req.body?.token || '');
    if (!/^[a-f0-9]{64}$/.test(token))
      throw httpError(400, 'This verification link is invalid', 'INVALID_TOKEN');
    const user = await User.findOne({ verifyHash: sha(token) }).select(
      '+verifyHash +verifyExpires',
    );
    if (!user)
      throw httpError(
        400,
        'This verification link is invalid or was already used',
        'INVALID_TOKEN',
      );
    if (user.verifyExpires < new Date())
      throw httpError(
        400,
        'This verification link has expired. Request a new one.',
        'TOKEN_EXPIRED',
      );
    user.emailVerified = true;
    user.verifyHash = undefined;
    user.verifyExpires = undefined;
    user.purgeAt = undefined;
    await user.save();
    if (!(await Conversation.exists({ type: 'saved', 'members.user': user.id })))
      await Conversation.create({
        type: 'saved',
        name: 'Saved Messages',
        members: [{ user: user.id, role: 'owner' }],
        createdBy: user.id,
      });
    res.json({ token: signToken(user.id), user: user.toPrivate() });
  }),
);

// always answers the same way so it can't be used to discover which emails have accounts
r.post(
  '/resend-verification',
  limits.mailPerIp,
  limits.mailPerAddress,
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (EMAIL_RE.test(email)) {
      const user = await User.findOne({ emailKey: emailKey(email) }).select('+verifySentAt');
      if (
        user &&
        !user.emailVerified &&
        (!user.verifySentAt || Date.now() - user.verifySentAt > COOLDOWN_MS)
      )
        await issueVerification(user);
    }
    res.json({
      ok: true,
      message: 'If that email has a pending account, a new verification link has been sent.',
    });
  }),
);

// ---- forgot / reset password ----
const RESET_TTL_MS = 60 * 60 * 1000;
// always answers the same way, so it can't be used to discover which emails have accounts
r.post(
  '/forgot-password',
  limits.mailPerIp,
  limits.mailPerAddress,
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (EMAIL_RE.test(email)) {
      const user = await User.findOne({ emailKey: emailKey(email) }).select(
        '+resetSentAt +verifySentAt',
      );
      if (user && !user.emailVerified) {
        // never verified: a password reset makes no sense yet, so send the verification link instead of nothing
        if (!user.verifySentAt || Date.now() - user.verifySentAt > COOLDOWN_MS) {
          try {
            await issueVerification(user);
          } catch (e) {
            console.error('verification mail failed:', e.message);
          }
        }
      } else if (
        user &&
        user.emailVerified &&
        (!user.resetSentAt || Date.now() - user.resetSentAt > COOLDOWN_MS)
      ) {
        const token = crypto.randomBytes(32).toString('hex');
        user.resetHash = sha(token);
        user.resetExpires = new Date(Date.now() + RESET_TTL_MS);
        user.resetSentAt = new Date();
        await user.save();
        const link = `${config.clientUrl}/reset-password?token=${token}`;
        try {
          await sendMail({
            to: user.email,
            name: user.name,
            ...passwordResetEmail(user, link, await resolveLogoUrl()),
          });
        } catch (e) {
          console.error('password reset mail failed:', e.message); // don't reveal whether the account exists
        }
      }
    }
    res.json({
      ok: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    });
  }),
);

r.post(
  '/reset-password',
  limits.tokenCheck,
  wrap(async (req, res) => {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    if (!/^[a-f0-9]{64}$/.test(token))
      throw httpError(400, 'This reset link is invalid', 'INVALID_TOKEN');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (password.length > 128) throw httpError(400, 'Password is too long');
    const user = await User.findOne({ resetHash: sha(token) }).select('+resetHash +resetExpires');
    if (!user)
      throw httpError(400, 'This reset link is invalid or was already used', 'INVALID_TOKEN');
    if (user.resetExpires < new Date())
      throw httpError(400, 'This reset link has expired. Request a new one.', 'TOKEN_EXPIRED');
    user.passwordHash = await bcrypt.hash(password, 11);
    user.passwordChangedAt = new Date(); // signs out every existing session
    user.resetHash = undefined;
    user.resetExpires = undefined;
    await user.save();
    sendMail({
      to: user.email,
      name: user.name,
      ...passwordChangedEmail(user, await resolveLogoUrl()),
    }).catch((e) => console.error('password-changed mail failed:', e.message));
    res.json({ ok: true });
  }),
);

r.post(
  '/login',
  limits.loginPerIp,
  limits.loginPerAccount,
  wrap(async (req, res) => {
    const { login, password } = req.body || {};
    const l = String(login || '')
      .trim()
      .toLowerCase();
    const user = await User.findOne({
      $or: [{ username: l }, ...(EMAIL_RE.test(l) ? [{ emailKey: emailKey(l) }] : [])],
    }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
      throw httpError(401, 'Invalid credentials');
    if (!user.emailVerified)
      throw httpError(403, 'Please verify your email before signing in.', 'EMAIL_NOT_VERIFIED');
    if (user.disabled)
      throw httpError(
        403,
        'Your account has been disabled by an administrator. Contact support if you think this is a mistake.',
        'ACCOUNT_DISABLED',
      );
    res.json({ token: signToken(user.id), user: user.toPrivate() });
  }),
);
r.get('/me', requireAuth, (req, res) => res.json({ user: req.user.toPrivate() }));
export default r;
