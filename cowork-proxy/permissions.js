// cowork-proxy/permissions.js
// =====================================================================
// K1 · Per-action approval matrix + Inbox queue.  [cloud build]
//
// Public API (all async except getMode/listAll which are kept sync via cache):
//   getMode(agent, action, [estimatedCostUsd]) → 'auto' | 'ask' | 'blocked'
//   listAll()                                  → all (agent, action, mode, …) rows
//   refresh()                                  → force-reload the cache (await)
//   setMode(agent, action, mode, [opts])       → upsert
//   queue({agent, action, payload, preview, estimatedCostUsd, triggeredBy}) → pending row
//   listPending([{limit}])                     → array, newest first
//   countPending()                             → integer
//   getPending(id)                             → one row
//   approve(id, decisionNote, decidedBy)       → marks approved + returns row
//   reject(id, decisionNote, decidedBy)        → marks rejected + returns row
//   recordExecutionResult(id, result)          → fills in result jsonb + status='executed'
//   recordExecutionFailure(id, err)            → status='failed'
//   pruneExpired()                             → marks stale pending → 'expired'
//
// Why getMode stays sync: it's called inside synchronous validation
// chains (anthropic-chat policy gate, etc.) where adding `await`
// cascades widely. We keep a 5s in-memory cache populated by refresh().
// `refresh()` is awaited at boot and on setMode().
// =====================================================================

const { queryValue, queryReturning, query, q, qJson } = require('./db');

// ── Permissions matrix ──────────────────────────────────────────────

let _permsCache = null;
let _permsCacheStamp = 0;
const PERMS_TTL_MS = 5_000;

async function _loadAll() {
  const out = await queryValue(`
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY agent, action), '[]'::json)
      FROM (SELECT agent, action, mode, cost_threshold_usd, notes, updated_at::text, updated_by
              FROM agent_permissions) p;`);
  return out ? JSON.parse(out) : [];
}

async function refresh() {
  try {
    _permsCache = await _loadAll();
    _permsCacheStamp = Date.now();
  } catch (_) {
    _permsCache = _permsCache || [];
  }
  return _permsCache;
}

// _ensureCache tries to use stale cache rather than blocking on a fresh
// load. Sync path: if cache is empty AND nothing has been loaded yet,
// returns an empty array (i.e. all modes default to 'auto'). The boot
// sequence in server.js calls refresh() before listening, so this only
// trips during the first ~ms of startup.
function _ensureCache() {
  const now = Date.now();
  if (_permsCache && (now - _permsCacheStamp) <= PERMS_TTL_MS) return _permsCache;
  // Background-refresh; return whatever we have. For first-call cold
  // start, that's [] (= default-auto), which is the existing behaviour.
  refresh().catch(() => {});
  return _permsCache || [];
}

function _findRow(agent, action) {
  return _ensureCache().find(r => r.agent === agent && r.action === action) || null;
}

function getMode(agent, action, estimatedCostUsd) {
  const row = _findRow(agent, action);
  if (!row) return 'auto';
  if (row.mode === 'blocked') return 'blocked';
  if (row.mode === 'ask')     return 'ask';
  if (row.cost_threshold_usd != null && Number.isFinite(estimatedCostUsd)
      && estimatedCostUsd > parseFloat(row.cost_threshold_usd)) {
    return 'ask';
  }
  return 'auto';
}

function listAll() { return _ensureCache(); }

async function setMode(agent, action, mode, { costThreshold = null, notes = null, updatedBy = 'founder' } = {}) {
  if (!['auto', 'ask', 'blocked'].includes(mode)) {
    return { ok: false, error: `mode must be 'auto'|'ask'|'blocked'` };
  }
  if (!agent || !action) return { ok: false, error: 'agent + action required' };
  const sql = `
    INSERT INTO agent_permissions (agent, action, mode, cost_threshold_usd, notes, updated_at, updated_by)
    VALUES (${q(agent)}, ${q(action)}, ${q(mode)},
            ${costThreshold == null ? 'NULL' : Number(costThreshold)},
            ${q(notes)}, NOW(), ${q(updatedBy)})
    ON CONFLICT (agent, action) DO UPDATE
      SET mode = EXCLUDED.mode,
          cost_threshold_usd = EXCLUDED.cost_threshold_usd,
          notes = COALESCE(EXCLUDED.notes, agent_permissions.notes),
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
    RETURNING id::text;`;
  try {
    await query(sql);
    await refresh();
    return { ok: true, agent, action, mode };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// ── Inbox queue ─────────────────────────────────────────────────────

async function queue({ agent, action, payload = {}, preview = null, estimatedCostUsd = null, triggeredBy = 'founder' }) {
  if (!agent || !action) throw new Error('queue: agent + action required');
  const sql = `
    INSERT INTO agent_actions_pending
      (agent, action, payload, preview_text, estimated_cost_usd, triggered_by)
    VALUES (${q(agent)}, ${q(action)}, ${qJson(payload)},
            ${q(preview)}, ${estimatedCostUsd == null ? 'NULL' : Number(estimatedCostUsd)},
            ${q(triggeredBy)})
    RETURNING id::text;`;
  const id = await queryReturning(sql);
  return { id, agent, action, status: 'pending' };
}

async function listPending({ limit = 50 } = {}) {
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
  return JSON.parse((await queryValue(sql)) || '[]');
}

async function countPending() {
  const out = await queryValue(`SELECT COUNT(*) FROM agent_actions_pending
                                  WHERE status='pending' AND expires_at > NOW();`);
  return parseInt(out, 10) || 0;
}

async function listRecent({ limit = 30 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, action, status, preview_text,
                  estimated_cost_usd::text, decided_at::text, decided_by,
                  decision_note, created_at::text, result
           FROM agent_actions_pending
          ORDER BY created_at DESC LIMIT ${limit}) p;`;
  return JSON.parse((await queryValue(sql)) || '[]');
}

async function getPending(id) {
  const sql = `
    SELECT row_to_json(p) FROM (
      SELECT id::text, agent, action, payload, preview_text,
              estimated_cost_usd::text, triggered_by, status,
              created_at::text, decided_at::text, decided_by,
              decision_note, expires_at::text, result
        FROM agent_actions_pending WHERE id = ${q(id)}
    ) p;`;
  const out = await queryValue(sql);
  return out ? JSON.parse(out) : null;
}

async function approve(id, decisionNote = null, decidedBy = 'founder') {
  const sql = `
    UPDATE agent_actions_pending
       SET status = 'approved', decided_at = NOW(),
           decided_by = ${q(decidedBy)}, decision_note = ${q(decisionNote)}
     WHERE id = ${q(id)} AND status = 'pending'
     RETURNING id::text;`;
  const out = await queryValue(sql);
  if (!out) return null;
  return await getPending(id);
}

async function reject(id, decisionNote = null, decidedBy = 'founder') {
  await query(`
    UPDATE agent_actions_pending
       SET status = 'rejected', decided_at = NOW(),
           decided_by = ${q(decidedBy)}, decision_note = ${q(decisionNote)}
     WHERE id = ${q(id)} AND status = 'pending';`);
  return await getPending(id);
}

async function recordExecutionResult(id, result) {
  await query(`
    UPDATE agent_actions_pending
       SET status = 'executed', result = ${qJson(result)}
     WHERE id = ${q(id)};`);
}

async function recordExecutionFailure(id, err) {
  await query(`
    UPDATE agent_actions_pending
       SET status = 'failed',
           result = ${qJson({ error: String(err).slice(0, 1000) })}
     WHERE id = ${q(id)};`);
}

async function pruneExpired() {
  const r = await query(`
    UPDATE agent_actions_pending
       SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= NOW();`);
  return r.rowCount || 0;
}

module.exports = {
  getMode, listAll, refresh, setMode,
  queue, listPending, countPending, listRecent, getPending,
  approve, reject, recordExecutionResult, recordExecutionFailure,
  pruneExpired,
};
