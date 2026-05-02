// cowork-proxy/agent-handoffs.js
// =====================================================================
// K4 · Agent-to-agent handoff requests.
//
// Public API:
//   record({fromAgent, toAgent, reason, suggestedAction, payload, sourceRunId, sourceChatId})
//   listPending({limit})
//   listRecent({limit, agent})
//   countPending()
//   getOne(id)
//   approve(id, decisionNote)        → status='approved'
//   reject(id, decisionNote)         → status='rejected'
//   redirect(id, newAgent, decisionNote) → status='redirected'
//   recordResult(id, result)         → status='executed'
//   recordFailure(id, err)           → status='failed'
//
//   parseFromOutput(rawOutput, contextAgent) → {to_agent, reason, …} | null
//     Permissive parser. Looks for `handoff_intent` (object), `handoff` field,
//     or a "needs <agent>" string fallback. Returns null when nothing detected.
// =====================================================================

const { spawnSync } = require('child_process');
const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';

function _psql(sql) {
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
  return `'${String(v).replace(/'/g, "''")}'`;
}
function _qJson(v) { return v == null ? 'NULL' : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`; }

// Whitelist of agents that exist in our roster (matches dashboard.html AGENTS).
// Defensive: only accept handoffs to known agents to avoid typo-injected garbage.
const KNOWN_AGENTS = new Set([
  'pooya','sepehr','goyesh','avang','ramin',
  'rahnama','rahbar','bineh','mehrban',
  'roya','shahed','dadbeh','nasim',
  'ravi','zirak','paya','kherad',
  'bidar','davari','payvand','mehmandar',
  'afshin','compose-ig','cross-post',
]);

// ── Parse a handoff request out of an agent's output ────────────────
// Accepts:
//   { handoff_intent: { to_agent, reason, suggested_action, payload } }
//   { handoff: { ... } }
//   { needs_help_from: "<agent>", reason: "..." }     ← fallback shape
function parseFromOutput(output, contextAgent) {
  if (!output || typeof output !== 'object') return null;
  const candidate = output.handoff_intent || output.handoff || (output.needs_help_from
    ? { to_agent: output.needs_help_from, reason: output.reason || '' }
    : null);
  if (!candidate || typeof candidate !== 'object') return null;
  const to = String(candidate.to_agent || candidate.toAgent || candidate.agent || '').toLowerCase().trim();
  if (!to || to === contextAgent || !KNOWN_AGENTS.has(to)) return null;
  return {
    to_agent: to,
    reason: candidate.reason ? String(candidate.reason).slice(0, 500) : null,
    suggested_action: candidate.suggested_action || candidate.suggestedAction || candidate.action || null,
    payload: candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : null,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────
function record({ fromAgent, toAgent, reason = null, suggestedAction = null,
                  payload = null, sourceRunId = null, sourceChatId = null }) {
  if (!fromAgent || !toAgent) return { ok: false, error: 'fromAgent + toAgent required' };
  if (!KNOWN_AGENTS.has(toAgent)) return { ok: false, error: `unknown to_agent: ${toAgent}` };
  try {
    const sql = `
      INSERT INTO agent_handoffs (from_agent, to_agent, reason, suggested_action,
                                   payload, source_run_id, source_chat_id)
      VALUES (${_q(fromAgent)}, ${_q(toAgent)}, ${_q(reason)}, ${_q(suggestedAction)},
              ${_qJson(payload)}, ${_q(sourceRunId)}, ${_q(sourceChatId)})
      RETURNING id::text;`;
    const id = _psql(sql).split(/[\r\n]+/)[0].trim();
    return { ok: true, id, status: 'pending' };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function listPending({ limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(h) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, from_agent, to_agent, reason, suggested_action,
                  payload, source_run_id::text, status, created_at::text
            FROM agent_handoffs
           WHERE status = 'pending'
           ORDER BY created_at DESC LIMIT ${limit}) h;`;
  try { return JSON.parse(_psql(sql) || '[]'); } catch (_) { return []; }
}

function listRecent({ limit = 30, agent = null } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const where = agent ? `WHERE from_agent = ${_q(agent)} OR to_agent = ${_q(agent)}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(h) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, from_agent, to_agent, reason, suggested_action,
                  status, decided_at::text, decision_note, created_at::text
            FROM agent_handoffs ${where}
           ORDER BY created_at DESC LIMIT ${limit}) h;`;
  try { return JSON.parse(_psql(sql) || '[]'); } catch (_) { return []; }
}

function countPending() {
  try {
    const out = _psql(`SELECT COUNT(*) FROM agent_handoffs WHERE status='pending';`);
    return parseInt(out, 10) || 0;
  } catch (_) { return 0; }
}

function getOne(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(h) FROM (
      SELECT id::text, from_agent, to_agent, reason, suggested_action, payload,
              source_run_id::text, source_chat_id::text, status,
              decided_at::text, decided_by, decision_note, result,
              created_at::text
        FROM agent_handoffs WHERE id = ${_q(id)}
    ) h;`;
  try { const out = _psql(sql); return out ? JSON.parse(out) : null; }
  catch (_) { return null; }
}

function _setStatus(id, status, decidedBy = 'founder', decisionNote = null) {
  const sql = `
    UPDATE agent_handoffs
       SET status = ${_q(status)}, decided_at = NOW(),
           decided_by = ${_q(decidedBy)}, decision_note = ${_q(decisionNote)}
     WHERE id = ${_q(id)} AND status = 'pending';`;
  _psql(sql);
  return getOne(id);
}

function approve(id, decisionNote = null, decidedBy = 'founder') {
  return _setStatus(id, 'approved', decidedBy, decisionNote);
}
function reject(id, decisionNote = null, decidedBy = 'founder') {
  return _setStatus(id, 'rejected', decidedBy, decisionNote);
}
function redirect(id, newAgent, decisionNote = null, decidedBy = 'founder') {
  if (!KNOWN_AGENTS.has(newAgent)) return null;
  // Mark current as redirected, record the redirect target in decision_note,
  // and create a fresh pending handoff to the new target.
  const original = getOne(id);
  if (!original) return null;
  _setStatus(id, 'redirected', decidedBy, `→ ${newAgent}: ${decisionNote || ''}`);
  const fresh = record({
    fromAgent: original.from_agent, toAgent: newAgent,
    reason: original.reason, suggestedAction: original.suggested_action,
    payload: original.payload, sourceRunId: original.source_run_id,
    sourceChatId: original.source_chat_id,
  });
  return { redirected_from: id, redirected_to: fresh.id, ...fresh };
}

function recordResult(id, result) {
  const sql = `UPDATE agent_handoffs SET status='executed', result=${_qJson(result)} WHERE id=${_q(id)};`;
  try { _psql(sql); } catch (_) {}
  return getOne(id);
}
function recordFailure(id, err) {
  const sql = `UPDATE agent_handoffs SET status='failed',
                       result=${_qJson({ error: String(err).slice(0, 1000) })}
                WHERE id=${_q(id)};`;
  try { _psql(sql); } catch (_) {}
  return getOne(id);
}

module.exports = {
  KNOWN_AGENTS, parseFromOutput,
  record, listPending, listRecent, countPending, getOne,
  approve, reject, redirect, recordResult, recordFailure,
};
