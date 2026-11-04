import mongoose from 'mongoose';
import { Router } from 'express';
import { User } from '../models/User.js';
import { requireAuth, requireOnboarded, wrap, httpError } from '../middleware/auth.js';
import {
  presignAvatarUpload,
  verifyAvatarObject,
  deleteAvatarObject,
  avatarUrl,
  avatarKeyFor,
} from '../s3.js';
import { Conversation } from '../models/Conversation.js';
import { emitConv } from '../realtime.js';
const r = Router();
r.use(requireAuth);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
// onboarding step 2: mobile number (E.164, one account per number)
r.put(
  '/me/phone',
  wrap(async (req, res) => {
    if (!req.user.emailVerified)
      throw httpError(403, 'Please verify your email first', 'EMAIL_NOT_VERIFIED');
    const phone = String(req.body?.phone || '').replace(/[\s().-]/g, '');
    if (!PHONE_RE.test(phone))
      throw httpError(400, 'Enter your number with country code, e.g. +14155550123');
    if (await User.exists({ phone, _id: { $ne: req.user.id } }))
      throw httpError(
        409,
        'This mobile number is already linked to another account',
        'PHONE_TAKEN',
      );
    req.user.phone = phone;
    try {
      await req.user.save();
    } catch (e) {
      if (e.code === 11000)
        throw httpError(
          409,
          'This mobile number is already linked to another account',
          'PHONE_TAKEN',
        );
      throw e;
    }
    res.json({ user: req.user.toPrivate() });
  }),
);
r.use(requireOnboarded);

// ---- profile picture (stored at user_profile/<userId>/avatar; every upload overwrites the previous one) ----
const broadcastProfile = async (user) => {
  const convs = await Conversation.find({ 'members.user': user.id }).select('_id');
  convs.forEach((c) => emitConv(c.id, 'presence', { user: user.toPublic() }));
};
r.post(
  '/me/avatar/presign',
  wrap(async (req, res) => {
    res.json(await presignAvatarUpload(req.user.id, req.body || {}));
  }),
);
r.put(
  '/me/avatar',
  wrap(async (req, res) => {
    const contentType = req.body?.contentType || 'image/jpeg';
    const key = avatarKeyFor(req.user.id, contentType);
    const check = await verifyAvatarObject(key);
    if (!check.ok) {
      throw httpError(
        check.status === 403 ? 502 : 400,
        check.status === 403
          ? 'Storage permissions are missing for the uploads/user_profile/ folder — check the IAM policy.'
          : 'The uploaded image was not found or is not a valid image',
      );
    }
    const previous = req.user.avatarKey;
    req.user.avatarKey = key;
    req.user.avatarUpdatedAt = new Date(); // new version => every client refetches
    await req.user.save();
    if (previous && previous !== key) await deleteAvatarObject(previous); // changed format (e.g. png -> jpg): replace the old file
    broadcastProfile(req.user).catch(() => {});
    res.json({ user: req.user.toPrivate() });
  }),
);
r.delete(
  '/me/avatar',
  wrap(async (req, res) => {
    if (req.user.avatarKey) await deleteAvatarObject(req.user.avatarKey);
    req.user.avatarKey = undefined;
    req.user.avatarUpdatedAt = undefined;
    await req.user.save();
    broadcastProfile(req.user).catch(() => {});
    res.json({ user: req.user.toPrivate() });
  }),
);
// batch: ids -> short-lived signed image URLs (the bucket stays private)
r.post(
  '/avatar-urls',
  wrap(async (req, res) => {
    const ids = [
      ...new Set((req.body?.ids || []).filter((i) => mongoose.isValidObjectId(i))),
    ].slice(0, 100);
    const users = await User.find({ _id: { $in: ids }, avatarKey: { $exists: true } }).select(
      'avatarKey avatarUpdatedAt',
    );
    const urls = {};
    await Promise.all(
      users.map(async (u) => {
        urls[u.id] = { v: +u.avatarUpdatedAt, url: await avatarUrl(u.avatarKey) };
      }),
    );
    res.json({ urls });
  }),
);
r.get(
  '/',
  wrap(async (req, res) => {
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 40);
    const f = {
      _id: { $ne: req.user.id },
      emailVerified: true,
      approved: true,
      disabled: { $ne: true },
      phone: { $exists: true },
    };
    if (q)
      f.$or = [
        { name: new RegExp(esc(q), 'i') },
        { username: new RegExp(esc(q), 'i') },
        ...(/^\+\d{8,15}$/.test(q) ? [{ phone: q }] : []),
      ]; // phone: exact match only
    res.json({ users: (await User.find(f).sort({ name: 1 }).limit(30)).map((u) => u.toPublic()) });
  }),
);
r.patch(
  '/me',
  wrap(async (req, res) => {
    const { name, bio, status, custom, publicProfile } = req.body || {};
    if (typeof publicProfile === 'boolean') req.user.publicProfile = publicProfile;
    if (name !== undefined) req.user.name = String(name).trim().slice(0, 60) || req.user.name;
    if (bio !== undefined) req.user.bio = String(bio).slice(0, 200);
    if (['online', 'away', 'dnd'].includes(status)) req.user.status = status;
    if (custom !== undefined)
      req.user.custom = custom
        ? {
            emoji: String(custom.emoji || '💬').slice(0, 4),
            text: String(custom.text || '').slice(0, 60),
          }
        : undefined;
    await req.user.save();
    res.json({ user: req.user.toPrivate() });
  }),
);
r.post(
  '/:id/block',
  wrap(async (req, res) => {
    if (req.params.id === req.user.id) throw httpError(400, 'You cannot block yourself');
    const has = req.user.blocked.some((b) => String(b) === req.params.id);
    req.user.blocked = has
      ? req.user.blocked.filter((b) => String(b) !== req.params.id)
      : [...req.user.blocked, req.params.id];
    await req.user.save();
    res.json({ blocked: !has });
  }),
);
export default r;
