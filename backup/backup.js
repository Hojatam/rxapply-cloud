#!/usr/bin/env node
// RxApply backup runner
// =====================
// Single-shot script (Railway cron invokes the container).
//
// Pipeline:
//   1. pg_dump --format=custom (compressed binary, fastest restore)
//   2. AES-256-GCM encrypt with BACKUP_ENCRYPTION_KEY (optional but
//      strongly recommended — without it the file is uploaded plain)
//   3. PUT to R2 under key: backups/YYYY-MM-DD/db.dump[.enc]
//   4. List existing backups; DELETE any older than RETENTION_DAYS
//
// Required env:
//   DATABASE_URL              postgres://...  (use the Supabase pooler URL)
//   R2_ACCOUNT_ID             Cloudflare account id
//   R2_ACCESS_KEY_ID          R2 access key
//   R2_SECRET_ACCESS_KEY      R2 secret
//   R2_BUCKET                 e.g. rxapply-prod
//
// Optional env:
//   BACKUP_ENCRYPTION_KEY     32 bytes hex (64 chars). Leave UNSET to skip encryption.
//   BACKUP_PREFIX             default: "backups"
//   RETENTION_DAYS            default: 30
//
// Exit codes:
//   0  success
//   1  config error
//   2  pg_dump failure
//   3  upload failure
//   4  prune failure (non-fatal — backup still uploaded)

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

// ── Config ──────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || '';
const BACKUP_PREFIX = (process.env.BACKUP_PREFIX || 'backups').replace(/^\/+|\/+$/g, '');
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);

// ── Validation ──────────────────────────────────────────────────────
function fail(code, msg) {
  console.error(`[backup] FAIL: ${msg}`);
  process.exit(code);
}

if (!DATABASE_URL) fail(1, 'DATABASE_URL not set');
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  fail(1, 'R2_* env vars not all set (need ACCOUNT_ID, ACCESS_KEY_ID, SECRET_ACCESS_KEY, BUCKET)');
}
if (Number.isNaN(RETENTION_DAYS) || RETENTION_DAYS < 1) {
  fail(1, `RETENTION_DAYS must be a positive integer, got: ${process.env.RETENTION_DAYS}`);
}

let encKey = null;
if (BACKUP_ENCRYPTION_KEY) {
  if (!/^[0-9a-fA-F]{64}$/.test(BACKUP_ENCRYPTION_KEY)) {
    fail(1, 'BACKUP_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  encKey = Buffer.from(BACKUP_ENCRYPTION_KEY, 'hex');
} else {
  console.warn('[backup] WARN: BACKUP_ENCRYPTION_KEY not set — backup will be uploaded UNENCRYPTED.');
}

// ── R2 client (S3-compatible) ───────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ── Helpers ─────────────────────────────────────────────────────────
function isoDate() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}

function runPgDump() {
  return new Promise((resolve, reject) => {
    // --format=custom : compressed binary, supports parallel restore
    // --no-owner / --no-acl : portable across roles
    const args = ['--format=custom', '--no-owner', '--no-acl', DATABASE_URL];
    const proc = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function encrypt(plain) {
  // AES-256-GCM. Output: [12B IV][16B auth tag][ciphertext]
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct1 = cipher.update(plain);
  const ct2 = cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct1, ct2]);
}

async function upload(key, body) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
  }));
}

async function prune() {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const toDelete = [];
  let token = undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: `${BACKUP_PREFIX}/`,
      ContinuationToken: token,
    }));
    for (const obj of out.Contents || []) {
      // Backup keys look like: backups/2026-05-02/db.dump.enc
      const m = obj.Key && obj.Key.match(/^([^/]+)\/(\d{4})-(\d{2})-(\d{2})\//);
      if (!m) continue;
      const ts = Date.UTC(+m[2], +m[3] - 1, +m[4]);
      if (ts < cutoffMs) toDelete.push({ Key: obj.Key });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  if (!toDelete.length) {
    console.log('[backup] prune: nothing to delete');
    return 0;
  }

  // DeleteObjects max 1000 keys per call — we'll never hit that.
  await s3.send(new DeleteObjectsCommand({
    Bucket: R2_BUCKET,
    Delete: { Objects: toDelete, Quiet: true },
  }));
  console.log(`[backup] prune: deleted ${toDelete.length} old object(s)`);
  return toDelete.length;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`[backup] start · ${new Date().toISOString()}`);
  console.log(`[backup] bucket=${R2_BUCKET} prefix=${BACKUP_PREFIX}/ retention=${RETENTION_DAYS}d encryption=${encKey ? 'AES-256-GCM' : 'NONE'}`);

  // 1. pg_dump
  let dump;
  try {
    dump = await runPgDump();
    console.log(`[backup] pg_dump ok · ${(dump.length / 1024 / 1024).toFixed(2)} MB · ${Date.now() - t0}ms`);
  } catch (e) {
    fail(2, `pg_dump: ${e.message}`);
  }

  // 2. Encrypt (optional)
  let payload = dump;
  let suffix = '.dump';
  if (encKey) {
    payload = encrypt(dump);
    suffix = '.dump.enc';
    console.log(`[backup] encrypted · ${(payload.length / 1024 / 1024).toFixed(2)} MB`);
  }

  // 3. Upload
  const key = `${BACKUP_PREFIX}/${isoDate()}/db${suffix}`;
  try {
    await upload(key, payload);
    console.log(`[backup] uploaded · s3://${R2_BUCKET}/${key}`);
  } catch (e) {
    fail(3, `upload: ${e.message}`);
  }

  // 4. Prune (non-fatal)
  try {
    await prune();
  } catch (e) {
    console.error(`[backup] WARN prune failed: ${e.message}`);
    // Don't exit non-zero — the backup itself succeeded.
  }

  console.log(`[backup] done · total ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error(`[backup] unexpected error: ${e && e.stack || e}`);
  process.exit(99);
});
