// Load test for the message-send path.  Usage: npm run bench -- [concurrency=128] [seconds=10] [users=60] [groups=20]
// Starts a throwaway in-memory MongoDB, runs the REAL server in a separate process, seeds users/groups straight into
// the DB, then hammers POST /conversations/:id/messages from this process while live sockets count deliveries.
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io } from 'socket.io-client';

const [CONC = 128, SECS = 10, NUSERS = 60, NGROUPS = 20] = process.argv.slice(2).map(Number);
const PORT = 4200;
process.env.ZEPTOMAIL_TOKEN = '';
const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri('bench');
process.env.MONGODB_URI = uri;
const env = {
  ...process.env,
  PORT: String(PORT),
  MESSAGE_RATE_PER_SEC: '0',
  NODE_ENV: 'development',
};
const server = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => /listening/.test(String(d)) && res());
  server.on('exit', (c) => rej(new Error('server exited ' + c)));
  setTimeout(() => rej(new Error('server start timeout')), 30000);
});

const { connectDb } = await import('../src/db.js');
const { User } = await import('../src/models/User.js');
const { Group } = await import('../src/models/Conversation.js');
const { signToken } = await import('../src/middleware/auth.js');
await connectDb(uri);
const users = await User.insertMany(
  Array.from({ length: NUSERS }, (_, i) => ({
    name: `Bench User ${i}`,
    username: `bench_${i}`,
    email: `b${i}@x.test`,
    emailKey: `b${i}@x.test`,
    passwordHash: 'x',
    emailVerified: true,
    approved: true,
    phone: `+1555000${String(i).padStart(4, '0')}`,
  })),
);
const groups = [];
for (let g = 0; g < NGROUPS; g++) {
  const members = users
    .filter((_, i) => i % NGROUPS === g || i % 3 === g % 3)
    .map((u, k) => ({ user: u._id, role: k === 0 ? 'owner' : 'member' }));
  groups.push(
    await Group.create({
      type: 'group',
      name: `Bench ${g}`,
      members,
      createdBy: members[0].user,
      privacy: 'private',
    }),
  );
}
const tokens = Object.fromEntries(users.map((u) => [String(u._id), signToken(String(u._id))]));
const plan = []; // (user, group) pairs the user can post in
for (const g of groups) for (const m of g.members) plan.push([String(m.user), String(g._id)]);

// live receivers: a few sockets joined to their rooms
let delivered = 0;
const rx = users.slice(0, 20).map((u) =>
  io(`http://localhost:${PORT}`, {
    auth: { token: tokens[String(u._id)] },
    transports: ['websocket'],
  }),
);
await Promise.all(rx.map((s) => new Promise((r) => s.on('connect', r))));
rx.forEach((s) => s.on('message:new', () => delivered++));
await new Promise((r) => setTimeout(r, 1500));

let okInWindow = 0,
  ok = 0,
  fail = 0,
  stop = false;
const lat = [];
const codes = {};
const errs = {};
const post = async (tok, gid, i) => {
  const t = performance.now();
  try {
    const r = await fetch(`http://localhost:${PORT}/api/conversations/${gid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
      body: JSON.stringify({ text: 'bench message ' + i }),
      signal: AbortSignal.timeout(10000),
    });
    await r.arrayBuffer();
    codes[r.status] = (codes[r.status] || 0) + 1;
    if (r.status === 201) {
      ok++;
      if (!stop) okInWindow++; // only count what finished inside the measured window
    } else fail++;
  } catch (e) {
    fail++;
    const k = e.cause?.code || e.name;
    errs[k] = (errs[k] || 0) + 1;
  }
  lat.push(performance.now() - t);
};
const t0 = Date.now();
setTimeout(() => (stop = true), SECS * 1000);
await Promise.all(
  Array.from({ length: CONC }, async (_, w) => {
    let i = w;
    while (!stop) {
      const [u, g] = plan[(i += CONC) % plan.length];
      await post(tokens[u], g, i);
    }
  }),
);
const secs = (Date.now() - t0) / 1000;
await new Promise((r) => setTimeout(r, 2500));
lat.sort((a, b) => a - b);
const p = (q) => Math.round(lat[Math.floor(lat.length * q)] || 0);
const { Message } = await import('../src/models/Message.js');
const stored = await Message.countDocuments();
console.log(
  JSON.stringify({
    users: NUSERS,
    groups: NGROUPS,
    concurrency: CONC,
    seconds: +secs.toFixed(1),
    msgs_per_sec: Math.round(okInWindow / SECS),
    ok,
    failed: fail,
    error_reasons: errs,
    status_codes: codes,
    p50_ms: p(0.5),
    p95_ms: p(0.95),
    p99_ms: p(0.99),
    max_ms: p(1),
    stored_in_db: stored,
    live_events_received: delivered,
  }),
);
rx.forEach((s) => s.close());
server.kill();
await mongo.stop();
process.exit(0);
