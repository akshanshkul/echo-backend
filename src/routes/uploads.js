import { Router } from 'express';
import { requireAuth, requireOnboarded, wrap } from '../middleware/auth.js';
import { presignUpload, s3Ready } from '../s3.js';
const r = Router();
r.use(requireAuth, requireOnboarded);
// 1) client asks for a short-lived presigned PUT URL  2) client PUTs the file straight to S3  3) client sends the returned key with the message
r.post(
  '/presign',
  wrap(async (req, res) => res.json(await presignUpload(req.user.id, req.body || {}))),
);
r.get('/status', (req, res) => res.json({ configured: s3Ready() }));
export default r;
