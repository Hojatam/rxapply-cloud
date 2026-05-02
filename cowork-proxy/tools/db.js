// cowork-proxy/tools/db.js
// =====================================================================
// Tiny psql wrapper shared by the tools/* modules. Mirrors the pattern
// used in permissions.js / cost.js: docker exec into the supabase_db
// container, run psql with -tA, return trimmed stdout. Buffer-based
// stdin avoids the Windows cp1252 corruption documented elsewhere.
// =====================================================================

const { spawnSync } = require('child_process');
const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';

function psql(sql) {
  const r = spawnSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: Buffer.from(sql, 'utf-8') });
  if (r.status !== 0) {
    throw new Error(`psql (${r.status}): ${(r.stderr || Buffer.alloc(0)).toString('utf-8').slice(0, 400)}`);
  }
  return (r.stdout || Buffer.alloc(0)).toString('utf-8').trim();
}

// ── SQL literal escapers ─────────────────────────────────────────────
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
// Bytea as a hex literal (used when reading pgp_sym_encrypt output back)
function qBytea(buf) {
  if (!buf) return 'NULL';
  const hex = Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf).toString('hex');
  return `'\\x${hex}'::bytea`;
}

module.exports = { psql, q, qJson, qBytea };
