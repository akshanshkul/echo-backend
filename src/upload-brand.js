// Uploads the email logo to S3 (uploads/brand/). Usage: npm run upload-logo [path-to-png]
import fs from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
const file =
  process.argv[2] || new URL('../../frontend/public/logo/logo-96.png', import.meta.url).pathname;
const key = `${config.aws.prefix}/brand/${config.appName.toLowerCase()}-logo.png`;
const s3 = new S3Client({ region: config.aws.region });
await s3.send(
  new PutObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
    Body: fs.readFileSync(file),
    ContentType: 'image/png',
    CacheControl: 'public, max-age=31536000',
  }),
);
const url = `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
const r = await fetch(url, { method: 'HEAD' });
console.log('Uploaded:', key);
console.log(
  'Public URL:',
  url,
  '->',
  r.ok
    ? 'publicly readable ✔'
    : `HTTP ${r.status} (not public yet — see README: public read for ${config.aws.prefix}/brand/*)`,
);
