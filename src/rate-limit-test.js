// Verifies the rate limiters behave: failures are limited per account, successes are free, messages are clear.
import express from 'express';
import http from 'node:http';
const { loginPerAccount, loginPerIp, register, mailPerAddress } = await import('./rateLimits.js');
const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json());
app.post('/login', loginPerIp, loginPerAccount, (req, res) =>
  req.body.password === 'right'
    ? res.json({ ok: true })
    : res.status(401).json({ error: 'Invalid credentials' }),
);
app.post('/register', register, (req, res) => res.status(201).json({ ok: true }));
app.post('/mail', mailPerAddress, (req, res) => res.json({ ok: true }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
let fails = 0;
const ok = (c, n) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n);
  if (!c) fails++;
};

for (let i = 0; i < 30; i++) await call('/login', { login: 'alice', password: 'right' });
ok(
  (await call('/login', { login: 'alice', password: 'right' })).status === 200,
  '30 successful sign-ins in a row are never limited',
);
for (let i = 0; i < 10; i++) await call('/login', { login: 'bob', password: 'wrong' });
const blocked = await call('/login', { login: 'bob', password: 'wrong' });
ok(
  blocked.status === 429 && blocked.code === 'RATE_LIMITED',
  'bob is limited after 10 failed attempts',
);
ok(/minutes/.test(blocked.error) && /account/.test(blocked.error), 'message says how long to wait');
ok(
  (await call('/login', { login: 'bob', password: 'right' })).status === 429,
  'limit applies to that account even with the right password',
);
ok(
  (await call('/login', { login: 'carol', password: 'right' })).status === 200,
  'other accounts from the same IP are not locked out',
);
ok(
  (await call('/login', { login: 'dave', password: 'wrong' }, { 'x-forwarded-for': '203.0.113.9' }))
    .status === 401,
  'proxy-forwarded client IPs are tracked separately',
);
for (let i = 0; i < 20; i++) await call('/register', { n: i });
ok((await call('/register', {})).status === 429, 'sign-ups are capped per IP (20/hour)');
for (let i = 0; i < 5; i++) await call('/mail', { email: 'x@y.com' });
ok(
  (await call('/mail', { email: 'x@y.com' })).status === 429,
  'email requests capped per address (5/15 min)',
);
ok(
  (await call('/mail', { email: 'other@y.com' })).status === 200,
  'other addresses are unaffected',
);
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
