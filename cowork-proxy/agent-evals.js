// cowork-proxy/agent-evals.js
// =====================================================================
// K3 · Training & Rating.
//
// Every founder action (rate / correct / example) is stored in agent_evals
// AND auto-promoted to the right memory bucket so the agent picks it up
// on its next run.
//
//   rateRun        ratings → no memory write (just data for KPIs)
//   submitCorrection → procedural memory  ("when X, do Y not Z")
//   submitExample    → semantic memory    ("here's how my voice sounds")
//
// Public API:
//   rateRun({runId, agent, score, dimension?, note?, ratedBy?})
//   submitCorrection({runId, agent, originalOutput, correctedOutput, note?, tags?})
//   submitExample({agent, content, tags?, importance?, note?})
//   listRecent({agent, limit})
//   getKPIsForAgent(agent, daysBack)        → {rating_avg, rating_count, trend, low_scoring}
//   getKPIsAll(daysBack)                     → array per agent
// =====================================================================

const { spawnSync } = require('child_process');
const agentMemory = require('./agent-memory');

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
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function _qArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::text[]`;
  return `'{${arr.map(t => `"${String(t).replace(/"/g, '\\"')}"`).join(',')}}'::text[]`;
}
function _qUuidArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::uuid[]`;
  return `'{${arr.map(t => String(t).replace(/'/g, "''")).join(',')}}'::uuid[]`;
}

// ── 1. Rating a past run ─────────────────────────────────────────────
function rateRun({ runId, agent, score, dimension = 'overall', note = null, ratedBy = 'founder' }) {
  if (!runId || !agent) return { ok: false, error: 'runId + agent required' };
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    return { ok: false, error: 'score must be 1..5' };
  }
  try {
    const sql = `
      INSERT INTO agent_evals (agent, kind, run_id, score, dimension, note, rated_by)
      VALUES (${_q(agent)}, 'rating', ${_q(runId)}, ${score|0}, ${_q(dimension)}, ${_q(note)}, ${_q(ratedBy)})
      RETURNING id::text;`;
    const id = _psql(sql).split(/[\r\n]+/)[0].trim();
    return { ok: true, id, agent, score, kind: 'rating' };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// ── 2. Submitting a correction (auto-promotes to procedural memory) ─
function submitCorrection({ runId, agent, originalOutput, correctedOutput, note = null, tags = [] }) {
  if (!agent || !correctedOutput) return { ok: false, error: 'agent + correctedOutput required' };
  // Build a procedural memory entry distilled from the correction.
  const memContent = note
    ? `Correction: ${note}\n  Prefer: ${String(correctedOutput).slice(0, 600)}`
    : `Correction. Prefer this output:\n${String(correctedOutput).slice(0, 800)}`;
  const memWrite = agentMemory.write({
    agent, type: 'procedural',
    content: memContent,
    tags: ['correction', ...(Array.isArray(tags) ? tags : [])],
    importance: 4,
    source: 'founder',
    sourceRunId: runId || null,
  });
  const memIds = memWrite.ok ? [memWrite.id] : [];

  try {
    const sql = `
      INSERT INTO agent_evals (agent, kind, run_id, original_output, corrected_output,
                                note, tags, memory_ids, rated_by)
      VALUES (${_q(agent)}, 'correction', ${_q(runId)},
              ${_q(originalOutput ? String(originalOutput).slice(0, 4000) : null)},
              ${_q(String(correctedOutput).slice(0, 4000))},
              ${_q(note)}, ${_qArr(tags)}, ${_qUuidArr(memIds)}, 'founder')
      RETURNING id::text;`;
    const id = _psql(sql).split(/[\r\n]+/)[0].trim();
    return { ok: true, id, agent, kind: 'correction', memory_ids: memIds };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// ── 3. Submitting an example (auto-promotes to semantic memory) ────
function submitExample({ agent, content, tags = [], importance = 4, note = null }) {
  if (!agent || !content) return { ok: false, error: 'agent + content required' };
  // The example becomes a semantic memory tagged 'exemplar'.
  const trimmed = String(content).slice(0, 1500);
  const memContent = note
    ? `Exemplar (${note}):\n${trimmed}`
    : `Exemplar — match this voice/style:\n${trimmed}`;
  const memWrite = agentMemory.write({
    agent, type: 'semantic',
    content: memContent,
    tags: ['exemplar', ...(Array.isArray(tags) ? tags : [])],
    importance: Math.min(Math.max(importance | 0, 1), 5),
    source: 'founder',
  });
  const memIds = memWrite.ok ? [memWrite.id] : [];

  try {
    const sql = `
      INSERT INTO agent_evals (agent, kind, corrected_output, note, tags, memory_ids, rated_by)
      VALUES (${_q(agent)}, 'example', ${_q(trimmed)}, ${_q(note)},
              ${_qArr(tags)}, ${_qUuidArr(memIds)}, 'founder')
      RETURNING id::text;`;
    const id = _psql(sql).split(/[\r\n]+/)[0].trim();
    return { ok: true, id, agent, kind: 'example', memory_ids: memIds };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// ── 4. Recent evals (for the Train tab feed) ────────────────────────
function listRecent({ agent = null, kind = null, limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const filters = [];
  if (agent) filters.push(`agent = ${_q(agent)}`);
  if (kind)  filters.push(`kind = ${_q(kind)}`);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(e) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, kind, run_id::text, score, dimension, note, tags,
                  original_output, corrected_output, memory_ids,
                  rated_by, created_at::text
            FROM agent_evals ${where}
           ORDER BY created_at DESC LIMIT ${limit}) e;`;
  try { return JSON.parse(_psql(sql) || '[]'); } catch (_) { return []; }
}

// ── 5. KPIs ─────────────────────────────────────────────────────────
function getKPIsForAgent(agent, daysBack = 7) {
  daysBack = Math.min(Math.max(parseInt(daysBack, 10) || 7, 1), 365);
  const sql = `
    WITH this_window AS (
      SELECT score, created_at FROM agent_evals
       WHERE agent = ${_q(agent)} AND kind = 'rating'
         AND created_at >= NOW() - INTERVAL '${daysBack} days'
    ),
    prior_window AS (
      SELECT score FROM agent_evals
       WHERE agent = ${_q(agent)} AND kind = 'rating'
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
                WHERE agent = ${_q(agent)} AND kind = 'correction'
                  AND created_at >= NOW() - INTERVAL '${daysBack} days') AS corrections,
        (SELECT COUNT(*)             FROM agent_evals
                WHERE agent = ${_q(agent)} AND kind = 'example'
                  AND created_at >= NOW() - INTERVAL '${daysBack} days') AS examples
    )
    SELECT row_to_json(c) FROM counts c;`;
  let row;
  try { row = JSON.parse(_psql(sql) || '{}'); } catch (_) { row = {}; }
  // Low-scoring runs (≤2) for "go review these"
  const lowSql = `
    SELECT COALESCE(json_agg(row_to_json(e)), '[]'::json) FROM (
      SELECT id::text, run_id::text, score, note, created_at::text
        FROM agent_evals
       WHERE agent = ${_q(agent)} AND kind = 'rating' AND score <= 2
         AND created_at >= NOW() - INTERVAL '${daysBack} days'
       ORDER BY created_at DESC LIMIT 5
    ) e;`;
  let low; try { low = JSON.parse(_psql(lowSql) || '[]'); } catch (_) { low = []; }

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

function getKPIsAll(daysBack = 7) {
  daysBack = Math.min(Math.max(parseInt(daysBack, 10) || 7, 1), 365);
  // Get distinct agents with any eval activity in the window OR in priors,
  // so a column with "no ratings this week" still shows up.
  const sql = `
    SELECT COALESCE(json_agg(DISTINCT agent), '[]'::json)
      FROM agent_evals
     WHERE created_at >= NOW() - INTERVAL '${daysBack * 2} days';`;
  let agents = [];
  try { agents = JSON.parse(_psql(sql) || '[]'); } catch (_) {}
  return agents.map(a => getKPIsForAgent(a, daysBack));
}

module.exports = {
  rateRun, submitCorrection, submitExample,
  listRecent, getKPIsForAgent, getKPIsAll,
};
