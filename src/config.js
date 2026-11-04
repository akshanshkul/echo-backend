import 'dotenv/config';
const req = (k, d) => process.env[k] ?? d;
// MONGODB_PASSWORD (raw, any characters) replaces <db_password> in MONGODB_URI and is URL-encoded automatically.
function buildMongoUri() {
  const uri = req('MONGODB_URI', 'mongodb://127.0.0.1:27017/loom');
  const pw = process.env.MONGODB_PASSWORD;
  return pw ? uri.replace('<db_password>', encodeURIComponent(pw)) : uri;
}
export const config = {
  messageRatePerSec: +req('MESSAGE_RATE_PER_SEC', 20), // per user; 0 = unlimited
  appName: req('APP_NAME', 'Echo'),
  port: +req('PORT', 4000),
  mongoUri: buildMongoUri(),
  jwtSecret: req('JWT_SECRET', 'dev-only-change-me'),
  clientOrigin: req('CLIENT_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim()),
  aws: {
    region: req('AWS_REGION', ''),
    bucket: req('AWS_S3_BUCKET', ''),
    prefix: req('AWS_S3_PREFIX', 'uploads'),
  },
  clientUrl: (req('CLIENT_URL', '') || req('CLIENT_ORIGIN', 'http://localhost:5173').split(',')[0])
    .trim()
    .replace(/\/$/, ''),
  mail: {
    token: req('ZEPTOMAIL_TOKEN', ''),
    host: req('ZEPTOMAIL_HOST', 'api.zeptomail.com'),
    fromAddress: req('MAIL_FROM_ADDRESS', ''),
    fromName: req('MAIL_FROM_NAME', '') || req('APP_NAME', 'Echo'),
  },
  adminJwtSecret: req('ADMIN_JWT_SECRET', '') || req('JWT_SECRET', 'dev-only-change-me') + ':admin',
  adminBootstrap: {
    email: req('ADMIN_EMAIL', ''),
    password: req('ADMIN_PASSWORD', ''),
    name: req('ADMIN_NAME', 'Administrator'),
  },
  // which proxies to trust for X-Forwarded-For (needed so rate limits see the real client IP). Default: local/private-network proxies.
  trustProxy: req('TRUST_PROXY', 'loopback, linklocal, uniquelocal'),
  // how long after sending a user may delete their OWN message for everyone (minutes; 0 = no limit). "Delete for me" has no limit.
  messageDeleteWindowMinutes: Math.max(+req('MESSAGE_DELETE_WINDOW_MINUTES', 30) || 0, 0),
  maxUploadMB: +req('MAX_UPLOAD_MB', 100),
  isProd: req('NODE_ENV', 'development') === 'production',
};
if (config.isProd && config.jwtSecret === 'dev-only-change-me')
  throw new Error('Set JWT_SECRET in production');
