// cowork-proxy/knowledge-base.js
// =====================================================================
// K6 · Knowledge Base CRUD + recall + prompt-block renderer.
//
// Public API:
//   add({country, category, title, content, facts, source, sourceType,
//        tags, importance, status, verifiedBy})
//   update(id, {title, content, facts, tags, importance, status, source})
//   markVerified(id, verifiedBy)
//   markStale(id)
//   supersede(oldId, newPayload)             → creates new row, links chain
//   list({country, category, status, query, limit})
//   getOne(id)
//   remove(id)
//   recall({country, category, query, limit}) → array (active+verified ranked)
//   renderAsBlock({country, query, limit})    → "KNOWLEDGE BASE ..." prompt text
//   detectCountry(text)                       → 'UK' | 'CA' | ... | null
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
function _qJson(v) { return v == null ? `'{}'::jsonb` : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`; }

// Country normalisation. Map common spellings → canonical short code.
const COUNTRY_ALIASES = {
  uk: 'UK', 'united kingdom': 'UK', 'great britain': 'UK', england: 'UK', britain: 'UK',
  usa: 'USA', 'united states': 'USA', america: 'USA', us: 'USA',
  de: 'DE', germany: 'DE', deutschland: 'DE',
  au: 'AU', australia: 'AU',
  ca: 'CA', canada: 'CA',
  uae: 'UAE', emirates: 'UAE', dubai: 'UAE', 'abu dhabi': 'UAE',
  sa: 'SA', 'saudi arabia': 'SA', saudi: 'SA', ksa: 'SA',
  global: 'GLOBAL', any: 'GLOBAL',
};
function _normCountry(c) {
  if (!c) return null;
  const k = String(c).trim().toLowerCase();
  return COUNTRY_ALIASES[k] || c.toUpperCase();
}

const VALID_CATEGORIES = new Set(['exam','visa','milestone','regulator','timeline','cost','document','other']);
const VALID_STATUS = new Set(['active','draft','stale','superseded','rejected']);
const VALID_SOURCE_TYPE = new Set(['manual','parsed','web','inherited']);

// ── CRUD ────────────────────────────────────────────────────────────

function add({ country, category, title, content, facts = {}, source = null,
                sourceType = 'manual', tags = [], importance = 3,
                status = 'active', verifiedBy = null }) {
  if (!country || !category || !title || !content) {
    return { ok: false, error: 'country, category, title, content required' };
  }
  const cnt = _normCountry(country);
  const cat = String(category).toLowerCase();
  if (!VALID_CATEGORIES.has(cat)) return { ok: false, error: `bad category: ${cat}` };
  if (!VALID_STATUS.has(status)) return { ok: false, error: `bad status: ${status}` };
  if (!VALID_SOURCE_TYPE.has(sourceType)) sourceType = 'manual';
  const verifiedAt = verifiedBy ? 'NOW()' : 'NULL';
  try {
    const sql = `
      INSERT INTO knowledge_base
        (country, category, title, content, facts, source, source_type,
         status, verified_at, verified_by, tags, importance)
      VALUES
        (${_q(cnt)}, ${_q(cat)}, ${_q(title)}, ${_q(content)}, ${_qJson(facts)},
         ${_q(source)}, ${_q(sourceType)}, ${_q(status)}, ${verifiedAt},
         ${_q(verifiedBy)}, ${_qArr(tags)}, ${_q(importance)})
      RETURNING id::text;`;
    const id = _psql(sql).split(/[\r\n]+/)[0].trim();
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function update(id, patch = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const sets = [];
  if ('title'      in patch) sets.push(`title=${_q(patch.title)}`);
  if ('content'    in patch) sets.push(`content=${_q(patch.content)}`);
  if ('facts'      in patch) sets.push(`facts=${_qJson(patch.facts)}`);
  if ('tags'       in patch) sets.push(`tags=${_qArr(patch.tags)}`);
  if ('importance' in patch) sets.push(`importance=${_q(patch.importance)}`);
  if ('status'     in patch && VALID_STATUS.has(patch.status)) sets.push(`status=${_q(patch.status)}`);
  if ('source'     in patch) sets.push(`source=${_q(patch.source)}`);
  if ('category'   in patch && VALID_CATEGORIES.has(patch.category)) sets.push(`category=${_q(patch.category)}`);
  if ('country'    in patch) sets.push(`country=${_q(_normCountry(patch.country))}`);
  if (sets.length === 0) return { ok: false, error: 'no fields to update' };
  sets.push('updated_at=NOW()');
  try {
    _psql(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE id=${_q(id)};`);
    return { ok: true, entry: getOne(id) };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function markVerified(id, verifiedBy = 'founder') {
  try {
    _psql(`UPDATE knowledge_base SET status='active', verified_at=NOW(),
            verified_by=${_q(verifiedBy)}, updated_at=NOW() WHERE id=${_q(id)};`);
    return { ok: true, entry: getOne(id) };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

function markStale(id) {
  try {
    _psql(`UPDATE knowledge_base SET status='stale', updated_at=NOW() WHERE id=${_q(id)};`);
    return { ok: true, entry: getOne(id) };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

function supersede(oldId, newPayload) {
  // Insert the new row, then point the old row's superseded_by at it and
  // mark the old one 'superseded'.
  const inserted = add(newPayload);
  if (!inserted.ok) return inserted;
  try {
    _psql(`UPDATE knowledge_base
              SET status='superseded', superseded_by=${_q(inserted.id)}, updated_at=NOW()
            WHERE id=${_q(oldId)};`);
    return { ok: true, id: inserted.id, superseded: oldId };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

function remove(id) {
  try { _psql(`DELETE FROM knowledge_base WHERE id=${_q(id)};`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

function getOne(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(k) FROM (
      SELECT id::text, country, category, title, content, facts, source, source_type,
             status, verified_at::text, verified_by, superseded_by::text, tags,
             importance, created_at::text, updated_at::text, last_used_at::text, use_count
        FROM knowledge_base WHERE id = ${_q(id)}
    ) k;`;
  try { const out = _psql(sql); return out ? JSON.parse(out) : null; }
  catch (_) { return null; }
}

function list({ country = null, category = null, status = null, query = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const where = [];
  if (country)  where.push(`country = ${_q(_normCountry(country))}`);
  if (category) where.push(`category = ${_q(category)}`);
  if (status)   where.push(`status = ${_q(status)}`);
  if (query)    where.push(`(title ILIKE ${_q('%'+query+'%')} OR content ILIKE ${_q('%'+query+'%')})`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(k) ORDER BY importance DESC, updated_at DESC), '[]'::json)
    FROM (SELECT id::text, country, category, title, content, facts, source, source_type,
                 status, verified_at::text, verified_by, tags, importance,
                 created_at::text, updated_at::text, use_count
            FROM knowledge_base ${w}
           ORDER BY importance DESC, updated_at DESC LIMIT ${limit}) k;`;
  try { return JSON.parse(_psql(sql) || '[]'); } catch (_) { return []; }
}

// ── Recall (for prompt grounding) ───────────────────────────────────
// Active+verified entries first, scored by importance × recency, plus a
// keyword-match bonus when query is supplied. GLOBAL country always
// included as fallback context.
function recall({ country = null, category = null, query = null, limit = 8 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 30);
  const where = [`status IN ('active','draft')`];
  if (country) {
    const c = _normCountry(country);
    where.push(`(country = ${_q(c)} OR country = 'GLOBAL')`);
  }
  if (category) where.push(`category = ${_q(category)}`);
  let scoreExpr = `importance::float * (1.0 / (1.0 + EXTRACT(EPOCH FROM NOW() - last_used_at) / 2592000.0))`;
  if (query) {
    const safe = String(query).replace(/'/g, "''").slice(0, 200);
    scoreExpr += ` + CASE WHEN (title ILIKE '%${safe}%' OR content ILIKE '%${safe}%') THEN 5 ELSE 0 END`;
    // Boost when ANY query keyword matches a tag.
    const kws = String(query).toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 5);
    if (kws.length) {
      scoreExpr += ` + CASE WHEN tags && ${_qArr(kws)} THEN 3 ELSE 0 END`;
    }
  }
  const sql = `
    WITH ranked AS (
      SELECT id, country, category, title, content, facts, source, status,
             tags, importance, verified_at, last_used_at,
             (${scoreExpr}) AS score
        FROM knowledge_base
       WHERE ${where.join(' AND ')}
    )
    SELECT COALESCE(json_agg(row_to_json(r) ORDER BY score DESC, importance DESC), '[]'::json)
    FROM (SELECT id::text, country, category, title, content, facts, source, status,
                 tags, importance, verified_at::text, score
            FROM ranked ORDER BY score DESC, importance DESC LIMIT ${limit}) r;`;
  try {
    const arr = JSON.parse(_psql(sql) || '[]');
    if (arr.length) {
      const ids = arr.map(r => `'${r.id}'::uuid`).join(',');
      try {
        _psql(`UPDATE knowledge_base SET last_used_at=NOW(), use_count=use_count+1
                WHERE id IN (${ids});`);
      } catch (_) { /* non-fatal */ }
    }
    return arr;
  } catch (_) { return []; }
}

// ── Prompt-injectable block ─────────────────────────────────────────
function renderAsBlock({ country = null, query = null, limit = 6, category = null } = {}) {
  const rows = recall({ country, category, query, limit });
  if (!rows.length) return '';
  const header = country
    ? `KNOWLEDGE BASE — ${_normCountry(country)} (verified facts; cite when used):`
    : `KNOWLEDGE BASE (verified facts; cite when used):`;
  const lines = rows.map(r => {
    const v = r.verified_at ? '✓' : '·';
    const factSummary = (r.facts && Object.keys(r.facts).length)
      ? ` [${Object.entries(r.facts).slice(0,3).map(([k,v])=>`${k}=${v}`).join(', ')}]`
      : '';
    const src = r.source ? ` (src: ${String(r.source).slice(0,60)})` : '';
    const body = String(r.content || '').slice(0, 280);
    return `${v} [${r.country}/${r.category}] ${r.title}: ${body}${factSummary}${src}`;
  });
  return [header, ...lines].join('\n');
}

// ── Country detection from free text ────────────────────────────────
const COUNTRY_KEYWORDS = {
  UK:    ['uk','united kingdom','england','britain','british','ore','gdc','gmc','plab','nhs'],
  USA:   ['usa','united states','american','america','us ','nbde','inbde','ada','ecfmg','usmle'],
  DE:    ['germany','german','deutschland','approbation','fsp','kenntnis','telc'],
  AU:    ['australia','australian','adc','dha','ahpra','amc'],
  CA:    ['canada','canadian','ndeb','nbme','mccqe','iqd','iqap'],
  UAE:   ['uae','emirates','dubai','abu dhabi','dha exam','moh exam','dhcc'],
  SA:    ['saudi','ksa','riyadh','jeddah','scfhs','prometric saudi'],
};
function detectCountry(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  let best = null, bestHits = 0;
  for (const [code, kws] of Object.entries(COUNTRY_KEYWORDS)) {
    const hits = kws.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
    if (hits > bestHits) { best = code; bestHits = hits; }
  }
  return bestHits > 0 ? best : null;
}

module.exports = {
  add, update, markVerified, markStale, supersede, remove,
  getOne, list, recall, renderAsBlock, detectCountry,
  VALID_CATEGORIES: Array.from(VALID_CATEGORIES),
  VALID_STATUS: Array.from(VALID_STATUS),
};
