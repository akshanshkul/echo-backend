import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import auth from './routes/auth.js';
import users from './routes/users.js';
import conversations from './routes/conversations.js';
import messages from './routes/messages.js';
import uploads from './routes/uploads.js';
import admin from './routes/admin.js';
export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_q, r) => r.json({ ok: true }));
  app.use('/api/auth', auth);
  app.use('/api/users', users);
  app.use('/api/conversations', conversations);
  app.use('/api/uploads', uploads);
  app.use('/api/admin', admin);
  app.use('/api', messages);
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.name === 'CastError') err.status = 404;
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'Internal server error',
      ...(typeof err.code === 'string' && err.status ? { code: err.code } : {}),
    });
  });
  return app;
}
