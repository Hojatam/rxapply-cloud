// cowork-proxy/agent-handoffs.js
// =====================================================================
// K4 · Agent-to-agent handoff requests.  [cloud build]
// All public functions are now async (except parseFromOutput which has
// no DB I/O). KNOWN_AGENTS export unchanged.
// =====================================================================

const { query, queryValue, queryReturning, q, qJson } = require('./db');

const KNOWN_AGENTS = new Set([
  'pooya','sepehr','goyesh','avang','ramin',
  'rahnama','rahbar','bineh','mehrban',
  'roya','shahed','dadbeh','nasim',
  'ravi','zirak','paya','kherad',
  'bidar','davari','payvand','mehmandar',
  'afshin','compose-ig','cross-post',
]);

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

async function record({ fromAgent, toAgent, reason = null, suggestedAction = null,
                         payload = null, sourceRunId = null, sourceChatId = null }) {
  if (!fromAgent || !toAgent) return { ok: false, error: 'fromAgent + toAgent required' };
  if (!KNOWN_AGENTS.has(toAgent)) return { ok: false, error: `unknown to_agent: ${toAgent}` };
  try {
    const id = await queryReturning(`
      INSERT INTO agent_handoffs (from_agent, to_agent, reason, suggested_action,
                                   payload, source_run_id, source_chat_id)
      VALUES (${q(fromAgent)}, ${q(toAgent)}, ${q(reason)}, ${q(suggestedAction)},
              ${qJson(payload)}, ${q(sourceRunId)}, ${q(sourceChatId)})
      RETURNING id::text;`);
    return { ok: true, id, status: 'pending' };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function listPending({ limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(h) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, from_agent, to_agent, reason, suggested_action,
                  payload, source_run_id::text, status, created_at::text
            FROM agent_handoffs
           WHERE status = 'pending'
           ORDER BY created_at DESC LIMIT ${limit}) h;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

async function listRecent({ limit = 30, agent = null } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const where = agent ? `WHERE from_agent = ${q(agent)} OR to_agent = ${q(agent)}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(h) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, from_agent, to_agent, reason, suggested_action,
                  status, decided_at::text, decision_note, created_at::text
            FROM agent_handoffs ${where}
           ORDER BY created_at DESC LIMIT ${limit}) h;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

async function countPending() {
  try {
    const out = await queryValue(`SELECT COUNT(*) FROM agent_handoffs WHERE status='pending';`);
    return parseInt(out, 10) || 0;
  } catch (_) { return 0; }
}

async function getOne(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(h) FROM (
      SELECT id::text, from_agent, to_agent, reason, suggested_action, payload,
              source_run_id::text, source_chat_id::text, status,
              decided_at::text, decided_by, decision_note, result,
              created_at::text
        FROM agent_handoffs WHERE id = ${q(id)}
    ) h;`;
  try { const out = await queryValue(sql); return out ? JSON.parse(out) : null; }
  catch (_) { return null; }
}

async function _setStatus(id, status, decidedBy = 'founder', decisionNote = null) {
  await query(`
    UPDATE agent_handoffs
       SET status = ${q(status)}, decided_at = NOW(),
           decided_by = ${q(decidedBy)}, decision_note = ${q(decisionNote)}
     WHERE id = ${q(id)} AND status = 'pending';`);
  return await getOne(id);
}

async function approve(id, decisionNote = null, decidedBy = 'founder') {
  return await _setStatus(id, 'approved', decidedBy, decisionNote);
}
async function reject(id, decisionNote = null, decidedBy = 'founder') {
  return await _setStatus(id, 'rejected', decidedBy, decisionNote);
}
async function redirect(id, newAgent, decisionNote = null, decidedBy = 'founder') {
  if (!KNOWN_AGENTS.has(newAgent)) return null;
  const original = await getOne(id);
  if (!original) return null;
  await _setStatus(id, 'redirected', decidedBy, `→ ${newAgent}: ${decisionNote || ''}`);
  const fresh = await record({
    fromAgent: original.from_agent, toAgent: newAgent,
    reason: original.reason, suggestedAction: original.suggested_action,
    payload: original.payload, sourceRunId: original.source_run_id,
    sourceChatId: original.source_chat_id,
  });
  return { redirected_from: id, redirected_to: fresh.id, ...fresh };
}

async function recordResult(id, result) {
  try { await query(`UPDATE agent_handoffs SET status='executed', result=${qJson(result)} WHERE id=${q(id)};`); }
  catch (_) {}
  return await getOne(id);
}
async function recordFailure(id, err) {
  try { await query(`UPDATE agent_handoffs SET status='failed',
                              result=${qJson({ error: String(err).slice(0, 1000) })}
                       WHERE id=${q(id)};`); }
  catch (_) {}
  return await getOne(id);
}

module.exports = {
  KNOWN_AGENTS, parseFromOutput,
  record, listPending, listRecent, countPending, getOne,
  approve, reject, redirect, recordResult, recordFailure,
};
