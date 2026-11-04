// End-to-end smoke test against an in-memory MongoDB. No real AWS calls are made (presigning is local).
process.env.RATE_LIMIT_MULTIPLIER = '100';
process.env.ZEPTOMAIL_TOKEN = ''; // never send real email from tests / throwaway dev runs (links are printed instead)
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_S3_BUCKET = 'test-bucket';
process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
process.env.AWS_SECRET_ACCESS_KEY = 'secret';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioc } from 'socket.io-client';
const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('loom');
const { config } = await import('./config.js');
const { connectDb } = await import('./db.js');
const { createApp } = await import('./app.js');
const { initRealtime } = await import('./realtime.js');
await connectDb(config.mongoUri);
const server = http.createServer(createApp());
initRealtime(server);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
let fails = 0;
const ok = (c, n) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n);
  if (!c) fails++;
};
const api = async (method, path, token, body) => {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: 'Bearer ' + token }),
    },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const { outbox } = await import('./mailer.js');
const { User } = await import('./models/User.js');
// new users need admin approval; tests act as the admin
const approve = (username) =>
  User.updateOne({ username }, { approved: true, approvedAt: new Date() });
const signup = async (name, username, email, phone) => {
  const r = await api('POST', '/auth/register', null, {
    name,
    username,
    email,
    password: 'password123',
  });
  const link = outbox.at(-1)?.text.match(/token=([a-f0-9]{64})/);
  return { r, token: link?.[1], phone };
};
// --- registration + email verification + phone onboarding ---
const sa = await signup('Alice A', 'alice', 'a@x.com');
ok(
  sa.r.status === 201 && sa.r.needsVerification && !sa.r.token,
  'register -> needs verification, no session issued',
);
ok(
  !!sa.token && outbox.at(-1).to === 'a@x.com',
  'verification email "sent" with 64-char token link',
);
ok(
  (await api('POST', '/auth/login', null, { login: 'alice', password: 'password123' })).status ===
    403,
  'login blocked until email verified',
);
const unv = await api('POST', '/auth/register', null, {
  name: 'x',
  username: 'alice2',
  email: 'A@X.com',
  password: 'password123',
});
ok(
  unv.status === 409 && unv.code === 'EMAIL_UNVERIFIED',
  'same email (different case) rejected while unverified',
);
ok(
  (await api('POST', '/auth/verify-email', null, { token: 'f'.repeat(64) })).status === 400,
  'bad verification token rejected',
);
const va = await api('POST', '/auth/verify-email', null, { token: sa.token });
ok(
  !!va.token && va.user.emailVerified && !va.user.phoneSet,
  'verify link logs user in; phone not set yet',
);
ok(
  (await api('POST', '/auth/verify-email', null, { token: sa.token })).status === 400,
  'verification link is single-use',
);
ok(
  (await api('GET', '/conversations', va.token)).code === 'PHONE_REQUIRED',
  'app API locked until mobile number is added',
);
ok(
  (await api('PUT', '/users/me/phone', va.token, { phone: '12345' })).status === 400,
  'invalid phone rejected',
);
ok(
  (await api('GET', '/conversations', va.token)).code === 'PHONE_REQUIRED',
  'phone required before approval check',
);
await approve('alice');
const pa = await api('PUT', '/users/me/phone', va.token, { phone: '+1 (415) 555-0101' });
ok(
  pa.user?.phone === '+14155550101' && pa.user.phoneSet && pa.user.approved && pa.user.onboarded,
  'phone saved in E.164, onboarding complete',
);
const sb = await signup('Bob B', 'bob', 'b+tag@x.com');
const vb = await api('POST', '/auth/verify-email', null, { token: sb.token });
await approve('bob');
ok(
  (await api('PUT', '/users/me/phone', vb.token, { phone: '+14155550101' })).code === 'PHONE_TAKEN',
  'one account per mobile number',
);
ok(
  (await api('PUT', '/users/me/phone', vb.token, { phone: '+14155550102' })).status === 200,
  'second user phone ok',
);
ok(
  (
    await api('POST', '/auth/register', null, {
      name: 'Bob2',
      username: 'bob2',
      email: 'b@x.com',
      password: 'password123',
    })
  ).code === 'EMAIL_TAKEN',
  'one account per email (+tag alias blocked)',
);
const sg = await signup('G One', 'gone', 'g.one@gmail.com');
ok(sg.r.status === 201, 'gmail registers');
ok(
  (
    await api('POST', '/auth/register', null, {
      name: 'G Two',
      username: 'gtwo',
      email: 'gone@gmail.com',
      password: 'password123',
    })
  ).code === 'EMAIL_UNVERIFIED',
  'gmail dot-alias treated as the same mailbox',
);
ok(
  (
    await api('POST', '/auth/register', null, {
      name: 'x',
      username: 'alice',
      email: 'new@x.com',
      password: 'password123',
    })
  ).code === 'USERNAME_TAKEN',
  'duplicate username rejected',
);
const before = outbox.length;
await api('POST', '/auth/resend-verification', null, { email: 'g.one@gmail.com' });
ok(outbox.length === before, 'resend respects 60s cooldown');
ok(
  (await api('POST', '/auth/resend-verification', null, { email: 'nobody@x.com' })).ok === true,
  'resend does not reveal unknown emails',
);
// --- admin approval gate (a brand-new user goes through the real admin flow) ---
const sc = await signup('Carol C', 'carol', 'carol@x.com');
const vc = await api('POST', '/auth/verify-email', null, { token: sc.token });
await api('PUT', '/users/me/phone', vc.token, { phone: '+14155550303' });
ok(
  (await api('GET', '/conversations', vc.token)).code === 'APPROVAL_REQUIRED',
  'new user is blocked from the app until approved',
);
ok(
  (await api('GET', '/auth/me', vc.token)).user.approved === false,
  '/auth/me reports approved:false',
);
const { Admin } = await import('./models/Admin.js');
const bcrypt = (await import('bcryptjs')).default;
await Admin.create({
  name: 'Root Admin',
  email: 'root@x.com',
  passwordHash: await bcrypt.hash('adminpass123', 10),
});
ok(
  (await api('POST', '/admin/login', null, { email: 'root@x.com', password: 'wrong' })).status ===
    401,
  'admin: bad password rejected',
);
ok(
  (await api('GET', '/admin/users', vc.token)).status === 401,
  'admin API rejects normal user tokens',
);
const adm = await api('POST', '/admin/login', null, {
  email: 'root@x.com',
  password: 'adminpass123',
});
ok(!!adm.token, 'admin login');
ok(
  (await api('GET', '/conversations', adm.token)).status === 401,
  'admin token is not valid for the user API',
);
const stats0 = await api('GET', '/admin/stats', adm.token);
ok(
  stats0.pending === 1 && stats0.unverified === 1 && stats0.approved >= 2,
  'admin stats count pending / unverified / approved',
);
const pend = await api('GET', '/admin/users?status=pending', adm.token);
ok(pend.users.length === 1 && pend.users[0].username === 'carol', 'admin lists pending users');
ok(
  (await api('GET', '/admin/users?q=%2B14155550303', adm.token)).users[0]?.username === 'carol',
  'admin search by phone',
);
const det = await api('GET', `/admin/users/${vc.user.id}`, adm.token);
ok(
  det.user.email === 'carol@x.com' && det.user.phone === '+14155550303' && det.user.stats,
  'admin user detail (email, phone, stats)',
);
const gone = (await api('GET', '/admin/users?q=gone', adm.token)).users[0];
ok(
  (await api('POST', `/admin/users/${gone.id}/approve`, adm.token)).status === 400,
  'cannot approve an unverified user',
);
const ap = await api('POST', `/admin/users/${vc.user.id}/approve`, adm.token);
ok(
  ap.user?.approved === true && ap.user.approvedBy.includes('root@x.com'),
  'admin approves user (recorded who)',
);
ok((await api('GET', '/conversations', vc.token)).conversations, 'approved user can use the app');
ok(
  (await api('POST', `/admin/users/${vc.user.id}/unapprove`, adm.token)).user?.approved === false,
  'admin revokes approval',
);
ok(
  (await api('GET', '/conversations', vc.token)).code === 'APPROVAL_REQUIRED',
  'revoked user is blocked again immediately',
);
{
  const { approveLegacyUsers } = await import('./migrations.js');
  const { User } = await import('./models/User.js');
  await User.collection.insertOne({
    name: 'Legacy',
    username: 'legacy',
    email: 'l@x.com',
    emailKey: 'l@x.com',
    passwordHash: 'x',
    emailVerified: true,
    phone: '+14155550999',
  });
  ok(
    (await approveLegacyUsers()) === 1,
    'migration approves pre-existing users (no approved field)',
  );
  const lg = await User.findOne({ username: 'legacy' });
  ok(lg.approved === true, 'legacy user is now approved');
}
ok(
  (await api('GET', '/users?q=G One', va.token)).users.length === 0,
  'unverified users are not discoverable',
);
const a = { token: va.token, user: va.user };
const b = { token: vb.token, user: vb.user };
ok(
  (await api('POST', '/auth/login', null, { login: 'alice', password: 'nope' })).status === 401,
  'bad login 401',
);
ok(
  (await api('POST', '/auth/login', null, { login: 'alice', password: 'password123' })).token,
  'login by username after verification',
);
ok((await api('GET', '/conversations')).status === 401, 'unauthenticated 401');
const login = await api('POST', '/auth/login', null, { login: 'a@x.com', password: 'password123' });
ok(!!login.token, 'login by email');
const sock = ioc(base, { auth: { token: b.token } });
const events = [];
['message:new', 'message:update', 'typing', 'conversation:new'].forEach((e) =>
  sock.on(e, (p) => events.push([e, p])),
);
await new Promise((r) => sock.on('connect', r));
const dm = await api('POST', '/conversations', a.token, { type: 'dm', userId: b.user.id });
ok(dm.status === 201, 'create DM');
const again = await api('POST', '/conversations', a.token, { type: 'dm', userId: b.user.id });
ok(again.conversation.id === dm.conversation.id, 'DM is idempotent');
const cid = dm.conversation.id;
// --- message requests: a private profile must accept before anyone can message ---
ok(
  dm.conversation.dm.status === 'pending' && dm.conversation.dm.incoming === false,
  'new DM with a private profile starts as a pending request',
);
ok(
  (await api('POST', `/conversations/${cid}/messages`, a.token, { text: 'hi' })).code ===
    'REQUEST_PENDING',
  'requester cannot send before acceptance',
);
const bList = await api('GET', '/conversations', b.token);
const incoming = bList.conversations.find((c) => c.id === cid);
ok(incoming?.dm.incoming === true, 'recipient sees the incoming request');
ok(
  (await api('POST', `/conversations/${cid}/messages`, b.token, { text: 'hi' })).code ===
    'REQUEST_PENDING',
  'recipient cannot reply before accepting',
);
ok(
  (await api('POST', `/conversations/${cid}/accept`, a.token)).status === 400,
  'requester cannot accept their own request',
);
ok(
  (await api('POST', `/conversations/${cid}/accept`, b.token)).ok === true,
  'recipient accepts the request',
);
await new Promise((r) => setTimeout(r, 200));
ok(
  events.some(([e]) => e === 'conversation:new'),
  'realtime: conversation:new',
);
const m1 = await api('POST', `/conversations/${cid}/messages`, a.token, { text: 'hello **bob**' });
ok(m1.status === 201, 'send message');
await new Promise((r) => setTimeout(r, 200));
ok(
  events.some(([e, p]) => e === 'message:new' && p.text.includes('hello')),
  'realtime: message:new reaches Bob',
);
let list = await api('GET', '/conversations', b.token);
ok(list.conversations.find((c) => c.id === cid).unread === 1, 'unread count = 1');
await api('POST', `/conversations/${cid}/read`, b.token);
list = await api('GET', '/conversations', b.token);
ok(list.conversations.find((c) => c.id === cid).unread === 0, 'read resets unread');
ok(
  (await api('PATCH', `/messages/${m1.message.id}`, b.token, { text: 'hax' })).status === 403,
  'cannot edit others’ messages',
);
const ed = await api('PATCH', `/messages/${m1.message.id}`, a.token, { text: 'edited' });
ok(ed.message.edited && ed.message.text === 'edited', 'edit own message');
const rx = await api('POST', `/messages/${m1.message.id}/reactions`, b.token, { emoji: '👍' });
ok(rx.message.reactions[0].users.length === 1, 'react');
const rx2 = await api('POST', `/messages/${m1.message.id}/reactions`, b.token, { emoji: '👍' });
ok(rx2.message.reactions.length === 0, 'un-react');
ok((await api('POST', `/messages/${m1.message.id}/pin`, a.token)).message.pinned, 'pin');
ok((await api('POST', `/messages/${m1.message.id}/star`, a.token)).message.starred, 'star');
const rep = await api('POST', `/conversations/${cid}/messages`, b.token, {
  text: 'reply',
  replyTo: m1.message.id,
});
ok(rep.message.replyTo === m1.message.id, 'reply');
const th = await api('POST', `/conversations/${cid}/messages`, b.token, {
  text: 'in thread',
  threadOf: m1.message.id,
});
const main = await api('GET', `/conversations/${cid}/messages`, a.token);
ok(main.messages.length === 2, 'thread replies excluded from main list');
const thr = await api('GET', `/conversations/${cid}/messages?threadOf=${m1.message.id}`, a.token);
ok(thr.messages.length === 1, 'thread list');
const poll = await api('POST', `/conversations/${cid}/messages`, a.token, {
  type: 'poll',
  poll: { question: 'Lunch?', options: ['Ramen', 'Pizza'] },
});
const v = await api('POST', `/messages/${poll.message.id}/vote`, b.token, {
  option: poll.message.poll.options[0].id,
});
ok(v.message.poll.options[0].votes.length === 1, 'poll vote');
// --- profile picture ---
const av = await api('POST', '/users/me/avatar/presign', a.token, {
  contentType: 'image/jpeg',
  size: 5000,
});
ok(
  av.status === 200 &&
    av.key === `uploads/user_profile/${a.user.id}.jpg` &&
    av.uploadUrl.includes('X-Amz-Signature'),
  'avatar presign key is uploads/user_profile/<id>.jpg',
);
const av2 = await api('POST', '/users/me/avatar/presign', b.token, {
  contentType: 'image/jpeg',
  size: 5000,
});
ok(av2.key !== av.key && av2.key.includes(b.user.id), 'avatar keys are per-user');
ok(
  (await api('POST', '/users/me/avatar/presign', a.token, { contentType: 'image/gif', size: 5000 }))
    .status === 415,
  'avatar: gif rejected',
);
ok(
  (await api('POST', '/users/me/avatar/presign', a.token, { contentType: 'image/png', size: 9e6 }))
    .status === 413,
  'avatar: >5MB rejected',
);
ok(
  (await api('PUT', '/users/me/avatar', a.token)).status >= 400,
  'avatar confirm fails when nothing was uploaded',
);
ok(
  Object.keys(
    (await api('POST', '/users/avatar-urls', a.token, { ids: [a.user.id, b.user.id] })).urls,
  ).length === 0,
  'avatar-urls empty for users without photo',
);
ok((await api('POST', '/users/avatar-urls')).status === 401, 'avatar-urls requires auth');
const ps = await api('POST', '/uploads/presign', a.token, {
  filename: 'cat photo.png',
  contentType: 'image/png',
  size: 1000,
});
ok(
  ps.status === 200 &&
    ps.uploadUrl.includes('test-bucket') &&
    ps.uploadUrl.includes('X-Amz-Signature') &&
    ps.key.startsWith(`uploads/${a.user.id}/`),
  'S3 presigned upload URL',
);
ok(
  (
    await api('POST', '/uploads/presign', a.token, {
      filename: 'x.exe',
      contentType: 'application/x-msdownload',
      size: 10,
    })
  ).status === 415,
  'disallowed type rejected',
);
ok(
  (
    await api('POST', '/uploads/presign', a.token, {
      filename: 'big.mp4',
      contentType: 'video/mp4',
      size: 9e9,
    })
  ).status === 413,
  'oversize rejected',
);
const withAtt = await api('POST', `/conversations/${cid}/messages`, a.token, {
  text: '',
  attachments: [{ key: ps.key, name: 'cat.png', size: 1000, mime: 'image/png', kind: 'image' }],
});
ok(
  withAtt.message.type === 'media' &&
    withAtt.message.attachments[0].url.includes('X-Amz-Signature'),
  'message with S3 attachment gets signed GET url',
);
ok(
  (
    await api('POST', `/conversations/${cid}/messages`, a.token, {
      attachments: [{ key: `uploads/${b.user.id}/evil.png`, kind: 'image' }],
    })
  ).status === 400,
  'attachment key of another user rejected',
);
ok((await api('GET', '/search?q=edited', b.token)).results.length === 1, 'search');
const grp = await api('POST', '/conversations', a.token, {
  type: 'group',
  name: 'Team',
  memberIds: [b.user.id],
});
ok(grp.status === 201, 'create group');
const gm = await api('POST', `/conversations/${grp.conversation.id}/messages`, b.token, {
  text: 'hi team',
});
ok(gm.status === 201, 'member posts in group');
ok(
  (await api('DELETE', `/conversations/${grp.conversation.id}/members/${b.user.id}`, b.token))
    .status === 200,
  'member can leave',
);
ok(
  (await api('GET', `/conversations/${grp.conversation.id}`, b.token)).status === 404,
  'removed member loses access',
);
const del = await api('DELETE', `/messages/${m1.message.id}`, a.token);
const after = await api('GET', `/conversations/${cid}/messages`, a.token);
ok(
  del.ok && after.messages[0].deleted && after.messages[0].text === '',
  'delete (tombstone, content wiped)',
);
// --- forgot / reset password ---
const lastReset = () => outbox.filter((m) => /reset-password\?token=/.test(m.text)).at(-1);
let n0 = outbox.length;
ok(
  (await api('POST', '/auth/forgot-password', null, { email: 'nobody@x.com' })).ok === true &&
    outbox.length === n0,
  'forgot: unknown email gets same answer, no mail',
);
ok(
  (await api('POST', '/auth/forgot-password', null, { email: 'g.one@gmail.com' })).ok === true &&
    outbox.length === n0,
  'forgot: unverified account within the resend cooldown gets nothing extra',
);
{
  const { User } = await import('./models/User.js');
  await User.updateOne(
    { emailKey: 'gone@gmail.com' },
    { verifySentAt: new Date(Date.now() - 3 * 60000) },
  );
  await api('POST', '/auth/forgot-password', null, { email: 'g.one@gmail.com' });
  const m = outbox.at(-1);
  ok(
    outbox.length === n0 + 1 &&
      /verify-email\?token=/.test(m.text) &&
      !/reset-password/.test(m.text),
    'forgot: unverified account gets a verification link (not a reset link)',
  );
  n0 = outbox.length;
}
ok(
  (await api('POST', '/auth/forgot-password', null, { email: 'not-an-email' })).ok === true,
  'forgot: invalid email same answer',
);
ok(
  (await api('POST', '/auth/forgot-password', null, { email: 'A@X.com' })).ok === true &&
    outbox.length === n0 + 1,
  'forgot: reset email sent to verified user (case-insensitive)',
);
const resetMail = lastReset();
const resetToken = resetMail.text.match(/token=([a-f0-9]{64})/)[1];
ok(
  resetMail.to === 'a@x.com' &&
    /1 hour/.test(resetMail.text) &&
    resetMail.html.includes('Reset password'),
  'reset email content',
);
ok(
  (await api('POST', '/auth/forgot-password', null, { email: 'a@x.com' })).ok === true &&
    outbox.length === n0 + 1,
  'forgot: 60s cooldown between emails',
);
ok(
  (
    await api('POST', '/auth/reset-password', null, {
      token: 'f'.repeat(64),
      password: 'newpassword1',
    })
  ).code === 'INVALID_TOKEN',
  'reset: unknown token rejected',
);
ok(
  (await api('POST', '/auth/reset-password', null, { token: 'short', password: 'newpassword1' }))
    .status === 400,
  'reset: malformed token rejected',
);
ok(
  (await api('POST', '/auth/reset-password', null, { token: resetToken, password: '123' }))
    .status === 400,
  'reset: weak password rejected',
);
ok((await api('GET', '/conversations', a.token)).status === 200, 'session works before reset');
await new Promise((r) => setTimeout(r, 1100)); // JWT iat has 1s resolution
n0 = outbox.length;
ok(
  (
    await api('POST', '/auth/reset-password', null, {
      token: resetToken,
      password: 'brand-new-pass1',
    })
  ).ok === true,
  'reset: password changed',
);
ok(
  outbox.length === n0 + 1 && /password was just changed/.test(outbox.at(-1).text),
  'reset: "password changed" notice emailed',
);
ok(
  (
    await api('POST', '/auth/reset-password', null, {
      token: resetToken,
      password: 'another-pass-2',
    })
  ).code === 'INVALID_TOKEN',
  'reset: link is single-use',
);
ok(
  (await api('POST', '/auth/login', null, { login: 'alice', password: 'password123' })).status ===
    401,
  'reset: old password no longer works',
);
const relog = await api('POST', '/auth/login', null, {
  login: 'alice',
  password: 'brand-new-pass1',
});
ok(!!relog.token, 'reset: new password works');
ok(
  (await api('GET', '/conversations', a.token)).status === 401,
  'reset: old session token is revoked',
);
ok((await api('GET', '/conversations', relog.token)).status === 200, 'reset: new session works');
// expired link
await api('POST', '/auth/forgot-password', null, { email: 'b@x.com' }); // alias of bob (b+tag) -> same mailbox key
const bobMail = lastReset();
if (bobMail && bobMail.to === 'b+tag@x.com') {
  const t2 = bobMail.text.match(/token=([a-f0-9]{64})/)[1];
  await User.updateOne({ username: 'bob' }, { resetExpires: new Date(Date.now() - 1000) });
  ok(
    (await api('POST', '/auth/reset-password', null, { token: t2, password: 'whatever-pass1' }))
      .code === 'TOKEN_EXPIRED',
    'reset: expired link rejected',
  );
}
// --- admin: temporary disable and permanent delete (fresh users, independent of earlier steps) ---
const mkUser = async (name, username, email, phone) => {
  const s = await signup(name, username, email);
  const v = await api('POST', '/auth/verify-email', null, { token: s.token });
  await api('PUT', '/users/me/phone', v.token, { phone });
  await api('POST', `/admin/users/${v.user.id}/approve`, adm.token);
  return v;
};
const ve = await mkUser('Erin E', 'erin', 'erin@x.com', '+14155550505');
const vf = await mkUser('Frank F', 'frank', 'frank@x.com', '+14155550606');
const vd = await mkUser('Dave D', 'dave', 'dave@x.com', '+14155550404');
const ddm = await api('POST', '/conversations', ve.token, { type: 'dm', userId: vd.user.id });
await api('POST', `/conversations/${ddm.conversation.id}/accept`, vd.token);
await api('POST', `/conversations/${ddm.conversation.id}/messages`, vd.token, {
  text: 'hello from dave',
});
const dgrp = await api('POST', '/conversations', ve.token, {
  type: 'group',
  name: 'With Dave',
  memberIds: [vd.user.id, vf.user.id],
});
await api('POST', `/conversations/${dgrp.conversation.id}/messages`, vd.token, {
  text: 'dave in the group',
});
ok(
  (await api('GET', '/users?q=Dave', ve.token)).users.length === 1,
  'approved user is discoverable',
);
const dis = await api('POST', `/admin/users/${vd.user.id}/disable`, adm.token);
ok(
  dis.user?.disabled === true && dis.user.disabledBy.includes('root@x.com'),
  'admin disables user (recorded who)',
);
ok(
  (await api('GET', '/conversations', vd.token)).code === 'ACCOUNT_DISABLED',
  'disabled user is blocked from the app',
);
ok(
  (await api('GET', '/auth/me', vd.token)).user.disabled === true,
  '/auth/me reports disabled:true',
);
const dl = await api('POST', '/auth/login', null, { login: 'dave', password: 'password123' });
ok(dl.status === 403 && dl.code === 'ACCOUNT_DISABLED', 'disabled user cannot sign in');
ok(
  (await api('GET', '/users?q=Dave', ve.token)).users.length === 0,
  'disabled user is hidden from search',
);
ok(
  (await api('GET', '/admin/users?status=disabled', adm.token)).users.length === 1,
  'admin lists disabled users',
);
ok((await api('GET', '/admin/stats', adm.token)).disabled === 1, 'admin stats count disabled');
ok(
  (await api('POST', `/admin/users/${vd.user.id}/enable`, adm.token)).user?.disabled === false,
  'admin re-enables user',
);
ok(
  (await api('GET', '/conversations', vd.token)).conversations,
  'enabled user can use the app again',
);
ok(
  (await api('DELETE', `/admin/users/${vd.user.id}`, adm.token, { confirm: 'wrong' })).status ===
    400,
  'permanent delete requires the username as confirmation',
);
ok(
  (await api('DELETE', `/admin/users/${vd.user.id}`, ve.token, { confirm: 'dave' })).status === 401,
  'delete rejects non-admin tokens',
);
const del2 = await api('DELETE', `/admin/users/${vd.user.id}`, adm.token, { confirm: 'dave' });
ok(del2.ok === true && del2.summary.chats >= 2, 'admin permanently deletes user (+ their chats)');
ok((await api('GET', '/auth/me', vd.token)).status === 401, 'deleted user session is invalid');
ok(
  (await api('POST', '/auth/login', null, { login: 'dave', password: 'password123' })).status ===
    401,
  'deleted user cannot sign in',
);
const afterDel = await api('GET', '/conversations', ve.token);
ok(
  !afterDel.conversations.some((c) => c.id === ddm.conversation.id),
  'their DM is removed for the other person',
);
const g2 = afterDel.conversations.find((c) => c.id === dgrp.conversation.id);
ok(
  g2 && !g2.members.some((m) => m.user.id === vd.user.id),
  'they are removed from groups (group stays)',
);
const dgm = await api('GET', `/conversations/${dgrp.conversation.id}/messages`, ve.token);
ok(!dgm.messages.some((m) => m.text === 'dave in the group'), 'their group messages are deleted');
const reuse = await signup('Dave Again', 'dave', 'dave@x.com');
ok(reuse.r.status === 201, 'email and username can be registered again after deletion');
// --- privacy: public / approval / private, discover, join requests, invite links ---
const owner = relog; // alice (fresh session after the password reset test)
const makeVerifiedUser = async (name, username, email, phone) => {
  const r = await signup(name, username, email);
  const v = await api('POST', '/auth/verify-email', null, { token: r.token });
  await approve(username);
  await api('PUT', '/users/me/phone', v.token, { phone });
  return { token: v.token, id: v.user.id };
};
const carol = await makeVerifiedUser('Carol P', 'carolp', 'carolp@x.com', '+14155550177');
const pub = await api('POST', '/conversations', owner.token, {
  type: 'channel',
  name: 'Open News',
  privacy: 'public',
});
ok(
  pub.status === 201 &&
    pub.conversation.privacy === 'public' &&
    /^open_news/.test(pub.conversation.handle) &&
    !!pub.conversation.inviteCode,
  'public channel: handle derived from name + invite code',
);
const apr = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Design Crew',
  privacy: 'approval',
  handle: 'design_crew',
});
ok(
  apr.status === 201 &&
    apr.conversation.handle === 'design_crew' &&
    apr.conversation.members.length === 1,
  'approval group can start with no other members',
);
const prv = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Secret Club',
  privacy: 'private',
  memberIds: [b.user.id],
});
ok(
  prv.status === 201 && !prv.conversation.handle && !!prv.conversation.inviteCode,
  'private group: no handle, has invite code',
);
ok(
  (
    await api('POST', '/conversations', owner.token, {
      type: 'group',
      name: 'X',
      privacy: 'private',
    })
  ).status === 400,
  'private group needs a member',
);
ok(
  (
    await api('POST', '/conversations', owner.token, {
      type: 'channel',
      name: 'Dupe',
      privacy: 'public',
      handle: 'design_crew',
    })
  ).code === 'HANDLE_TAKEN',
  'handle must be unique',
);
ok(
  (
    await api('POST', '/conversations', owner.token, {
      type: 'channel',
      name: 'Bad',
      privacy: 'public',
      handle: 'a b',
    })
  ).code === 'BAD_HANDLE',
  'bad handle rejected',
);
ok(
  (
    await api('POST', '/conversations', owner.token, {
      type: 'channel',
      name: 'Bad',
      privacy: 'weird',
    })
  ).status === 400,
  'bad privacy rejected',
);

const disc = await api('GET', '/conversations/discover', carol.token);
const names = disc.results.map((x) => x.name);
ok(
  names.includes('Open News') && names.includes('Design Crew') && !names.includes('Secret Club'),
  'discover lists public + approval, hides private',
);
ok(
  (await api('GET', '/conversations/discover?q=design', carol.token)).results.length === 1,
  'discover search by name',
);
ok(
  (await api('GET', '/conversations/discover?q=@open_news', carol.token)).results.length === 1,
  'discover search by @handle',
);
ok(
  !(await api('GET', '/conversations/discover', owner.token)).results.some(
    (x) => x.name === 'Open News',
  ),
  'discover hides chats you are already in',
);

const jp = await api('POST', `/conversations/${pub.conversation.id}/join`, carol.token);
ok(
  jp.status === 'joined' &&
    (await api('GET', `/conversations/${pub.conversation.id}`, carol.token)).status === 200,
  'public: join instantly',
);
ok(
  (await api('POST', `/conversations/${pub.conversation.id}/messages`, carol.token, { text: 'hi' }))
    .status === 403,
  'channel subscriber cannot post',
);

const ja = await api('POST', `/conversations/${apr.conversation.id}/join`, carol.token);
ok(ja.status === 'requested', 'approval: join becomes a request');
ok(
  (await api('GET', `/conversations/${apr.conversation.id}`, carol.token)).status === 404,
  'approval: not a member until approved',
);
ok(
  (await api('POST', `/conversations/${apr.conversation.id}/join`, carol.token)).status ===
    'requested',
  'approval: duplicate request is idempotent',
);
ok(
  (await api('GET', '/conversations/discover', carol.token)).results.find(
    (x) => x.name === 'Design Crew',
  ).requested === true,
  'discover shows "requested"',
);
const own = await api('GET', `/conversations/${apr.conversation.id}`, owner.token);
ok(own.conversation.pendingRequests === 1, 'admin sees pendingRequests = 1');
const reqs = await api('GET', `/conversations/${apr.conversation.id}/requests`, owner.token);
ok(
  reqs.requests.length === 1 && reqs.requests[0].user.username === 'carolp',
  'admin lists join requests',
);
ok(
  (await api('GET', `/conversations/${apr.conversation.id}/requests`, carol.token)).status === 404,
  'non-member cannot list requests',
);
ok(
  (await api('POST', `/conversations/${apr.conversation.id}/requests/${carol.id}/approve`, b.token))
    .status === 404,
  'non-member cannot approve',
);
ok(
  (
    await api(
      'POST',
      `/conversations/${apr.conversation.id}/requests/${carol.id}/approve`,
      owner.token,
    )
  ).ok === true,
  'admin approves request',
);
ok(
  (await api('GET', `/conversations/${apr.conversation.id}`, carol.token)).status === 200,
  'approved user is now a member',
);
ok(
  (await api('GET', `/conversations/${apr.conversation.id}`, owner.token)).conversation
    .pendingRequests === 0,
  'request cleared after approval',
);

ok(
  (await api('POST', `/conversations/${prv.conversation.id}/join`, carol.token)).code === 'PRIVATE',
  'private: direct join refused',
);
const pv = await api('GET', `/conversations/invite/${prv.conversation.inviteCode}`, carol.token);
ok(
  pv.invite?.name === 'Secret Club' &&
    pv.invite.privacy === 'private' &&
    pv.invite.isMember === false,
  'invite link preview works for non-members',
);
ok(
  (await api('POST', `/conversations/invite/${prv.conversation.inviteCode}/join`, carol.token))
    .status === 'joined',
  'private: invite link joins instantly',
);
ok(
  (await api('GET', `/conversations/invite/bogus-code`, carol.token)).code === 'BAD_INVITE',
  'bad invite code rejected',
);
const oldCode = prv.conversation.inviteCode;
const rs = await api(
  'POST',
  `/conversations/${prv.conversation.id}/invite-link/reset`,
  owner.token,
);
ok(rs.inviteCode && rs.inviteCode !== oldCode, 'admin can reset invite link');
ok(
  (await api('GET', `/conversations/invite/${oldCode}`, owner.token)).code === 'BAD_INVITE',
  'old invite link stops working',
);
ok(
  (await api('POST', `/conversations/${prv.conversation.id}/invite-link/reset`, carol.token))
    .status === 403,
  'members cannot reset invite link',
);
const mview = await api('GET', `/conversations/${prv.conversation.id}`, carol.token);
ok(mview.conversation.inviteCode === undefined, 'private chat: members do not see the invite code');
const aview = await api('GET', `/conversations/${apr.conversation.id}`, carol.token);
ok(!!aview.conversation.inviteCode, 'approval chat: members can see the invite code to share');

// invite link into an approval chat still needs approval
const dave = await makeVerifiedUser('Dave P', 'davep', 'davep@x.com', '+14155550188');
const viaLink = await api(
  'POST',
  `/conversations/invite/${apr.conversation.inviteCode}/join`,
  dave.token,
);
ok(viaLink.status === 'requested', 'approval: invite link still creates a request');
ok(
  (await api('DELETE', `/conversations/${apr.conversation.id}/join-request`, dave.token)).ok ===
    true,
  'user can cancel own request',
);
ok(
  (await api('GET', `/conversations/${apr.conversation.id}/requests`, owner.token)).requests
    .length === 0,
  'cancelled request disappears',
);
await api('POST', `/conversations/${apr.conversation.id}/join`, dave.token);
ok(
  (await api('DELETE', `/conversations/${apr.conversation.id}/requests/${dave.id}`, owner.token))
    .ok === true,
  'admin declines request',
);
ok(
  (await api('GET', `/conversations/${apr.conversation.id}`, dave.token)).status === 404,
  'declined user stays out',
);

// changing privacy later
await api('POST', `/conversations/${apr.conversation.id}/join`, dave.token);
const toPublicProfile = await api('PATCH', `/conversations/${apr.conversation.id}`, owner.token, {
  privacy: 'public',
});
ok(toPublicProfile.conversation.privacy === 'public', 'admin can switch approval -> public');
ok(
  (await api('GET', `/conversations/${apr.conversation.id}`, dave.token)).status === 200,
  'switching to public admits waiting requests',
);
ok(
  (await api('PATCH', `/conversations/${apr.conversation.id}`, carol.token, { privacy: 'private' }))
    .status === 403,
  'members cannot change privacy',
);
const toPriv = await api('PATCH', `/conversations/${apr.conversation.id}`, owner.token, {
  privacy: 'private',
});
ok(
  toPriv.conversation.privacy === 'private' && !toPriv.conversation.handle,
  'switching to private removes the handle',
);
ok(
  !(
    await api(
      'GET',
      '/conversations/discover?q=design',
      (await makeVerifiedUser('Erin P', 'erinp', 'erinp@x.com', '+14155550199')).token,
    )
  ).results.length,
  'private chats vanish from discover',
);
// --- owner can delete groups / channels ---
const erinTok = (await makeVerifiedUser('Erin Q', 'erinq', 'erinq@x.com', '+14155550288')).token;
const delGrp = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Temp Crew',
  privacy: 'public',
});
await api('POST', `/conversations/${delGrp.conversation.id}/join`, carol.token);
await api('POST', `/conversations/${delGrp.conversation.id}/messages`, carol.token, {
  text: 'bye soon',
});
ok(
  (await api('DELETE', `/conversations/${delGrp.conversation.id}`, carol.token)).code ===
    'OWNER_ONLY',
  'members cannot delete a group',
);
ok(
  (await api('DELETE', `/conversations/${delGrp.conversation.id}`, b.token)).status === 404,
  'outsiders cannot delete a group',
);
ok(
  (await api('DELETE', `/conversations/${delGrp.conversation.id}`, owner.token)).ok === true,
  'owner deletes the group',
);
ok(
  (await api('GET', `/conversations/${delGrp.conversation.id}`, carol.token)).status === 404,
  'deleted group is gone for members',
);
ok(
  !(await api('GET', '/conversations/discover', erinTok)).results.some(
    (x) => x.name === 'Temp Crew',
  ),
  'deleted group leaves discover',
);
const { Message } = await import('./models/Message.js');
ok(
  (await Message.countDocuments({ conv: delGrp.conversation.id })) === 0,
  'deleted group messages are removed',
);
const dmDel = await api('POST', '/conversations', owner.token, { type: 'dm', userId: b.user.id });
ok(
  (await api('DELETE', `/conversations/${dmDel.conversation.id}`, owner.token)).status === 400,
  'DMs cannot be deleted this way',
);
// --- message requests: public profiles, notes, decline, cooldown, legacy chats ---
const vg = await mkUser('Gina G', 'gina', 'gina@x.com', '+14155550707');
const vh = await mkUser('Hank H', 'hank', 'hank@x.com', '+14155550808');
const vj = await mkUser('Jill J', 'jill', 'jill@x.com', '+14155550909');
ok(
  (await api('GET', '/auth/me', vg.token)).user.publicProfile === false,
  'profiles are private by default',
);
ok(
  (await api('PATCH', '/users/me', vh.token, { publicProfile: true })).user.publicProfile === true,
  'user can switch to a public profile',
);
ok(
  (await api('GET', '/users?q=Hank', vg.token)).users[0]?.publicProfile === true,
  'others can see that a profile is public',
);
const dmToPublic = await api('POST', '/conversations', vg.token, {
  type: 'dm',
  userId: vh.user.id,
});
ok(
  dmToPublic.conversation.dm.status === 'accepted',
  'public profile: chat starts without a request',
);
ok(
  (
    await api('POST', `/conversations/${dmToPublic.conversation.id}/messages`, vg.token, {
      text: 'hey hank',
    })
  ).status === 201,
  'public profile: can message immediately',
);
const req1 = await api('POST', '/conversations', vh.token, {
  type: 'dm',
  userId: vg.user.id,
  note: 'Hi Gina, we met at the meetup',
});
ok(req1.conversation.dm.status === 'accepted', 'existing accepted chat is reused');
const req2 = await api('POST', '/conversations', vh.token, {
  type: 'dm',
  userId: vj.user.id,
  note: 'Hello Jill, quick question',
});
ok(req2.conversation.dm.status === 'pending', 'request to a private profile is pending');
const jInc = (await api('GET', '/conversations', vj.token)).conversations.find(
  (c) => c.id === req2.conversation.id,
);
ok(
  jInc.dm.incoming && jInc.dm.note === 'Hello Jill, quick question',
  'recipient sees the intro note',
);
const dec = await api('POST', `/conversations/${req2.conversation.id}/decline`, vj.token);
ok(dec.ok === true, 'recipient declines');
ok(
  !(await api('GET', '/conversations', vj.token)).conversations.some(
    (c) => c.id === req2.conversation.id,
  ),
  'declined request disappears for the recipient',
);
const hDeclined = (await api('GET', '/conversations', vh.token)).conversations.find(
  (c) => c.id === req2.conversation.id,
);
ok(hDeclined?.dm.status === 'declined', 'sender sees that the request was not accepted');
ok(
  (await api('POST', `/conversations/${req2.conversation.id}/messages`, vh.token, { text: 'pls' }))
    .code === 'REQUEST_PENDING',
  'declined sender cannot message',
);
const again2 = await api('POST', '/conversations', vh.token, { type: 'dm', userId: vj.user.id });
ok(
  again2.status === 403 && again2.code === 'REQUEST_DECLINED',
  'cannot re-request during the cooldown',
);
await api('PATCH', '/users/me', vj.token, { publicProfile: true });
ok(
  (await api('POST', '/conversations', vh.token, { type: 'dm', userId: vj.user.id })).conversation
    ?.dm.status === 'accepted',
  'when the recipient goes public, a declined chat opens up',
);
// accepting converts the note into the first message
const vk = await mkUser('Kim K', 'kim', 'kim@x.com', '+14155551010');
const req3 = await api('POST', '/conversations', vj.token, {
  type: 'dm',
  userId: vk.user.id,
  note: 'Intro note from Jill',
});
await api('POST', `/conversations/${req3.conversation.id}/accept`, vk.token);
const first = await api('GET', `/conversations/${req3.conversation.id}/messages`, vk.token);
ok(
  first.messages[0]?.text === 'Intro note from Jill' && first.messages[0].sender === vj.user.id,
  'the intro note becomes the first message when accepted',
);
// decline + block
const vl = await mkUser('Liz L', 'liz', 'liz@x.com', '+14155551111');
const req4 = await api('POST', '/conversations', vk.token, { type: 'dm', userId: vl.user.id });
await api('POST', `/conversations/${req4.conversation.id}/decline`, vl.token, { block: true });
ok(
  (await api('POST', '/conversations', vk.token, { type: 'dm', userId: vl.user.id })).status ===
    403,
  'declining with block stops further requests',
);
// chats that existed before this feature (no dmStatus) keep working
const { Conversation } = await import('./models/Conversation.js');
const legacy = await Conversation.create({
  type: 'dm',
  dmKey: [vg.user.id, vl.user.id].sort().join(':'),
  members: [{ user: vg.user.id }, { user: vl.user.id }],
});
ok(
  (
    await api('POST', `/conversations/${legacy.id}/messages`, vg.token, {
      text: 'old chat still works',
    })
  ).status === 201,
  'pre-existing chats (no request status) are treated as accepted',
);
// --- starred messages list ---
const stMsg = await api('POST', `/conversations/${pub.conversation.id}/messages`, owner.token, {
  text: 'remember this one',
});
await api('POST', `/messages/${stMsg.message.id}/star`, owner.token);
const stList = await api('GET', '/starred', owner.token);
ok(
  stList.messages.some((x) => x.id === stMsg.message.id && x.starred === true),
  'starred list returns my starred messages',
);
ok(
  !(await api('GET', '/starred', carol.token)).messages.some((x) => x.id === stMsg.message.id),
  'starred list is private to each user',
);
await api('POST', `/messages/${stMsg.message.id}/star`, owner.token);
ok(
  !(await api('GET', '/starred', owner.token)).messages.some((x) => x.id === stMsg.message.id),
  'un-starred message leaves the list',
);
ok((await api('GET', '/starred')).status === 401, 'starred requires auth');
// --- chats are stored in separate collections (groups / channels / direct_chats / saved_chats) ---
{
  const mongooseLib = (await import('mongoose')).default;
  const { splitConversations } = await import('./migrations.js');
  const { Conversation, chatModels } = await import('./models/Conversation.js');
  const db = mongooseLib.connection.db;
  const legacy = db.collection('conversations');
  const uid = new mongooseLib.Types.ObjectId();
  const members = [
    {
      user: uid,
      role: 'owner',
      lastRead: new Date(0),
      muted: false,
      pinned: false,
      archived: false,
    },
  ];
  const gid = new mongooseLib.Types.ObjectId();
  const cidn = new mongooseLib.Types.ObjectId();
  const did = new mongooseLib.Types.ObjectId();
  await legacy.insertMany([
    {
      _id: gid,
      type: 'group',
      name: 'Old Group',
      desc: '',
      privacy: 'private',
      members,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: cidn,
      type: 'channel',
      name: 'Old Channel',
      privacy: 'public',
      handle: 'old_channel',
      members,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: did,
      type: 'dm',
      dmKey: 'a:b',
      privacy: 'private',
      desc: '',
      members,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const r = await splitConversations();
  ok(
    r.moved === 3 && r.group === 1 && r.channel === 1 && r.dm === 1,
    'migration moves old chats into per-kind collections',
  );
  ok(
    (await db.listCollections({ name: 'conversations' }).toArray()).length === 0,
    'old shared collection is removed once empty',
  );
  ok(
    (await db.collection('groups').countDocuments({ _id: gid })) === 1,
    'group is stored in the groups collection',
  );
  ok(
    (await db.collection('channels').countDocuments({ _id: cidn })) === 1,
    'channel is stored in the channels collection',
  );
  const dmRaw = await db.collection('direct_chats').findOne({ _id: did });
  ok(
    dmRaw && dmRaw.privacy === undefined && dmRaw.dmKey === 'a:b',
    'direct chat keeps only its own fields',
  );
  ok(
    (await Conversation.findById(gid.toString()))?.name === 'Old Group',
    'facade finds a migrated group by id',
  );
  ok(
    (await Conversation.findOne({ handle: 'old_channel' }))?.type === 'channel',
    'facade finds a channel by handle',
  );
  ok((await splitConversations()).moved === 0, 'migration is idempotent');
  const fresh = await api('POST', '/conversations', owner.token, {
    type: 'group',
    name: 'Collection Check',
    memberIds: [b.user.id],
  });
  ok(
    (await db
      .collection('groups')
      .countDocuments({ _id: new mongooseLib.Types.ObjectId(fresh.conversation.id) })) === 1,
    'new groups are written to the groups collection',
  );
  const ch = await api('POST', '/conversations', owner.token, {
    type: 'channel',
    name: 'Chan Check',
    privacy: 'public',
  });
  ok(
    (await db
      .collection('channels')
      .countDocuments({ _id: new mongooseLib.Types.ObjectId(ch.conversation.id) })) === 1,
    'new channels are written to the channels collection',
  );
  ok(
    (await db.collection('direct_chats').countDocuments()) >= 1 &&
      (await db.collection('saved_chats').countDocuments()) >= 1,
    'direct and saved chats have their own collections',
  );
  ok(Object.keys(chatModels).length === 4, 'four chat collections exist');
}
// --- deleting messages: time limit for "delete for everyone", "delete for me", bulk delete ---
{
  const { config: cfg } = await import('./config.js');
  const { Message: Msg } = await import('./models/Message.js');
  ok(
    cfg.messageDeleteWindowMinutes === 30,
    'default delete window is 30 minutes (MESSAGE_DELETE_WINDOW_MINUTES)',
  );
  ok(
    (await api('GET', '/config', vg.token)).messageDeleteWindowMinutes === 30,
    'GET /config exposes the window to the app',
  );
  const dd = await api('POST', '/conversations', vg.token, { type: 'dm', userId: vh.user.id });
  const send = async (token, text) =>
    (await api('POST', `/conversations/${dd.conversation.id}/messages`, token, { text })).message;
  const fresh1 = await send(vg.token, 'fresh one');
  const fresh2 = await send(vg.token, 'fresh two');
  const old1 = await send(vg.token, 'old one');
  const old2 = await send(vg.token, 'old two');
  const theirs = await send(vh.token, 'from hank');
  await Msg.updateMany(
    { _id: { $in: [old1.id, old2.id] } },
    { createdAt: new Date(Date.now() - 45 * 60000) },
    { overwriteImmutable: true },
  );

  const tooLate = await api('DELETE', `/messages/${old1.id}`, vg.token);
  ok(
    tooLate.status === 403 && tooLate.code === 'DELETE_WINDOW_EXPIRED',
    'delete for everyone is refused after the time window',
  );
  ok(
    /30 minutes/.test(tooLate.error) && /for yourself/.test(tooLate.error),
    'the refusal explains the limit and the alternative',
  );
  const mixed = await api('POST', '/messages/delete', vg.token, {
    scope: 'everyone',
    ids: [fresh1.id, old1.id],
  });
  ok(
    mixed.status === 403 && mixed.notAllowed?.includes(old1.id),
    'bulk delete for everyone is all-or-nothing and names the expired messages',
  );
  const still = await api('GET', `/conversations/${dd.conversation.id}/messages`, vh.token);
  ok(
    still.messages.find((m) => m.id === fresh1.id)?.deleted !== true,
    'nothing was deleted by the refused bulk request',
  );
  ok(
    (await api('POST', '/messages/delete', vg.token, { scope: 'everyone', ids: [theirs.id] }))
      .code === 'NOT_ALLOWED',
    "cannot delete someone else's message for everyone in a DM",
  );
  const okBulk = await api('POST', '/messages/delete', vg.token, {
    scope: 'everyone',
    ids: [fresh1.id, fresh2.id],
  });
  ok(okBulk.ok && okBulk.ids.length === 2, 'bulk delete for everyone works inside the window');
  const afterE = await api('GET', `/conversations/${dd.conversation.id}/messages`, vh.token);
  ok(
    afterE.messages.find((m) => m.id === fresh1.id)?.deleted === true,
    'the other person sees them as deleted',
  );

  const me = await api('POST', '/messages/delete', vg.token, {
    scope: 'me',
    ids: [old1.id, old2.id, theirs.id],
  });
  ok(
    me.ok && me.ids.length === 3,
    'delete for me works on old messages and on messages from others',
  );
  const mineList = await api('GET', `/conversations/${dd.conversation.id}/messages`, vg.token);
  ok(
    !mineList.messages.some((m) => [old1.id, old2.id, theirs.id].includes(m.id)),
    'hidden messages are gone from my history',
  );
  const theirList = await api('GET', `/conversations/${dd.conversation.id}/messages`, vh.token);
  ok(
    [old1.id, old2.id, theirs.id].every((id) =>
      theirList.messages.some((m) => m.id === id && !m.deleted),
    ),
    'but the other person still sees them',
  );
  ok(
    (await api('POST', '/messages/delete', vg.token, { scope: 'x', ids: [old1.id] })).status ===
      400,
    'invalid scope rejected',
  );
  ok(
    (await api('POST', '/messages/delete', vk.token, { scope: 'me', ids: [old1.id] })).status ===
      404,
    'cannot touch messages from chats you are not in',
  );
  cfg.messageDeleteWindowMinutes = 0;
  ok(
    (
      await api(
        'DELETE',
        `/messages/${theirList.messages.find((m) => m.id === old2.id).id}`,
        vg.token,
      )
    ).ok === true,
    'a window of 0 means no time limit',
  );
  cfg.messageDeleteWindowMinutes = 30;
}
// --- send-path caches: every permission change must take effect IMMEDIATELY ---
const pc = await makeVerifiedUser('Perm Carol', 'permcarol', 'permcarol@x.com', '+14155550311');
const pd = await makeVerifiedUser('Perm Dave', 'permdave', 'permdave@x.com', '+14155550312');
const pg = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Perm Group',
  privacy: 'public',
});
await api('POST', `/conversations/${pg.conversation.id}/join`, pc.token);
await api('POST', `/conversations/${pg.conversation.id}/join`, pd.token);
const sendTo = (conv, tok, text = 'hello') =>
  api('POST', `/conversations/${conv}/messages`, tok, { text });
ok(
  (await sendTo(pg.conversation.id, pc.token)).status === 201,
  'cached send path: member can post',
);
ok(
  (await sendTo(pg.conversation.id, pc.token)).status === 201,
  'cached send path: second post (cache hit) still works',
);
await api('DELETE', `/conversations/${pg.conversation.id}/members/${pc.id}`, owner.token);
ok(
  (await sendTo(pg.conversation.id, pc.token)).status === 404,
  'removed member cannot post immediately (chat cache evicted)',
);
const permCh = await api('POST', '/conversations', owner.token, {
  type: 'channel',
  name: 'Perm Channel',
  privacy: 'public',
});
await api('POST', `/conversations/${permCh.conversation.id}/join`, pd.token);
await api('POST', `/conversations/${permCh.conversation.id}/members`, owner.token, { userIds: [] });
ok(
  (await sendTo(permCh.conversation.id, pd.token)).status === 403,
  'channel subscriber cannot post',
);
await api('PATCH', `/conversations/${permCh.conversation.id}/members/${pd.id}`, owner.token, {
  role: 'admin',
});
ok(
  (await sendTo(permCh.conversation.id, pd.token)).status === 201,
  'promoted to admin: can post immediately (role cache evicted)',
);
await api('PATCH', `/conversations/${permCh.conversation.id}/members/${pd.id}`, owner.token, {
  role: 'member',
});
ok(
  (await sendTo(permCh.conversation.id, pd.token)).status === 403,
  'demoted: cannot post immediately',
);
// blocking
const pdm = await api('POST', '/conversations', pc.token, { type: 'dm', userId: pd.id });
await api('PUT', '/users/me', pd.token, { publicProfile: true }).catch(() => {});
await User.updateOne({ username: 'permdave' }, { publicProfile: true });
const pdm2 = await api('POST', '/conversations', pc.token, { type: 'dm', userId: pd.id });
ok((await sendTo(pdm2.conversation.id, pc.token)).status === 201, 'dm send works (public profile)');
await api('POST', `/users/${pc.id}/block`, pd.token);
ok(
  (await sendTo(pdm2.conversation.id, pc.token)).status === 403,
  'blocked user cannot send immediately (user cache evicted)',
);
ok((await sendTo(pdm2.conversation.id, pd.token)).status === 403, 'blocker cannot send either');
await api('POST', `/users/${pc.id}/block`, pd.token);
ok((await sendTo(pdm2.conversation.id, pc.token)).status === 201, 'unblocked: can send again');
// admin actions on the sender
const pe = await makeVerifiedUser('Perm Erin', 'permerin', 'permerin@x.com', '+14155550313');
await api('POST', `/conversations/${pg.conversation.id}/join`, pe.token);
ok((await sendTo(pg.conversation.id, pe.token)).status === 201, 'sender works before admin action');
const peId = (await User.findOne({ username: 'permerin' }))._id;
await api('POST', `/admin/users/${peId}/disable`, adm.token);
ok(
  (await sendTo(pg.conversation.id, pe.token)).status === 403,
  'disabled account cannot send immediately',
);
await api('POST', `/admin/users/${peId}/enable`, adm.token);
await api('POST', `/admin/users/${peId}/unapprove`, adm.token);
ok(
  (await sendTo(pg.conversation.id, pe.token)).status === 403,
  'un-approved account cannot send immediately',
);
await api('POST', `/admin/users/${peId}/approve`, adm.token);
ok(
  (await sendTo(pg.conversation.id, pe.token)).status === 201,
  'approved again: sends immediately',
);
// deleted chat
const tmp = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Soon Gone',
  privacy: 'public',
});
await api('POST', `/conversations/${tmp.conversation.id}/join`, pe.token);
ok((await sendTo(tmp.conversation.id, pe.token)).status === 201, 'post before delete');
await api('DELETE', `/conversations/${tmp.conversation.id}`, owner.token);
ok(
  (await sendTo(tmp.conversation.id, pe.token)).status === 404,
  'cannot post to a deleted chat (cache evicted)',
);

// --- batched last-activity writes still keep ordering + unread correct ---
const act1 = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Activity A',
  privacy: 'public',
});
const act2 = await api('POST', '/conversations', owner.token, {
  type: 'group',
  name: 'Activity B',
  privacy: 'public',
});
await api('POST', `/conversations/${act1.conversation.id}/join`, pc.token);
await sendTo(act1.conversation.id, owner.token, 'older chat message');
await new Promise((r) => setTimeout(r, 30));
await sendTo(act2.conversation.id, owner.token, 'newer chat message');
await new Promise((r) => setTimeout(r, 700)); // write-behind flush window
const ol = (await api('GET', '/conversations', owner.token)).conversations;
const ia = ol.findIndex((x) => x.id === act1.conversation.id);
const ib = ol.findIndex((x) => x.id === act2.conversation.id);
ok(ib < ia, 'chat list order follows the latest message after the batched write');
ok(ol[ib].unread === 0 && ol[ia].unread === 0, "sender's own chats show 0 unread after sending");
ok(
  (await api('GET', '/conversations', pc.token)).conversations.find(
    (x) => x.id === act1.conversation.id,
  ).unread > 0,
  'other member sees unread messages after the batched write',
);

// --- per-user send rate limit ---
const burst = await Promise.all(
  Array.from({ length: 90 }, (_, i) => sendTo(pg.conversation.id, pd.token, 'burst ' + i)),
);
const n201 = burst.filter((x) => x.status === 201).length;
const n429 = burst.filter((x) => x.status === 429).length;
ok(
  n429 > 0 && n201 > 0 && burst.some((x) => x.code === 'RATE_LIMITED'),
  `rate limit: burst of 90 → ${n201} sent, ${n429} throttled (RATE_LIMITED)`,
);
await new Promise((r) => setTimeout(r, 2200));
ok(
  (await sendTo(pg.conversation.id, pd.token)).status === 201,
  'rate limit recovers after a pause',
);
sock.close();
server.close();
await mongo.stop();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
