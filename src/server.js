import http from 'node:http';
import dns from 'node:dns';
import { config } from './config.js';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { initRealtime } from './realtime.js';
import { approveLegacyUsers, splitConversations, dropLegacyMessageIndexes } from './migrations.js';
import { bootstrapAdmin } from './routes/admin.js';
// Some networks/routers refuse the SRV lookup mongodb+srv:// needs; DNS_SERVERS=8.8.8.8,1.1.1.1 bypasses them.
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()));
try {
  await connectDb(config.mongoUri);
} catch (e) {
  const hint = /bad auth|authentication/i.test(e.message)
    ? 'Wrong MongoDB username/password. Set MONGODB_PASSWORD in backend/.env.'
    : /ENOTFOUND|ECONNREFUSED|timed out|selection/i.test(e.message)
      ? 'Cannot reach MongoDB. For Atlas, allow this server IP under Network Access and check the URI.'
      : /port number|Invalid|URI/i.test(e.message)
        ? 'MONGODB_URI is malformed (URL-encode special characters or use MONGODB_PASSWORD).'
        : e.message;
  console.error('\n✖ MongoDB connection failed: ' + hint + '\n');
  process.exit(1);
}
await splitConversations(); // chats -> groups / channels / direct_chats / saved_chats
await approveLegacyUsers(); // existing users keep access
await dropLegacyMessageIndexes(); // faster inserts
await bootstrapAdmin();
const server = http.createServer(createApp());
// keep idle keep-alive sockets longer than any load balancer / client pool does (default 5s causes ECONNRESET races)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
initRealtime(server);
server.listen(config.port, () => console.log(`${config.appName} API listening on :${config.port}`));
