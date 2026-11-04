import { config } from './config.js';
/** per-user token bucket for sending messages: `rate` per second sustained, burst = 2x. rate 0 disables it. */
const buckets = new Map();
export function allowMessage(userId) {
  const rate = config.messageRatePerSec;
  if (!rate) return true;
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b) buckets.set(userId, (b = { tokens: rate * 2, t: now }));
  b.tokens = Math.min(rate * 2, b.tokens + ((now - b.t) / 1000) * rate);
  b.t = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const old = Date.now() - 60_000;
  for (const [k, b] of buckets) if (b.t < old) buckets.delete(k);
}, 60_000).unref();
