// Development helper: runs the API against a throwaway in-memory MongoDB (no mongod install needed). Data is lost on exit.
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.ZEPTOMAIL_TOKEN = ''; // never send real email from tests / throwaway dev runs (links are printed instead)
const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('loom');
const { connectDb } = await import('./db.js');
const { config } = await import('./config.js');
await connectDb(config.mongoUri);
await import('./server.js');
process.on('SIGINT', async () => {
  await mongo.stop();
  process.exit(0);
});
