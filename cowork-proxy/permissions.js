// cowork-proxy/permissions.js
// =====================================================================
// K1 · Per-action approval matrix + Inbox queue.
//
// Public API:
//   getMode(agent, action, [estimatedCostUsd]) → 'auto' | 'ask' | 'blocked'
//   listAll()                                  → all (agent, action, mode, …) rows
//   setMode(agent, action, mode, [opts])       → upsert
//   queue({agent, action, payload, preview, estimatedCostUsd, triggeredBy}) → pending row
//   listPending()                              → array, newest first
//   countPending()                             → integer
//   getPending(id)                             → one row
//   approve(id, decisionNote, decidedBy)       → marks approved + returns row
//   reject(id, decisionNote, decidedBy)        → marks rejected + returns row
//   recordExecutionResult(id, result)          → fills in result jsonb + status='executed'
//   recordExecutionFailure(id, err)            → status='failed'
//   pruneExpired()                             → marks stale pending → 'expired'
//
// Resolution semantics:
//   1. Lookup row for (agent, action). If missing → default 'auto'.
//   2. If row.mode === 'blocked' → return 'blocked'.
//   3. If row.mode === 'ask' → return 'ask'.
//   4. If row.mode === 'auto' AND estimatedCostUsd > row.cost_threshold_usd
//      AND threshold is set → return 'ask' (auto-promote to ask above threshold).
//   5. Else → 'auto'.
// =====================================================================

const { spawnSync } = require('child_process');
const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';

function _psql(sql) {
  // Buffer input avoids the Windows cp1252 corruption documented elsewhere.
  const r = spawnSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: Buffer.from(sql, 'utf-8') });
  if (r.status !== 0) {
    throw new Error(`psql (${r.status}): ${(r.stderr || Buffer.alloc(0)).toString('utf-8').slice(0, 300)}`);
  }
  return (r.stdout || Buffer.alloc(0)).toString('utf-8').trim();
}
function _q(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function _qJson(v) { return v == null ? 'NULL' : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`; }

// ── Permissions matrix ──────────────────────────────────────────────

// Cache (agent, action) → row for ~5s. Keeps every gated request from
// hitting psql; cleared on setMode().
let _permsCache = null;
let _permsCacheStamp = 0;
const PERMS_TTL_MS = 5_000;

function _loadAll() {
  const out = _psql(`SELECT COALESCE(json_agg(row_to_json(p) ORDER BY agent, action), '[]'::json)
                       FROM (SELECT agent, action, mode, cost_threshold_usd, notes, updated_at::text, updated_by
                              FROM agent_permissions) p;`);
  return out ? JSON.parse(out) : [];
}
function _ensureCache() {
  const now = Date.now();
  if (!_permsCache || (now - _permsCacheStamp) > PERMS_TTL_MS) {
    try {
      _permsCache = _loadAll();
      _permsCacheStamp = now;
    } catch (_) {
      _permsCache = _permsCache || [];
    }
  }
  return _permsCache;
}
function _findRow(agent, action) {
  const rows = _ensureCache();
  return rows.find(r => r.agent === agent && r.action === action) || null;
}

function getMode(agent, action, estimatedCostUsd) {
  const row = _findRow(agent, action);
  if (!row) return 'auto';   // missing rows default to auto
  if (row.mode === 'blocked') return 'blocked';
  if (row.mode === 'ask')     return 'ask';
  // auto + cost threshold → escalate to ask if exceeded
  if (row.cost_threshold_usd != null && Number.isFinite(estimatedCostUsd)
      && estimatedCostUsd > parseFloat(row.cost_threshold_usd)) {
    return 'ask';
  }
  return 'auto';
}

function listAll() {
  return _ensureCache();
}

function setMode(agent, action, mode, { costThreshold = null, notes = null, updatedBy = 'founder' } = {}) {
  if (!['auto', 'ask', 'blocked'].includes(mode)) {
    return { ok: false, error: `mode must be 'auto'|'ask'|'blocked'` };
  }
  if (!agent || !action) return { ok: false, error: 'agent + action required' };
  const sql = `
    INSERT INTO agent_permissions (agent, action, mode, cost_threshold_usd, notes, updated_at, updated_by)
    VALUES (${_q(agent)}, ${_q(action)}, ${_q(mode)},
            ${costThreshold == null ? 'NULL' : Number(costThreshold)},
            ${_q(notes)}, NOW(), ${_q(updatedBy)})
    ON CONFLICT (agent, action) DO UPDATE
      SET mode = EXCLUDED.mode,
          cost_threshold_usd = EXCLUDED.cost_threshold_usd,
          notes = COALESCE(EXCLUDED.notes, agent_permissions.notes),
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
    RETURNING id::text;`;
  try {
    _psql(sql);
    _permsCache = null;
    return { ok: true, agent, action, mode };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// ── Inbox queue ─────────────────────────────────────────────────────

function queue({ agent, action, payload = {}, preview = null, estimatedCostUsd = null, triggeredBy = 'founder' }) {
  if (!agent || !action) throw new Error('queue: agent + action required');
  const sql = `
    INSERT INTO agent_actions_pending
      (agent, action, payload, preview_text, estimated_cost_usd, triggered_by)
    VALUES (${_q(agent)}, ${_q(action)}, ${_qJson(payload)},
            ${_q(preview)}, ${estimatedCostUsd == null ? 'NULL' : Number(estimatedCostUsd)},
            ${_q(triggeredBy)})
    RETURNING id::text;`;
  const id = _psql(sql).split(/[\r\n]+/)[0].trim();
  return { id, agent, action, status: 'pending' };
}

function listPending({ limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, action, payload, preview_text, estimated_cost_usd::text,
                  triggered_by, status, created_at::text, expires_at::text
           FROM agent_actions_pending
          WHERE status = 'pending'
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT ${limit}) p;`;
  return JSON.parse(_psql(sql) || '[]');
}

function countPending() {
  const out = _psql(`SELECT COUNT(*) FROM agent_actions_pending
                       WHERE status='pending' AND expires_at > NOW();`);
  return parseInt(out, 10) || 0;
}

function listRecent({ limit = 30 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, action, status, preview_text,
                  estimated_cost_usd::text, decided_at::text, decided_by,
                  decision_note, created_at::text, result
           FROM agent_actions_pending
          ORDER BY created_at DESC LIMIT ${limit}) p;`;
  return JSON.parse(_psql(sql) || '[]');
}

function getPending(id) {
  const sql = `
    SELECT row_to_json(p) FROM (
      SELECT id::text, agent, action, payload, preview_text,
              estimated_cost_usd::text, triggered_by, status,
              created_at::text, decided_at::text, decided_by,
              decision_note, expires_at::text, result
        FROM agent_actions_pending WHERE id = ${_q(id)}
    ) p;`;
  const out = _psql(sql);
  return out ? JSON.parse(out) : null;
}

function approve(id, decisionNote = null, decidedBy = 'founder') {
  const sql = `
    UPDATE agent_actions_pending
       SET status = 'approved', decided_at = NOW(),
           decided_by = ${_q(decidedBy)}, decision_note = ${_q(decisionNote)}
     WHERE id = ${_q(id)} AND status = 'pending'
     RETURNING id::text, agent, action, payload;`;
  const out = _psql(sql);
  if (!out) return null;
  // _psql -tA returns "<id>|<agent>|<action>|<payload>" — just refetch full row
  return getPending(id);
}

function reject(id, decisionNote = null, decidedBy = 'founder') {
  const sql = `
    UPDATE agent_actions_pending
       SET status = 'rejected', decided_at = NOW(),
           decided_by = ${_q(decidedBy)}, decision_note = ${_q(decisionNote)}
     WHERE id = ${_q(id)} AND status = 'pending';`;
  _psql(sql);
  return getPending(id);
}

function recordExecutionResult(id, result) {
  const sql = `
    UPDATE agent_actions_pending
       SET status = 'executed', result = ${_qJson(result)}
     WHERE id = ${_q(id)};`;
  _psql(sql);
}

function recordExecutionFailure(id, err) {
  const sql = `
    UPDATE agent_actions_pending
       SET status = 'failed',
           result = ${_qJson({ error: String(err).slice(0, 1000) })}
     WHERE id = ${_q(id)};`;
  _psql(sql);
}

function pruneExpired() {
  const sql = `
    UPDATE agent_actions_pending
       SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= NOW()
     RETURNING id;`;
  const out = _psql(sql);
  return out ? out.split(/[\r\n]+/).filter(Boolean).length : 0;
}

module.exports = {
  getMode, listAll, setMode,
  queue, listPending, countPending, listRecent, getPending,
  approve, reject, recordExecutionResult, recordExecutionFailure,
  pruneExpired,
};
