// cowork-proxy/agent-evals.js
// =====================================================================
// K3 · Training & Rating.  [cloud build]
// All public functions are now async.
// =====================================================================

const { query, queryValue, queryReturning, q } = require('./db');
const agentMemory = require('./agent-memory');

function qArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::text[]`;
  return `'{${arr.map(t => `"${String(t).replace(/"/g, '\\"')}"`).join(',')}}'::text[]`;
}
function qUuidArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::uuid[]`;
  return `'{${arr.map(t => String(t).replace(/'/g, "''")).join(',')}}'::uuid[]`;
}

// ── 1. Rating a past run ─────────────────────────────────────────────
async function rateRun({ runId, agent, score, dimension = 'overall', note = null, ratedBy = 'founder' }) {
  if (!runId || !agent) return { ok: false, error: 'runId + agent required' };
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    return { ok: false, error: 'score must be 1..5' };
  }
  try {
    const id = await queryReturning(`
      INSERT INTO agent_evals (agent, kind, run_id, score, dimension, note, rated_by)
      VALUES (${q(agent)}, 'rating', ${q(runId)}, ${score|0}, ${q(dimension)}, ${q(note)}, ${q(ratedBy)})
      RETURNING id::text;`);
    return { ok: true, id, agent, score, kind: 'rating' };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

// ── 2. Submitting a correction (auto-promotes to procedural memory) ─
async function submitCorrection({ runId, agent, originalOutput, correctedOutput, note = null, tags = [] }) {
  if (!agent || !correctedOutput) return { ok: false, error: 'agent + correctedOutput required' };
  const memContent = note
    ? `Correction: ${note}\n  Prefer: ${String(correctedOutput).slice(0, 600)}`
    : `Correction. Prefer this output:\n${String(correctedOutput).slice(0, 800)}`;
  const memWrite = await agentMemory.write({
    agent, type: 'procedural',
    content: memContent,
    tags: ['correction', ...(Array.isArray(tags) ? tags : [])],
    importance: 4,
    source: 'founder',
    sourceRunId: runId || null,
  });
  const memIds = memWrite.ok ? [memWrite.id] : [];

  try {
    const id = await queryReturning(`
      INSERT INTO agent_evals (agent, kind, run_id, original_output, corrected_output,
                                note, tags, memory_ids, rated_by)
      VALUES (${q(agent)}, 'correction', ${q(runId)},
              ${q(originalOutput ? String(originalOutput).slice(0, 4000) : null)},
              ${q(String(correctedOutput).slice(0, 4000))},
              ${q(note)}, ${qArr(tags)}, ${qUuidArr(memIds)}, 'founder')
      RETURNING id::text;`);
    return { ok: true, id, agent, kind: 'correction', memory_ids: memIds };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

// ── 3. Submitting an example (auto-promotes to semantic memory) ────
async function submitExample({ agent, content, tags = [], importance = 4, note = null }) {
  if (!agent || !content) return { ok: false, error: 'agent + content required' };
  const trimmed = String(content).slice(0, 1500);
  const memContent = note
    ? `Exemplar (${note}):\n${trimmed}`
    : `Exemplar — match this voice/style:\n${trimmed}`;
  const memWrite = await agentMemory.write({
    agent, type: 'semantic',
    content: memContent,
    tags: ['exemplar', ...(Array.isArray(tags) ? tags : [])],
    importance: Math.min(Math.max(importance | 0, 1), 5),
    source: 'founder',
  });
  const memIds = memWrite.ok ? [memWrite.id] : [];

  try {
    const id = await queryReturning(`
      INSERT INTO agent_evals (agent, kind, corrected_output, note, tags, memory_ids, rated_by)
      VALUES (${q(agent)}, 'example', ${q(trimmed)}, ${q(note)},
              ${qArr(tags)}, ${qUuidArr(memIds)}, 'founder')
      RETURNING id::text;`);
    return { ok: true, id, agent, kind: 'example', memory_ids: memIds };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function listRecent({ agent = null, kind = null, limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const filters = [];
  if (agent) filters.push(`agent = ${q(agent)}`);
  if (kind)  filters.push(`kind = ${q(kind)}`);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(e) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, kind, run_id::text, score, dimension, note, tags,
                  original_output, corrected_output, memory_ids,
                  rated_by, created_at::text
            FROM agent_evals ${where}
           ORDER BY created_at DESC LIMIT ${limit}) e;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

async function getKPIsForAgent(agent, daysBack = 7) {
  daysBack = Math.min(Math.max(parseInt(daysBack, 10) || 7, 1), 365);
  const sql = `
    WITH this_window AS (
      SELECT score, created_at FROM agent_evals
       WHERE agent = ${q(agent)} AND kind = 'rating'
         AND created_at >= NOW() - INTERVAL '${daysBack} days'
    ),
    prior_window AS (
      SELECT score FROM agent_evals
       WHERE agent = ${q(agent)} AND kind = 'rating'
         AND created_at >= NOW() - INTERVAL '${daysBack * 2} days'
         AND created_at <  NOW() - INTERVAL '${daysBack} days'
    ),
    counts AS (
      SELECT
        (SELECT COUNT(*)             FROM this_window)               AS this_count,
        (SELECT AVG(score)::numeric  FROM this_window)               AS this_avg,
        (SELECT COUNT(*)             FROM prior_window)              AS prior_count,
        (SELECT AVG(score)::numeric  FROM prior_window)              AS prior_avg,
        (SELECT COUNT(*)             FROM agent_evals
                WHERE agent = ${q(agent)} AND kind = 'correction'
                  AND created_at >= NOW() - INTERVAL '${daysBack} days') AS corrections,
        (SELECT COUNT(*)             FROM agent_evals
                WHERE agent = ${q(agent)} AND kind = 'example'
                  AND created_at >= NOW() - INTERVAL '${daysBack} days') AS examples
    )
    SELECT row_to_json(c) FROM counts c;`;
  let row;
  try { row = JSON.parse((await queryValue(sql)) || '{}'); } catch (_) { row = {}; }
  const lowSql = `
    SELECT COALESCE(json_agg(row_to_json(e)), '[]'::json) FROM (
      SELECT id::text, run_id::text, score, note, created_at::text
        FROM agent_evals
       WHERE agent = ${q(agent)} AND kind = 'rating' AND score <= 2
         AND created_at >= NOW() - INTERVAL '${daysBack} days'
       ORDER BY created_at DESC LIMIT 5
    ) e;`;
  let low; try { low = JSON.parse((await queryValue(lowSql)) || '[]'); } catch (_) { low = []; }

  const thisAvg  = row.this_avg  != null ? Number(row.this_avg) : null;
  const priorAvg = row.prior_avg != null ? Number(row.prior_avg) : null;
  const trend = (thisAvg != null && priorAvg != null)
    ? Math.round((thisAvg - priorAvg) * 100) / 100
    : null;
  return {
    agent,
    days_back: daysBack,
    rating_count: parseInt(row.this_count, 10) || 0,
    rating_avg:   thisAvg != null ? Math.round(thisAvg * 100) / 100 : null,
    prior_count:  parseInt(row.prior_count, 10) || 0,
    prior_avg:    priorAvg != null ? Math.round(priorAvg * 100) / 100 : null,
    trend,
    corrections:  parseInt(row.corrections, 10) || 0,
    examples:     parseInt(row.examples, 10) || 0,
    low_scoring:  low || [],
  };
}

async function getKPIsAll(daysBack = 7) {
  daysBack = Math.min(Math.max(parseInt(daysBack, 10) || 7, 1), 365);
  const sql = `
    SELECT COALESCE(json_agg(DISTINCT agent), '[]'::json)
      FROM agent_evals
     WHERE created_at >= NOW() - INTERVAL '${daysBack * 2} days';`;
  let agents = [];
  try { agents = JSON.parse((await queryValue(sql)) || '[]'); } catch (_) {}
  return await Promise.all(agents.map(a => getKPIsForAgent(a, daysBack)));
}

module.exports = {
  rateRun, submitCorrection, submitExample,
  listRecent, getKPIsForAgent, getKPIsAll,
};
