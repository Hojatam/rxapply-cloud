// cowork-proxy/db.js
// =====================================================================
// Single Postgres entry point for the cloud build. Replaces every
// `docker exec psql` call that existed in the local sandbox.
//
// One pg connection pool per process. Reads DATABASE_URL from env:
//   postgresql://user:pass@host:port/db
// Supabase Cloud tip: use the *pooler* URL (port 6543) on Railway —
// Supabase Pro caps direct connections at 60 and the pooler is what
// every serverless / container deploy expects.
//
// Public API (all async):
//   query(sql)       → { rows, rowCount }   raw pg result
//   queryRows(sql)   → array of row objects
//   queryOne(sql)    → first row, or null
//   queryValue(sql)  → first column of first row (string or null)
//                      Mirrors the legacy `_psql()` shape — use this for
//                      SELECTs that return a single json_build_object()
//                      or similar single-value expressions; auto-detects
//                      jsonb columns and stringifies them so callers can
//                      keep doing JSON.parse(out).
//   queryReturning(sql) → first column of first row (uuid, etc.)
//
// Helpers (synchronous SQL escaping — same shape as legacy modules):
//   q(v)       → SQL literal for null | number | bool | string
//   qJson(v)   → 'json::jsonb' literal
//   qBytea(b)  → '\\xHEX::bytea' literal
//
// Why we don't use parameterised queries everywhere:
//   The legacy codebase built SQL strings with `_q()` helpers and the
//   migration aims for a 1:1 port. Adding parameters in the same pass
//   would balloon the diff. The escaping helpers are safe (single-quote
//   doubling, type coercion). After migration we'll move hot paths to
//   parameterised calls in a follow-up PR.
// =====================================================================

const { Pool } = require('pg');

let _pool = null;

function _getPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL env var is required (Postgres connection string).');
  }
  // Supabase Cloud requires SSL. Local dev (postgres on localhost) doesn't.
  // We auto-detect by hostname rather than forcing the founder to set a flag.
  const isLocal = /(?:localhost|127\.0\.0\.1)/i.test(url);
  _pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Last-ditch error logger so a dropped connection doesn't crash the
  // entire process. Individual queries still throw and are caught by
  // their callers.
  _pool.on('error', (err) => {
    console.error('[db.js] idle pg client error:', err.message);
  });
  return _pool;
}

// ── Core query ─────────────────────────────────────────────────────
async function query(sql) {
  const pool = _getPool();
  return await pool.query(sql);
}
async function queryRows(sql) {
  const r = await query(sql);
  return r.rows || [];
}
async function queryOne(sql) {
  const rows = await queryRows(sql);
  return rows[0] || null;
}

// queryValue mirrors the legacy `_psql()` return shape: a string. When
// the underlying column is jsonb/json (already auto-parsed by pg), we
// re-stringify so callers can still do JSON.parse(out).
async function queryValue(sql) {
  const row = await queryOne(sql);
  if (!row) return '';
  const keys = Object.keys(row);
  if (keys.length === 0) return '';
  const v = row[keys[0]];
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// queryReturning is sugar for INSERT / UPDATE / DELETE … RETURNING ….
// Returns the first column of the first row (typically id::text).
async function queryReturning(sql) {
  const row = await queryOne(sql);
  if (!row) return '';
  return String(row[Object.keys(row)[0]]);
}

// ── SQL literal helpers (same as legacy `_q`/`_qJson`) ─────────────
function q(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function qJson(v) {
  if (v == null) return 'NULL';
  return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
}
function qArr(arr) {
  if (!Array.isArray(arr)) return 'NULL';
  if (arr.length === 0) return `'{}'::text[]`;
  const inner = arr.map(s => `"${String(s).replace(/"/g, '\\"')}"`).join(',');
  return `'{${inner}}'::text[]`;
}
function qBytea(buf) {
  if (!buf) return 'NULL';
  const hex = Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf).toString('hex');
  return `'\\x${hex}'::bytea`;
}

// ── Health probe (used by /health and the wizard preflight) ────────
async function ping() {
  try {
    const r = await query('SELECT 1 AS ok;');
    return { ok: true, rows: r.rows.length };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  query, queryRows, queryOne, queryValue, queryReturning,
  q, qJson, qArr, qBytea,
  ping, close,
};
