// cowork-proxy/agent-memory.js
// =====================================================================
// K2 · Per-agent persistent memory.
//
// Three types per agent:
//   episodic    autobiographical: past runs / chats
//   semantic    facts the agent should know about
//   procedural  rules / preferences / corrections
//
// Public API:
//   write({agent, type, content, tags, importance, source, ...})
//   recall(agent, {limit, tags, types})  → array, importance × recency ranked
//   renderAsBlock(agent, {limit, tags})  → "MEMORY ..." prompt-injectable text
//   list(agent, {type, limit})            → for inspection (UI)
//   getOne(id)
//   update(id, {content, tags, importance})
//   remove(id)
//   forget(agent, query)                  → delete by content match
//
// Helpers:
//   summarizeForEpisodic(role, action, output, durationMs, costUsd) → string
//
// Retrieval strategy:
//   1. Filter by agent + (optional types[]) + (optional tags[])
//   2. Score = importance × recency_decay (last_used_at) + tag_match_bonus
//   3. Take top-K (default 8)
//   4. Bump last_used_at + use_count for retrieved entries (so heavy-used
//      memories surface; never-used drop in rank).
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
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function _qArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::text[]`;
  const escaped = arr.map(t => `"${String(t).replace(/"/g, '\\"')}"`).join(',');
  return `'{${escaped}}'::text[]`;
}

// ── Public API ─────────────────────────────────────────────────────

const VALID_TYPES = new Set(['episodic', 'semantic', 'procedural']);

function write({ agent, type, content, tags = [], importance = 3, source = 'auto',
                  sourceRunId = null, relatedTo = null }) {
  if (!agent || !type || !content) {
    return { ok: false, error: 'agent + type + content required' };
  }
  if (!VALID_TYPES.has(type)) return { ok: false, error: `type must be one of ${[...VALID_TYPES].join('|')}` };
  if (!Number.isFinite(importance) || importance < 1 || importance > 5) importance = 3;
  if (!Array.isArray(tags)) tags = [];
  // Cap content size to keep memory blocks tractable in prompts.
  const trimmed = String(content).slice(0, 1500);

  try {
    const sql = `
      INSERT INTO agent_memory (agent, type, content, tags, importance, source, source_run_id, related_to)
      VALUES (${_q(agent)}, ${_q(type)}, ${_q(trimmed)}, ${_qArr(tags)},
              ${importance|0}, ${_q(source)}, ${_q(sourceRunId)}, ${_q(relatedTo)})
      RETURNING id::text;`;
    const id = _psql(sql).split(/[\r\n]+/)[0].trim();
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function getOne(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(m) FROM (
      SELECT id::text, agent, type, content, tags, importance, source,
              source_run_id::text, related_to,
              created_at::text, last_used_at::text, use_count
        FROM agent_memory WHERE id = ${_q(id)}
    ) m;`;
  try {
    const out = _psql(sql);
    return out ? JSON.parse(out) : null;
  } catch (_) { return null; }
}

function list(agent, { type = null, limit = 50, query = null } = {}) {
  if (!agent) return [];
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const filters = [`agent = ${_q(agent)}`];
  if (type) filters.push(`type = ${_q(type)}`);
  if (query) filters.push(`content ILIKE ${_q('%' + query + '%')}`);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(m) ORDER BY importance DESC, last_used_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, type, content, tags, importance, source,
                 created_at::text, last_used_at::text, use_count, related_to
          FROM agent_memory
          WHERE ${filters.join(' AND ')}
          ORDER BY importance DESC, last_used_at DESC
          LIMIT ${limit}) m;`;
  try { return JSON.parse(_psql(sql) || '[]'); } catch (_) { return []; }
}

function update(id, { content, tags, importance } = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const sets = [];
  if (typeof content === 'string')  sets.push(`content = ${_q(content.slice(0, 1500))}`);
  if (Array.isArray(tags))           sets.push(`tags = ${_qArr(tags)}`);
  if (Number.isFinite(importance) && importance >= 1 && importance <= 5) {
    sets.push(`importance = ${importance|0}`);
  }
  if (sets.length === 0) return { ok: false, error: 'no fields to update' };
  try {
    _psql(`UPDATE agent_memory SET ${sets.join(', ')} WHERE id = ${_q(id)};`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function remove(id) {
  if (!id) return { ok: false, error: 'id required' };
  try {
    _psql(`DELETE FROM agent_memory WHERE id = ${_q(id)};`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// Bulk delete by content match (used by /memory/forget for "forget about X")
function forget(agent, query) {
  if (!agent || !query) return { ok: false, error: 'agent + query required' };
  try {
    const out = _psql(`DELETE FROM agent_memory
                        WHERE agent = ${_q(agent)}
                          AND content ILIKE ${_q('%' + query + '%')}
                       RETURNING id;`);
    const removed = out ? out.split(/[\r\n]+/).filter(Boolean).length : 0;
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// ── Recall: top-K relevant memories for the next prompt ─────────────
//
// Scoring (computed in SQL for speed):
//   score = importance * 2
//         + (1 / (1 + EXTRACT(EPOCH FROM (NOW() - last_used_at)) / 86400))   -- recency
//         + tag_match_bonus    -- 0.5 per matching tag
//         + content_match_bonus -- 1.0 if any query keyword in content
//
function recall(agent, { limit = 8, types = null, tags = [], queryKeywords = [] } = {}) {
  if (!agent) return [];
  limit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 50);
  const filters = [`agent = ${_q(agent)}`];
  if (Array.isArray(types) && types.length > 0) {
    const list = types.filter(t => VALID_TYPES.has(t)).map(_q).join(',');
    if (list) filters.push(`type IN (${list})`);
  }
  // Build the scoring expression
  const tagBonus = (Array.isArray(tags) && tags.length > 0)
    ? `(SELECT COALESCE(SUM(CASE WHEN tags && ${_qArr(tags)} THEN 0.5 ELSE 0 END), 0))`
    : '0';
  const kwBonus = (Array.isArray(queryKeywords) && queryKeywords.length > 0)
    ? queryKeywords.map(k => `(CASE WHEN content ILIKE ${_q('%' + k + '%')} THEN 1.0 ELSE 0 END)`).join(' + ')
    : '0';

  const sql = `
    WITH scored AS (
      SELECT id::text, agent, type, content, tags, importance, source,
              created_at::text, last_used_at::text, use_count, related_to,
              (importance * 2.0
                + (1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - last_used_at)) / 86400.0))
                + ${tagBonus}
                + ${kwBonus}
              ) AS score
        FROM agent_memory
       WHERE ${filters.join(' AND ')}
    )
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY score DESC), '[]'::json)
    FROM (SELECT * FROM scored ORDER BY score DESC LIMIT ${limit}) s;`;
  let recalled;
  try { recalled = JSON.parse(_psql(sql) || '[]'); } catch (_) { return []; }

  // Bump last_used + use_count on retrieved rows (best-effort, fire-and-forget).
  if (recalled.length > 0) {
    try {
      const ids = recalled.map(r => `'${r.id}'`).join(',');
      _psql(`UPDATE agent_memory
                SET last_used_at = NOW(), use_count = use_count + 1
              WHERE id IN (${ids});`);
    } catch (_) { /* non-fatal */ }
  }
  return recalled;
}

// ── Render as a prompt block ────────────────────────────────────────
//
// Output is a plain-text "MEMORY" block, organized by type, that the caller
// splices into a system prompt. Empty memory → empty string (no clutter).
function renderAsBlock(agent, { limit = 8, tags = [], queryKeywords = [] } = {}) {
  const items = recall(agent, { limit, tags, queryKeywords });
  if (!items || items.length === 0) return '';
  const byType = { episodic: [], semantic: [], procedural: [] };
  for (const m of items) {
    if (byType[m.type]) byType[m.type].push(m);
  }
  const lines = [];
  lines.push('=== MEMORY (your past with this brand — strict precedence over guesswork) ===');
  if (byType.semantic.length > 0) {
    lines.push('FACTS YOU KNOW:');
    byType.semantic.forEach(m => lines.push(`  · ${m.content}`));
  }
  if (byType.procedural.length > 0) {
    lines.push('RULES & CORRECTIONS YOU LEARNED:');
    byType.procedural.forEach(m => lines.push(`  · ${m.content}`));
  }
  if (byType.episodic.length > 0) {
    lines.push('RECENT INTERACTIONS:');
    byType.episodic.slice(0, 5).forEach(m => lines.push(`  · ${m.content}`));
  }
  lines.push('=== END MEMORY ===');
  return lines.join('\n');
}

// ── Helpers for auto-write hooks ────────────────────────────────────
//
// summarizeForEpisodic: short narrative the proxy stores after each
// successful agent run. Keeps the agent's autobiography terse.
function summarizeForEpisodic({ agent, action, output, durationMs, costUsd, topic }) {
  const date = new Date().toISOString().slice(0, 10);
  const parts = [`On ${date}, ${agent} ran ${action}`];
  if (topic) parts.push(`about "${String(topic).slice(0, 80)}"`);
  if (Number.isFinite(durationMs)) parts.push(`(${durationMs}ms`);
  if (Number.isFinite(costUsd) && costUsd > 0) parts.push(`· $${costUsd.toFixed(4)})`);
  else if (Number.isFinite(durationMs)) parts.push(')');
  // One concrete output crumb (truncated)
  if (output && typeof output === 'object') {
    const summary = output.summary || output.verdict_reason || output.angle ||
                    (Array.isArray(output.languages) ? '3-language trio' :
                     output.languages ? '3-language trio' :
                     (output.candidates ? `${output.candidates} candidates` :
                      (output.events ? `${output.events} events` :
                       (output.diffs ? `${output.diffs} diffs` :
                        (output.spikes ? `${output.spikes} spikes` : null)))));
    if (summary) parts.push(`— ${String(summary).slice(0, 120)}`);
  }
  return parts.join(' ').replace(/  +/g, ' ');
}

module.exports = {
  write, list, getOne, update, remove, forget,
  recall, renderAsBlock, summarizeForEpisodic,
};
