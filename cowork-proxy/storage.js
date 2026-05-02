// cowork-proxy/storage.js
// =====================================================================
// Storage abstraction · Cloudflare R2 in cloud, local disk in dev.
//
// Why this exists:
//   Railway's container filesystem is volatile — every redeploy wipes
//   anything written there. Avatar uploads, Afshin renders, and KB
//   uploads must live in object storage instead. R2 is S3-compatible
//   and free up to 10 GB / 10M reads / 1M writes monthly, with zero
//   egress fees — the cheapest sane option for this stage.
//
// Backend selection:
//   - If R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_ACCOUNT_ID +
//     R2_BUCKET are all set → use R2.
//   - Otherwise → write to disk under `cowork-proxy/.local-storage/`
//     and serve via the proxy's existing /storage route. Same API
//     shape so callers don't care which backend is live.
//
// Public API:
//   put({ key, body, contentType }) → { key, size }    [async]
//   get(key) → { body: Buffer, contentType, size }     [async]
//   remove(key) → boolean                              [async]
//   exists(key) → boolean                              [async]
//   urlFor(key) → string
//     If R2_PUBLIC_URL is set (e.g. https://media.rxapply.com), returns
//     a public CDN URL that the browser can fetch directly. Otherwise
//     returns `/storage/<key>` and we proxy via `serveHandler`.
//   serveHandler(req, res)                              [express handler]
//     Streams the object back. Used for the local-disk fallback and as
//     an authenticated read path for private R2 buckets.
//
// Key conventions (see KEYS):
//   avatars/<agent>.<ext>            ← per-agent custom avatar
//   media/drafts/<mediaId>.svg       ← Afshin draft
//   media/renders/<mediaId>.png      ← Afshin rendered image
//   kb/uploads/<id>/<filename>       ← raw KB upload (transient)
//   logs/<date>/<file>               ← agent run log bundles (rare)
//
// Notes:
//   - We use the AWS SDK v3 (S3 client) pointed at R2's S3-compatible
//     endpoint. Auth path identical.
//   - Buffer-in / Buffer-out everywhere — callers convert from streams
//     or base64 themselves. Keeps this module simple.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand,
        DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const KEYS = {
  AVATAR:        (agent, ext)     => `avatars/${agent}.${ext}`,
  DRAFT:         (mediaId)        => `media/drafts/${mediaId}.svg`,
  RENDER:        (mediaId)        => `media/renders/${mediaId}.png`,
  KB_UPLOAD:     (id, filename)   => `kb/uploads/${id}/${filename}`,
  LOG_BUNDLE:    (dateDir, base)  => `logs/${dateDir}/${base}.json`,
};

// ── Backend detection ────────────────────────────────────────────────
function _r2Configured() {
  return !!(process.env.R2_ACCESS_KEY_ID
         && process.env.R2_SECRET_ACCESS_KEY
         && process.env.R2_ACCOUNT_ID
         && process.env.R2_BUCKET);
}

const BACKEND = _r2Configured() ? 'r2' : 'local';
const LOCAL_ROOT = path.resolve(__dirname, '.local-storage');

let _s3 = null;
function _getS3() {
  if (_s3) return _s3;
  _s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return _s3;
}

// ── Local-disk fallback (dev only) ──────────────────────────────────
function _localPath(key) {
  // Defence-in-depth: never let `..` escape the root.
  const safe = key.split(/[\\/]+/).filter(p => p && p !== '..').join('/');
  return path.join(LOCAL_ROOT, safe);
}

// ── put ──────────────────────────────────────────────────────────────
async function put({ key, body, contentType = 'application/octet-stream' }) {
  if (!key) throw new Error('storage.put: key required');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (BACKEND === 'r2') {
    await _getS3().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType,
      // No ACLs in R2 — public access is configured at the bucket /
      // custom-domain level (R2_PUBLIC_URL).
    }));
  } else {
    const p = _localPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  return { key, size: buf.length };
}

// ── get ──────────────────────────────────────────────────────────────
async function get(key) {
  if (BACKEND === 'r2') {
    const r = await _getS3().send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET, Key: key,
    }));
    const chunks = [];
    for await (const chunk of r.Body) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    return { body, contentType: r.ContentType || 'application/octet-stream', size: body.length };
  }
  const p = _localPath(key);
  if (!fs.existsSync(p)) throw new Error(`storage.get: not found: ${key}`);
  const body = fs.readFileSync(p);
  return { body, contentType: _guessType(key), size: body.length };
}

// ── remove ───────────────────────────────────────────────────────────
async function remove(key) {
  try {
    if (BACKEND === 'r2') {
      await _getS3().send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET, Key: key,
      }));
    } else {
      const p = _localPath(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    return true;
  } catch (_) { return false; }
}

// ── exists ───────────────────────────────────────────────────────────
async function exists(key) {
  try {
    if (BACKEND === 'r2') {
      await _getS3().send(new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET, Key: key,
      }));
      return true;
    }
    return fs.existsSync(_localPath(key));
  } catch (_) { return false; }
}

// ── urlFor ───────────────────────────────────────────────────────────
// Public custom-domain URL when configured; proxy URL otherwise.
function urlFor(key) {
  const base = process.env.R2_PUBLIC_URL;
  if (base && BACKEND === 'r2') {
    return `${base.replace(/\/+$/, '')}/${key}`;
  }
  return `/storage/${key}`;
}

// ── serveHandler ─────────────────────────────────────────────────────
// Express route handler streaming an object back. Used by the proxy
// for both the local-fallback path and authenticated reads of private
// R2 buckets. URL shape: /storage/<key> with key being the rest of the
// path (req.params[0] when mounted with `/storage/*`).
async function serveHandler(req, res) {
  const key = req.params[0] || req.params.key;
  if (!key) return res.status(400).send('key required');
  try {
    const obj = await get(key);
    res.set('Content-Type', obj.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(obj.body);
  } catch (e) {
    res.status(404).send('not found');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
function _guessType(key) {
  const ext = (path.extname(key) || '').toLowerCase();
  return {
    '.png':  'image/png',
    '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.pdf':  'application/pdf',
    '.json': 'application/json',
    '.txt':  'text/plain; charset=utf-8',
    '.md':   'text/markdown; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

module.exports = {
  KEYS, BACKEND,
  put, get, remove, exists,
  urlFor, serveHandler,
};
