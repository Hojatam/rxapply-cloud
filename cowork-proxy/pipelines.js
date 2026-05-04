// cowork-proxy/pipelines.js
// =====================================================================
// M72A · Pipeline storage + retrieval.
//
// Backs the Pipeline tab. Stores recipes in the `pipelines` table (one row
// per pipeline, definition is the full recipe JSON in a JSONB column).
// Every save creates a `pipeline_versions` snapshot so history is
// preserved.
//
// Public surface:
//   await listAll({ category? })          → array of {id, label, ...}
//   await getById(id)                     → full definition or null
//   await save(id, definition, opts)      → bumps version, snapshots
//   await listVersions(id, opts)          → snapshots header rows
//   await getVersion(id, version)         → one snapshot's definition
//   await rollback(id, toVersion)         → restores a snapshot as latest
//   await clone(srcId, newId, newLabel)   → duplicate a pipeline
//   await del(id)                         → soft-disable (sets enabled=false)
//   await seedFromFiles({ recipesDir })   → bootstrap: import JSON files
//                                            into the table if empty
//   getCachedSync(id)                     → fast sync access for the
//                                            orchestrator's hot-path
//   listCachedSync()                      → fast sync access for /pipelines
//   refreshCache()                        → re-pull all rows into cache
//   onChange(cb)                          → fire when cache refreshes
//
// The orchestrator uses getCachedSync/listCachedSync at run time (no async
// in the stage tick). Cache is populated at boot via refreshCache() and
// invalidated on every save / rollback / del.
// =====================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { query, queryRows, queryValue, queryReturning, q, qJson } = require('./db');

const _cache = new Map();   // id → { id, label, ..., definition }
const _changeListeners = [];

function _notifyChange() {
  for (const cb of _changeListeners) {
    try { cb(); } catch (_) {}
  }
}

function onChange(cb) { _changeListeners.push(cb); }

// ── Reads ─────────────────────────────────────────────────────────────

async function listAll({ category = null, includeDisabled = false } = {}) {
  const conds = [];
  if (category) conds.push(`category = ${q(category)}`);
  if (!includeDisabled) conds.push('enabled = TRUE');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await queryRows(`
    SELECT id, label, description, category, definition, version, enabled,
            created_at::text, updated_at::text
      FROM pipelines ${where}
     ORDER BY category, label;`);
  return rows;
}

async function getById(id) {
  const rows = await queryRows(`
    SELECT id, label, description, category, definition, version, enabled,
            created_at::text, updated_at::text
      FROM pipelines WHERE id = ${q(id)} LIMIT 1;`);
  return rows[0] || null;
}

async function listVersions(id, { limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = await queryRows(`
    SELECT id::text, version, changed_by, change_note, created_at::text
      FROM pipeline_versions
     WHERE pipeline_id = ${q(id)}
     ORDER BY version DESC LIMIT ${lim};`);
  return rows;
}

async function getVersion(id, version) {
  const v = parseInt(version, 10) || 0;
  const out = await queryValue(`
    SELECT definition FROM pipeline_versions
     WHERE pipeline_id = ${q(id)} AND version = ${v} LIMIT 1;`);
  if (!out) return null;
  return typeof out === 'string' ? JSON.parse(out) : out;
}

// ── Writes ────────────────────────────────────────────────────────────

async function save(id, definition, { changedBy = 'founder', changeNote = null, label = null, description = null, category = null } = {}) {
  if (!id || !definition) throw new Error('id + definition required');
  if (typeof definition !== 'object') throw new Error('definition must be an object');
  if (definition.id && definition.id !== id) throw new Error('definition.id must match pipeline id');

  const finalLabel = label || definition.label || id;
  const finalDesc  = description != null ? description : (definition.description || '');
  const finalCat   = category || definition.category || 'compose';

  // Upsert pipeline row + bump version atomically
  const existing = await queryValue(`SELECT version FROM pipelines WHERE id = ${q(id)};`);
  const nextV = existing ? (parseInt(existing, 10) + 1) : 1;

  await query(`
    INSERT INTO pipelines (id, label, description, category, definition, version, enabled, updated_at)
    VALUES (${q(id)}, ${q(finalLabel)}, ${q(finalDesc)}, ${q(finalCat)},
            ${qJson(definition)}::jsonb, ${nextV}, TRUE, NOW())
    ON CONFLICT (id) DO UPDATE SET
       label       = EXCLUDED.label,
       description = EXCLUDED.description,
       category    = EXCLUDED.category,
       definition  = EXCLUDED.definition,
       version     = EXCLUDED.version,
       updated_at  = NOW();`);

  await query(`
    INSERT INTO pipeline_versions (pipeline_id, version, definition, changed_by, change_note)
    VALUES (${q(id)}, ${nextV}, ${qJson(definition)}::jsonb, ${q(changedBy)}, ${q(changeNote)});`);

  await refreshCache();
  return { ok: true, id, version: nextV };
}

async function rollback(id, toVersion, { changedBy = 'founder' } = {}) {
  const def = await getVersion(id, toVersion);
  if (!def) return { ok: false, error: `version ${toVersion} not found` };
  return await save(id, def, { changedBy, changeNote: `rollback to v${toVersion}` });
}

async function clone(srcId, newId, newLabel) {
  if (!srcId || !newId) throw new Error('srcId + newId required');
  const src = await getById(srcId);
  if (!src) throw new Error(`source pipeline ${srcId} not found`);
  const exists = await queryValue(`SELECT 1 FROM pipelines WHERE id = ${q(newId)};`);
  if (exists) throw new Error(`pipeline ${newId} already exists`);
  const def = JSON.parse(JSON.stringify(src.definition || {}));
  def.id = newId;
  if (newLabel) def.label = newLabel;
  return await save(newId, def, {
    changedBy: 'founder',
    changeNote: `cloned from ${srcId} v${src.version}`,
    label: newLabel || `${src.label} (copy)`,
    category: src.category,
  });
}

async function del(id, { hard = false } = {}) {
  if (hard) {
    await query(`DELETE FROM pipelines WHERE id = ${q(id)};`);
  } else {
    await query(`UPDATE pipelines SET enabled = FALSE, updated_at = NOW() WHERE id = ${q(id)};`);
  }
  await refreshCache();
  return { ok: true, id, hard };
}

// ── Boot-time seed from compose-recipes/*.json ───────────────────────

async function seedFromFiles({ recipesDir = path.resolve(__dirname, '..', 'compose-recipes') } = {}) {
  if (!fs.existsSync(recipesDir)) return { ok: true, seeded: 0, reason: 'no recipes dir' };

  // Only seed if the table is empty — otherwise the founder's edits would
  // be overwritten on every redeploy.
  const count = parseInt(await queryValue(`SELECT COUNT(*) FROM pipelines;`), 10) || 0;
  if (count > 0) return { ok: true, seeded: 0, reason: `pipelines table already has ${count} rows` };

  let seeded = 0;
  for (const f of fs.readdirSync(recipesDir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(recipesDir, f), 'utf8'));
      if (!def || !def.id) continue;
      await save(def.id, def, {
        changedBy: 'system:bootstrap',
        changeNote: `seeded from compose-recipes/${f}`,
        label: def.label,
        description: def.description,
        category: 'compose',
      });
      seeded++;
    } catch (e) {
      console.error(`[pipelines.seedFromFiles] ${f}: ${e.message}`);
    }
  }
  return { ok: true, seeded };
}

// ── Cache for hot-path sync access ───────────────────────────────────

async function refreshCache() {
  try {
    const rows = await listAll({ includeDisabled: true });
    _cache.clear();
    for (const r of rows) _cache.set(r.id, r);
    _notifyChange();
    return { ok: true, count: rows.length };
  } catch (e) {
    console.error('[pipelines] refreshCache failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getCachedSync(id) {
  return _cache.get(id) || null;
}

function listCachedSync() {
  return Array.from(_cache.values());
}

module.exports = {
  // reads
  listAll, getById, listVersions, getVersion,
  // writes
  save, rollback, clone, del,
  // bootstrap
  seedFromFiles, refreshCache,
  // sync hot-path
  getCachedSync, listCachedSync,
  // events
  onChange,
};
