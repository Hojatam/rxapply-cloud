// cowork-proxy/agent-memory.js
// =====================================================================
// K2 · Per-agent persistent memory.  [cloud build]
// All public functions are now async (pg under the hood).
// =====================================================================

const { query, queryValue, queryReturning, q } = require('./db');

function qArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::text[]`;
  const escaped = arr.map(t => `"${String(t).replace(/"/g, '\\"')}"`).join(',');
  return `'{${escaped}}'::text[]`;
}

const VALID_TYPES = new Set(['episodic', 'semantic', 'procedural']);

async function write({ agent, type, content, tags = [], importance = 3, source = 'auto',
                        sourceRunId = null, relatedTo = null }) {
  if (!agent || !type || !content) return { ok: false, error: 'agent + type + content required' };
  if (!VALID_TYPES.has(type)) return { ok: false, error: `type must be one of ${[...VALID_TYPES].join('|')}` };
  if (!Number.isFinite(importance) || importance < 1 || importance > 5) importance = 3;
  if (!Array.isArray(tags)) tags = [];
  const trimmed = String(content).slice(0, 1500);
  try {
    const sql = `
      INSERT INTO agent_memory (agent, type, content, tags, importance, source, source_run_id, related_to)
      VALUES (${q(agent)}, ${q(type)}, ${q(trimmed)}, ${qArr(tags)},
              ${importance|0}, ${q(source)}, ${q(sourceRunId)}, ${q(relatedTo)})
      RETURNING id::text;`;
    const id = await queryReturning(sql);
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function getOne(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(m) FROM (
      SELECT id::text, agent, type, content, tags, importance, source,
              source_run_id::text, related_to,
              created_at::text, last_used_at::text, use_count
        FROM agent_memory WHERE id = ${q(id)}
    ) m;`;
  try { const out = await queryValue(sql); return out ? JSON.parse(out) : null; }
  catch (_) { return null; }
}

async function list(agent, { type = null, limit = 50, query: searchQuery = null } = {}) {
  if (!agent) return [];
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const filters = [`agent = ${q(agent)}`];
  if (type) filters.push(`type = ${q(type)}`);
  if (searchQuery) filters.push(`content ILIKE ${q('%' + searchQuery + '%')}`);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(m) ORDER BY importance DESC, last_used_at DESC), '[]'::json)
    FROM (SELECT id::text, agent, type, content, tags, importance, source,
                 created_at::text, last_used_at::text, use_count, related_to
          FROM agent_memory
          WHERE ${filters.join(' AND ')}
          ORDER BY importance DESC, last_used_at DESC
          LIMIT ${limit}) m;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

async function update(id, { content, tags, importance } = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const sets = [];
  if (typeof content === 'string')  sets.push(`content = ${q(content.slice(0, 1500))}`);
  if (Array.isArray(tags))           sets.push(`tags = ${qArr(tags)}`);
  if (Number.isFinite(importance) && importance >= 1 && importance <= 5) {
    sets.push(`importance = ${importance|0}`);
  }
  if (sets.length === 0) return { ok: false, error: 'no fields to update' };
  try {
    await query(`UPDATE agent_memory SET ${sets.join(', ')} WHERE id = ${q(id)};`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function remove(id) {
  if (!id) return { ok: false, error: 'id required' };
  try {
    await query(`DELETE FROM agent_memory WHERE id = ${q(id)};`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function forget(agent, searchQuery) {
  if (!agent || !searchQuery) return { ok: false, error: 'agent + query required' };
  try {
    const r = await query(`DELETE FROM agent_memory
                             WHERE agent = ${q(agent)}
                               AND content ILIKE ${q('%' + searchQuery + '%')};`);
    return { ok: true, removed: r.rowCount || 0 };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function recall(agent, { limit = 8, types = null, tags = [], queryKeywords = [] } = {}) {
  if (!agent) return [];
  limit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 50);
  const filters = [`agent = ${q(agent)}`];
  if (Array.isArray(types) && types.length > 0) {
    const list = types.filter(t => VALID_TYPES.has(t)).map(q).join(',');
    if (list) filters.push(`type IN (${list})`);
  }
  const tagBonus = (Array.isArray(tags) && tags.length > 0)
    ? `(SELECT COALESCE(SUM(CASE WHEN tags && ${qArr(tags)} THEN 0.5 ELSE 0 END), 0))`
    : '0';
  const kwBonus = (Array.isArray(queryKeywords) && queryKeywords.length > 0)
    ? queryKeywords.map(k => `(CASE WHEN content ILIKE ${q('%' + k + '%')} THEN 1.0 ELSE 0 END)`).join(' + ')
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
  try { recalled = JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
  if (recalled.length > 0) {
    try {
      const ids = recalled.map(r => `'${r.id}'`).join(',');
      await query(`UPDATE agent_memory
                     SET last_used_at = NOW(), use_count = use_count + 1
                   WHERE id IN (${ids});`);
    } catch (_) { /* non-fatal */ }
  }
  return recalled;
}

async function renderAsBlock(agent, { limit = 8, tags = [], queryKeywords = [] } = {}) {
  const items = await recall(agent, { limit, tags, queryKeywords });
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

function summarizeForEpisodic({ agent, action, output, durationMs, costUsd, topic }) {
  const date = new Date().toISOString().slice(0, 10);
  const parts = [`On ${date}, ${agent} ran ${action}`];
  if (topic) parts.push(`about "${String(topic).slice(0, 80)}"`);
  if (Number.isFinite(durationMs)) parts.push(`(${durationMs}ms`);
  if (Number.isFinite(costUsd) && costUsd > 0) parts.push(`· $${costUsd.toFixed(4)})`);
  else if (Number.isFinite(durationMs)) parts.push(')');
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
