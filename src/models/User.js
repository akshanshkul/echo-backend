import mongoose from 'mongoose';
import { userCache, addEvictionHooks } from '../cache.js';
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_.]{3,24}$/,
    },
    email: { type: String, required: true, lowercase: true, trim: true },
    emailKey: { type: String, required: true, unique: true }, // normalised email: one account per real mailbox
    passwordHash: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: false },
    verifyHash: { type: String, select: false },
    verifyExpires: { type: Date, select: false },
    verifySentAt: { type: Date, select: false },
    resetHash: { type: String, select: false }, // sha256 of the emailed password-reset token
    resetExpires: { type: Date, select: false },
    resetSentAt: { type: Date, select: false },
    passwordChangedAt: { type: Date }, // sessions issued before this are rejected
    purgeAt: { type: Date }, // unverified accounts are deleted automatically (TTL index below); cleared on verification
    phone: { type: String, unique: true, sparse: true }, // E.164, set during onboarding
    approved: { type: Boolean, default: false }, // new users must be approved by an admin before they can use the app
    approvedAt: { type: Date },
    approvedBy: { type: String }, // admin name/email at the time of the decision
    disabled: { type: Boolean, default: false }, // temporarily blocked by an admin (reversible)
    disabledAt: { type: Date },
    disabledBy: { type: String },
    avatarKey: { type: String }, // S3 key: user_profile/<userId>/avatar (overwritten on every change)
    avatarUpdatedAt: { type: Date },
    // public profile: anyone can message this user without a request. Default: private (requests required).
    publicProfile: { type: Boolean, default: false },
    bio: { type: String, default: '', maxlength: 200 },
    status: { type: String, enum: ['online', 'away', 'dnd', 'offline'], default: 'offline' },
    lastSeen: { type: Date, default: Date.now },
    custom: { emoji: String, text: String },
    blocked: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);
addEvictionHooks(schema, userCache); // auth cache is dropped whenever a user changes
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
schema.virtual('onboarded').get(function () {
  return this.emailVerified && !!this.phone && !!this.approved && !this.disabled;
});
/** other people see only this */
schema.methods.toPublic = function () {
  return {
    id: this.id,
    name: this.name,
    username: this.username,
    bio: this.bio,
    avatarV: this.avatarKey && this.avatarUpdatedAt ? +this.avatarUpdatedAt : null, // version; the image URL is fetched via /users/avatar-urls
    status: this.status,
    lastSeen: this.lastSeen,
    custom: this.custom?.text ? this.custom : null,
    publicProfile: !!this.publicProfile,
  };
};
/** the signed-in user sees their own contact details too */
schema.methods.toPrivate = function () {
  return {
    ...this.toPublic(),
    email: this.email,
    phone: this.phone || null,
    emailVerified: this.emailVerified,
    phoneSet: !!this.phone,
    approved: !!this.approved,
    disabled: !!this.disabled,
    onboarded: this.onboarded,
  };
};
/** gmail ignores dots; everyone ignores +tags -> a@x.com, a+1@x.com and (for gmail) a.b@gmail.com can't create duplicates */
export function emailKey(email) {
  const [local, domain] = String(email).trim().toLowerCase().split('@');
  let l = local.split('+')[0];
  let d = domain;
  if (d === 'googlemail.com') d = 'gmail.com';
  if (d === 'gmail.com') l = l.replace(/\./g, '');
  return `${l}@${d}`;
}
export const User = mongoose.model('User', schema);
