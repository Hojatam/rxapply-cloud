// cowork-proxy/knowledge-base.js
// =====================================================================
// K6 · Knowledge Base CRUD + recall + prompt-block renderer.  [cloud build]
//
// All public functions are now async (pg under the hood). Callers must
// await. Module exports the same set of names as the local sandbox so
// the call surface stays familiar.
// =====================================================================

const { query, queryValue, queryReturning, q, qJson } = require('./db');

// Module-local array literal helper (legacy used `_qArr`; kept inline to
// not collide with the shared db.js qArr if signatures diverge later).
function qArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return `'{}'::text[]`;
  const escaped = arr.map(t => `"${String(t).replace(/"/g, '\\"')}"`).join(',');
  return `'{${escaped}}'::text[]`;
}
function qJsonOrEmpty(v) { return v == null ? `'{}'::jsonb` : qJson(v); }

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

async function add({ country, category, title, content, facts = {}, source = null,
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
        (${q(cnt)}, ${q(cat)}, ${q(title)}, ${q(content)}, ${qJsonOrEmpty(facts)},
         ${q(source)}, ${q(sourceType)}, ${q(status)}, ${verifiedAt},
         ${q(verifiedBy)}, ${qArr(tags)}, ${q(importance)})
      RETURNING id::text;`;
    const id = await queryReturning(sql);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

async function update(id, patch = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const sets = [];
  if ('title'      in patch) sets.push(`title=${q(patch.title)}`);
  if ('content'    in patch) sets.push(`content=${q(patch.content)}`);
  if ('facts'      in patch) sets.push(`facts=${qJsonOrEmpty(patch.facts)}`);
  if ('tags'       in patch) sets.push(`tags=${qArr(patch.tags)}`);
  if ('importance' in patch) sets.push(`importance=${q(patch.importance)}`);
  if ('status'     in patch && VALID_STATUS.has(patch.status)) sets.push(`status=${q(patch.status)}`);
  if ('source'     in patch) sets.push(`source=${q(patch.source)}`);
  if ('category'   in patch && VALID_CATEGORIES.has(patch.category)) sets.push(`category=${q(patch.category)}`);
  if ('country'    in patch) sets.push(`country=${q(_normCountry(patch.country))}`);
  if (sets.length === 0) return { ok: false, error: 'no fields to update' };
  sets.push('updated_at=NOW()');
  try {
    await query(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE id=${q(id)};`);
    return { ok: true, entry: await getOne(id) };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

async function markVerified(id, verifiedBy = 'founder') {
  try {
    await query(`UPDATE knowledge_base SET status='active', verified_at=NOW(),
                  verified_by=${q(verifiedBy)}, updated_at=NOW() WHERE id=${q(id)};`);
    return { ok: true, entry: await getOne(id) };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function markStale(id) {
  try {
    await query(`UPDATE knowledge_base SET status='stale', updated_at=NOW() WHERE id=${q(id)};`);
    return { ok: true, entry: await getOne(id) };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function supersede(oldId, newPayload) {
  // Insert the new row, then point the old row's superseded_by at it and
  // mark the old one 'superseded'.
  const inserted = await add(newPayload);
  if (!inserted.ok) return inserted;
  try {
    await query(`UPDATE knowledge_base
                    SET status='superseded', superseded_by=${q(inserted.id)}, updated_at=NOW()
                  WHERE id=${q(oldId)};`);
    return { ok: true, id: inserted.id, superseded: oldId };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function remove(id) {
  try { await query(`DELETE FROM knowledge_base WHERE id=${q(id)};`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function getOne(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(k) FROM (
      SELECT id::text, country, category, title, content, facts, source, source_type,
             status, verified_at::text, verified_by, superseded_by::text, tags,
             importance, created_at::text, updated_at::text, last_used_at::text, use_count
        FROM knowledge_base WHERE id = ${q(id)}
    ) k;`;
  try { const out = await queryValue(sql); return out ? JSON.parse(out) : null; }
  catch (_) { return null; }
}

async function list({ country = null, category = null, status = null, query: searchQuery = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const where = [];
  if (country)     where.push(`country = ${q(_normCountry(country))}`);
  if (category)    where.push(`category = ${q(category)}`);
  if (status)      where.push(`status = ${q(status)}`);
  if (searchQuery) where.push(`(title ILIKE ${q('%'+searchQuery+'%')} OR content ILIKE ${q('%'+searchQuery+'%')})`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(k) ORDER BY importance DESC, updated_at DESC), '[]'::json)
    FROM (SELECT id::text, country, category, title, content, facts, source, source_type,
                 status, verified_at::text, verified_by, tags, importance,
                 created_at::text, updated_at::text, use_count
            FROM knowledge_base ${w}
           ORDER BY importance DESC, updated_at DESC LIMIT ${limit}) k;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

// ── Recall (for prompt grounding) ───────────────────────────────────
// Active+verified entries first, scored by importance × recency, plus a
// keyword-match bonus when query is supplied. GLOBAL country always
// included as fallback context.
async function recall({ country = null, category = null, query: searchQuery = null, limit = 8 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 30);
  const where = [`status IN ('active','draft')`];
  if (country) {
    const c = _normCountry(country);
    where.push(`(country = ${q(c)} OR country = 'GLOBAL')`);
  }
  if (category) where.push(`category = ${q(category)}`);
  let scoreExpr = `importance::float * (1.0 / (1.0 + EXTRACT(EPOCH FROM NOW() - last_used_at) / 2592000.0))`;
  if (searchQuery) {
    const safe = String(searchQuery).replace(/'/g, "''").slice(0, 200);
    scoreExpr += ` + CASE WHEN (title ILIKE '%${safe}%' OR content ILIKE '%${safe}%') THEN 5 ELSE 0 END`;
    const kws = String(searchQuery).toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 5);
    if (kws.length) {
      scoreExpr += ` + CASE WHEN tags && ${qArr(kws)} THEN 3 ELSE 0 END`;
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
    const arr = JSON.parse((await queryValue(sql)) || '[]');
    if (arr.length) {
      const ids = arr.map(r => `'${r.id}'::uuid`).join(',');
      try {
        await query(`UPDATE knowledge_base SET last_used_at=NOW(), use_count=use_count+1
                       WHERE id IN (${ids});`);
      } catch (_) { /* non-fatal */ }
    }
    return arr;
  } catch (_) { return []; }
}

// ── Prompt-injectable block ─────────────────────────────────────────
async function renderAsBlock({ country = null, query: searchQuery = null, limit = 6, category = null } = {}) {
  const rows = await recall({ country, category, query: searchQuery, limit });
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
