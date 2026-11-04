import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Abuse protection that doesn't punish normal use:
 *  - only FAILED attempts count for login / verification / reset (successful ones are free)
 *  - login is limited per (IP + account), so one person's typos never lock out other people
 *  - email-sending endpoints are limited per IP *and* per address, to stop mail bombing
 *  - a clear message says how long to wait
 * RATE_LIMIT_MULTIPLIER (env) scales every limit, e.g. 100 in tests.
 */
const M = Math.max(+process.env.RATE_LIMIT_MULTIPLIER || 1, 1);
const MIN = 60 * 1000;

const wait = (res) => {
  const s = Math.max(Math.ceil((res.getHeader('Retry-After') ?? 60) * 1), 1);
  return s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
};
const make = ({ windowMs, limit, what, key, failedOnly = false }) =>
  rateLimit({
    windowMs,
    limit: limit * M,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: failedOnly, // responses < 400 are not counted
    keyGenerator: (req) => (key ? key(req) : ipKeyGenerator(req.ip)),
    handler: (req, res) =>
      res.status(429).json({
        error: `Too many ${what}. Please try again in ${wait(res)}.`,
        code: 'RATE_LIMITED',
      }),
  });

const ip = (req) => ipKeyGenerator(req.ip);
const norm = (v) =>
  String(v || '')
    .trim()
    .toLowerCase()
    .slice(0, 120);

/** sign-in: 10 failures / 15 min per IP+account, plus a broad per-IP cap against account scanning */
export const loginPerAccount = make({
  windowMs: 15 * MIN,
  limit: 10,
  what: 'failed sign-in attempts for this account',
  failedOnly: true,
  key: (req) => `${ip(req)}|${norm(req.body?.login ?? req.body?.email)}`,
});
export const loginPerIp = make({
  windowMs: 15 * MIN,
  limit: 60,
  what: 'failed sign-in attempts',
  failedOnly: true,
});
export const register = make({ windowMs: 60 * MIN, limit: 20, what: 'sign-up attempts' });
export const tokenCheck = make({
  windowMs: 15 * MIN,
  limit: 30,
  what: 'invalid link attempts',
  failedOnly: true,
});
/** verification / reset emails: 20 per IP and 5 per address, each per 15 min */
export const mailPerIp = make({ windowMs: 15 * MIN, limit: 20, what: 'email requests' });
export const mailPerAddress = make({
  windowMs: 15 * MIN,
  limit: 5,
  what: 'email requests for this address',
  key: (req) => `mail|${norm(req.body?.email)}`,
});
export const adminLogin = make({
  windowMs: 15 * MIN,
  limit: 10,
  what: 'failed admin sign-in attempts',
  failedOnly: true,
  key: (req) => `${ip(req)}|${norm(req.body?.email)}`,
});
