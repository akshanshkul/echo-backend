import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import { config } from './config.js';

// Credentials are read by the AWS SDK from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (backend/.env) — never from the frontend.
let client;
const s3 = () => (client ??= new S3Client({ region: config.aws.region }));
export const s3Ready = () => Boolean(config.aws.bucket && config.aws.region);

const ALLOWED =
  /^(image|video|audio)\/|^application\/(pdf|zip|json|msword|vnd\.|octet-stream)|^text\//;
export function kindFromMime(m = '') {
  return m.startsWith('image/')
    ? 'image'
    : m.startsWith('video/')
      ? 'video'
      : m.startsWith('audio/')
        ? 'audio'
        : 'file';
}
export async function presignUpload(userId, { filename, contentType, size }) {
  if (!s3Ready()) {
    const e = new Error(
      'File storage is not configured. Set AWS_REGION and AWS_S3_BUCKET in backend/.env',
    );
    e.status = 503;
    throw e;
  }
  if (!ALLOWED.test(contentType || '')) {
    const e = new Error('File type not allowed');
    e.status = 415;
    throw e;
  }
  if (!(size > 0) || size > config.maxUploadMB * 1048576) {
    const e = new Error(`File must be under ${config.maxUploadMB} MB`);
    e.status = 413;
    throw e;
  }
  const safe = String(filename || 'file')
    .replace(/[^\w.\-]+/g, '_')
    .slice(-80);
  const key = `${config.aws.prefix}/${userId}/${crypto.randomUUID()}-${safe}`;
  const cmd = new PutObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: size,
  });
  const uploadUrl = await getSignedUrl(s3(), cmd, { expiresIn: 300 });
  return { key, uploadUrl, headers: { 'Content-Type': contentType } };
}
const cache = new Map();
export async function signedGetUrl(key) {
  if (!s3Ready() || !key) return null;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;
  const url = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: config.aws.bucket, Key: key }),
    { expiresIn: 3600 },
  );
  cache.set(key, { url, exp: Date.now() + 50 * 60 * 1000 });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return url;
}

/* ---------- profile pictures: one fixed key per user, so a new upload replaces the old one ---------- */
export const AVATAR_PREFIX = `${config.aws.prefix}/user_profile`; // uploads/user_profile/<userId>.jpg
const AVATAR_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** user_profile/<userId>.<jpg|png|webp> — one object per user */
export const avatarKeyFor = (userId, contentType = 'image/jpeg') =>
  `${AVATAR_PREFIX}/${userId}.${AVATAR_EXT[contentType] || 'jpg'}`;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const AVATAR_MAX = 5 * 1048576;

export async function presignAvatarUpload(userId, { contentType, size }) {
  if (!s3Ready()) {
    const e = new Error('File storage is not configured');
    e.status = 503;
    throw e;
  }
  if (!AVATAR_TYPES.includes(contentType)) {
    const e = new Error('Profile picture must be a JPG, PNG or WebP image');
    e.status = 415;
    throw e;
  }
  if (!(size > 0) || size > AVATAR_MAX) {
    const e = new Error('Profile picture must be under 5 MB');
    e.status = 413;
    throw e;
  }
  const key = avatarKeyFor(userId, contentType);
  const cmd = new PutObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: size,
    CacheControl: 'private, max-age=3600',
  });
  return {
    key,
    uploadUrl: await getSignedUrl(s3(), cmd, { expiresIn: 300 }),
    headers: { 'Content-Type': contentType },
  };
}
/** confirms the browser really uploaded the object (and that it is an image of sane size) */
export async function verifyAvatarObject(key) {
  try {
    const h = await s3().send(new HeadObjectCommand({ Bucket: config.aws.bucket, Key: key }));
    return {
      ok:
        AVATAR_TYPES.includes(h.ContentType) &&
        h.ContentLength > 0 &&
        h.ContentLength <= AVATAR_MAX,
    };
  } catch (err) {
    return { ok: false, status: err.$metadata?.httpStatusCode, name: err.name };
  }
}
export async function deleteAvatarObject(key) {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: config.aws.bucket, Key: key }));
    return true;
  } catch (err) {
    console.warn('[s3] could not delete', key, err.name);
    return false;
  }
}
export async function avatarUrl(key) {
  return signedGetUrl(key);
}

/** best-effort delete of many objects; returns how many were removed */
export async function deleteObjects(keys) {
  if (!s3Ready()) return 0;
  let n = 0;
  for (const key of [...new Set(keys)]) {
    if (await deleteAvatarObject(key)) n++;
  }
  return n;
}
