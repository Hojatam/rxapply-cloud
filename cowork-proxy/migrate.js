#!/usr/bin/env node
// cowork-proxy/migrate.js
// =====================================================================
// Idempotent migration runner. Reads ../supabase/migrations/*.sql in
// filename order, applies any not yet recorded in the
// `schema_migrations` table, in a transaction per file. Safe to run on
// every deploy — already-applied migrations are skipped silently.
//
// Hooked into:
//   - npm run migrate         (manual / one-off)
//   - Railway release command (server.js boot path can also call it
//                              via runIfNeeded() — see below)
//
// Tracking table:
//   schema_migrations(version text PRIMARY KEY, applied_at timestamptz)
//
//   Where `version` is the filename minus the .sql extension. Numeric
//   prefix in filenames keeps natural-sort order matching deploy order.
//
// Usage:
//   $ node migrate.js                   → apply pending
//   $ node migrate.js --status          → list applied + pending, no apply
//   $ node migrate.js --pretend         → show what would be applied
//   $ node migrate.js --baseline        → mark every local file as applied
//                                         WITHOUT running the SQL. Use this
//                                         when adopting an existing DB that
//                                         already has the schema in place.
//                                         Cloud-fresh deploys never need it.
//
// Notes on the first migration:
//   The very first SQL file (initial_schema) is allowed to fail-soft
//   if the tables already exist (CREATE TABLE IF NOT EXISTS pattern).
//   schema_migrations itself is created by this runner before reading
//   the migrations directory.
// =====================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { query, queryRows, q, close } = require('./db');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase', 'migrations');

async function _ensureTracker() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    );
  `);
}

function _listLocalMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()  // filenames are timestamp-prefixed → natural sort = chronological
    .map(filename => ({
      version: filename.replace(/\.sql$/, ''),
      filename,
      path: path.join(MIGRATIONS_DIR, filename),
    }));
}

async function _listAppliedVersions() {
  const rows = await queryRows(`SELECT version FROM schema_migrations ORDER BY version;`);
  return new Set(rows.map(r => r.version));
}

async function status() {
  await _ensureTracker();
  const local = _listLocalMigrations();
  const applied = await _listAppliedVersions();
  const pending = local.filter(m => !applied.has(m.version));
  return { applied: [...applied], pending: pending.map(m => m.version), total: local.length };
}

// Mark every local file as already applied without running its SQL.
// Used when adopting an existing DB that already has the schema in place.
async function baseline({ log = console.log } = {}) {
  await _ensureTracker();
  const local = _listLocalMigrations();
  const applied = await _listAppliedVersions();
  const toMark = local.filter(m => !applied.has(m.version));
  if (toMark.length === 0) {
    log(`[migrate] baseline: nothing to mark (${applied.size} already tracked)`);
    return { added: [] };
  }
  for (const m of toMark) {
    await query(`INSERT INTO schema_migrations (version) VALUES (${q(m.version)})
                   ON CONFLICT (version) DO NOTHING;`);
  }
  log(`[migrate] baseline: marked ${toMark.length} as applied (no SQL run)`);
  return { added: toMark.map(m => m.version) };
}

async function apply({ pretend = false, log = console.log } = {}) {
  await _ensureTracker();
  const local = _listLocalMigrations();
  const applied = await _listAppliedVersions();
  const pending = local.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    log(`[migrate] already up to date (${applied.size} applied)`);
    return { applied: [...applied], appliedNow: [], skipped: [], failed: null };
  }

  log(`[migrate] ${applied.size} already applied, ${pending.length} pending`);

  const appliedNow = [];
  for (const m of pending) {
    log(`[migrate] ${pretend ? 'WOULD APPLY' : 'applying'}: ${m.filename}`);
    if (pretend) { appliedNow.push(m.version); continue; }

    const sql = fs.readFileSync(m.path, 'utf-8');
    try {
      // Single-file = single transaction. Even if the SQL has its own
      // BEGIN/COMMIT (rare in our migrations), node-postgres treats the
      // outer wrapper as a no-op when the inner one is in flight.
      await query('BEGIN');
      await query(sql);
      await query(`INSERT INTO schema_migrations (version) VALUES (${q(m.version)})
                     ON CONFLICT (version) DO NOTHING;`);
      await query('COMMIT');
      appliedNow.push(m.version);
      log(`[migrate]   ✓ ${m.version}`);
    } catch (e) {
      await query('ROLLBACK').catch(() => {});
      log(`[migrate]   ✕ ${m.version} — ${e.message.slice(0, 200)}`);
      return {
        applied: [...applied, ...appliedNow],
        appliedNow,
        failed: { version: m.version, error: e.message },
      };
    }
  }

  log(`[migrate] done (${appliedNow.length} new)`);
  return { applied: [...applied, ...appliedNow], appliedNow, failed: null };
}

// runIfNeeded — called from server.js boot path. Runs `apply()` once on
// startup so a fresh deploy provisions its own schema. Safe to skip in
// dev (set MIGRATE_ON_BOOT=false in .env) when you'd rather apply by
// hand via `npm run migrate`.
async function runIfNeeded() {
  if (process.env.MIGRATE_ON_BOOT === 'false') {
    console.log('[migrate] MIGRATE_ON_BOOT=false → skipping');
    return { skipped: true };
  }
  try {
    return await apply({ log: (...a) => console.log(...a) });
  } catch (e) {
    // Migration failure shouldn't kill the proxy boot — log loudly,
    // continue. The /health endpoint will reflect the issue elsewhere.
    console.error(`[migrate] failed: ${e.message}`);
    return { failed: e.message };
  }
}

// CLI entry
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    try {
      if (argv.includes('--status')) {
        const s = await status();
        console.log(JSON.stringify(s, null, 2));
      } else if (argv.includes('--baseline')) {
        await baseline();
      } else {
        const r = await apply({ pretend: argv.includes('--pretend') });
        if (r.failed) process.exitCode = 1;
      }
    } catch (e) {
      console.error(`[migrate] fatal: ${e.message}`);
      process.exitCode = 1;
    } finally {
      await close();
    }
  })();
}

module.exports = { apply, status, baseline, runIfNeeded };
