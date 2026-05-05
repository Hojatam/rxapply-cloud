// cowork-proxy/knowledge-base.js
// =====================================================================
// K6 · Knowledge Base CRUD + recall + prompt-block renderer.  [cloud build]
//
// All public functions are now async (pg under the hood). Callers must
// await. Module exports the same set of names as the local sandbox so
// the call surface stays familiar.
// =====================================================================

const { query, queryValue, queryReturning, q, qJson } = require('./db');
const embeddings = require('./embeddings');                   // M106 · semantic recall

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

// M106 · Compute & persist an embedding for a single row. Fire-and-forget
// from the caller's perspective (background promise). Failures are persisted
// to embedding_status='failed' with the error message so the dashboard can
// surface them and the founder can retry. Never throws.
async function embedRowAsync(id) {
  try {
    if (!embeddings.hasKey()) {
      await query(`UPDATE knowledge_base SET embedding_status='skipped',
                   embedding_error='OPENAI_API_KEY not set', embedded_at=now()
                   WHERE id=${q(id)};`);
      return;
    }
    const row = await getOne(id);
    if (!row) return;
    const text = embeddings.buildEmbedText(row);
    if (!text) {
      await query(`UPDATE knowledge_base SET embedding_status='skipped',
                   embedding_error='empty content', embedded_at=now()
                   WHERE id=${q(id)};`);
      return;
    }
    const r = await embeddings.embed(text);
    if (!r.ok) {
      const errSafe = String(r.error || r.code || 'unknown').replace(/'/g, "''").slice(0, 300);
      await query(`UPDATE knowledge_base SET embedding_status='failed',
                   embedding_error='${errSafe}', embedded_at=now()
                   WHERE id=${q(id)};`);
      return;
    }
    const vec = embeddings.toPgVectorLiteral(r.vector);
    await query(`UPDATE knowledge_base
                    SET embedding=${vec},
                        embedding_status='ready',
                        embedding_error=NULL,
                        embedding_model=${q(r.model || embeddings.modelId())},
                        embedded_at=now()
                  WHERE id=${q(id)};`);
  } catch (e) {
    try {
      const errSafe = String(e.message || 'unknown').replace(/'/g, "''").slice(0, 300);
      await query(`UPDATE knowledge_base SET embedding_status='failed',
                   embedding_error='${errSafe}', embedded_at=now()
                   WHERE id=${q(id)};`);
    } catch (_) {}
  }
}

// M106 · Backfill: process up to `limit` pending rows in one batch call.
// Returns counts so the dashboard can show progress.
async function backfillEmbeddings({ limit = 50 } = {}) {
  if (!embeddings.hasKey()) {
    return { ok: false, error: 'OPENAI_API_KEY not set; cannot embed' };
  }
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  // Pick up `pending` rows; oldest-pending first so the backlog drains FIFO.
  const json = await queryValue(`
    SELECT COALESCE(json_agg(row_to_json(r) ORDER BY created_at ASC), '[]'::json) FROM (
      SELECT id::text, country, category, topic, subtopic, title, content, facts, tags
        FROM knowledge_base
       WHERE embedding_status = 'pending'
       ORDER BY created_at ASC
       LIMIT ${limit}
    ) r;`);
  const rows = JSON.parse(json || '[]');
  if (!rows.length) return { ok: true, processed: 0, succeeded: 0, failed: 0, cost_usd: 0, remaining: 0 };

  const texts = rows.map(r => embeddings.buildEmbedText(r));
  const r = await embeddings.embedBatch(texts);
  if (!r.ok) {
    // Mark these rows as failed so they don't block the queue forever.
    // The founder can retry by clicking Backfill again (the row goes back
    // to 'pending' on the next /update).
    const ids = rows.map(x => `'${x.id}'::uuid`).join(',');
    const errSafe = String(r.error || r.code || 'embed batch failed').replace(/'/g, "''").slice(0, 300);
    await query(`UPDATE knowledge_base SET embedding_status='failed',
                 embedding_error='${errSafe}', embedded_at=now()
                 WHERE id IN (${ids});`);
    return { ok: false, error: r.error, failed: rows.length };
  }

  // Persist each vector individually — pgvector literals are large so a
  // multi-row UPDATE would balloon the SQL.
  let succeeded = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    const vec = embeddings.toPgVectorLiteral(r.vectors[i]);
    try {
      await query(`UPDATE knowledge_base
                      SET embedding=${vec},
                          embedding_status='ready',
                          embedding_error=NULL,
                          embedding_model=${q(r.model || embeddings.modelId())},
                          embedded_at=now()
                    WHERE id=${q(id)};`);
      succeeded++;
    } catch (_) { /* per-row failure stays as 'pending'; will retry next run */ }
  }

  const remaining = await queryValue(`SELECT COUNT(*)::int FROM knowledge_base WHERE embedding_status='pending';`);
  return {
    ok: true,
    processed: rows.length,
    succeeded,
    failed: rows.length - succeeded,
    cost_usd: r.cost_usd,
    tokens: r.tokens,
    model: r.model,
    remaining: parseInt(remaining, 10) || 0,
  };
}

// M108 · Bulk re-tag. Given a filter (country/topic/subtopic/status/query)
// and a patch (any subset of country/topic/subtopic/status/importance/tags
// add/remove), apply to all matching rows. Always supports dryRun=true so
// the founder can preview before committing. Tags can be:
//   tags_add:    [array]   — append to existing tags (deduped)
//   tags_remove: [array]   — remove specific tags
//   tags:        [array]   — replace tags entirely
async function bulkUpdate({ filter = {}, patch = {}, dryRun = true, updatedBy = null } = {}) {
  const conds = [];
  if (filter.country)  conds.push(`country = ${q(_normCountry(filter.country))}`);
  if (filter.topic)    conds.push(`(topic = ${q(String(filter.topic).toLowerCase())} OR category = ${q(String(filter.topic).toLowerCase())})`);
  if (filter.subtopic) conds.push(`subtopic = ${q(String(filter.subtopic).toLowerCase())}`);
  if (filter.status)   conds.push(`status = ${q(filter.status)}`);
  if (filter.query) {
    const safe = String(filter.query).replace(/'/g, "''").slice(0, 200);
    conds.push(`(title ILIKE '%${safe}%' OR content ILIKE '%${safe}%')`);
  }
  if (Array.isArray(filter.ids) && filter.ids.length) {
    const idsSql = filter.ids.map(s => q(s)).join(',');
    conds.push(`id IN (${idsSql})`);
  }
  if (!conds.length) return { ok: false, error: 'filter required (refusing to bulk-update entire table)' };
  const where = conds.join(' AND ');

  // Preview: pull all matching rows so the founder sees exactly what changes
  const previewJson = await queryValue(`
    SELECT COALESCE(json_agg(row_to_json(k) ORDER BY country, topic, subtopic, title), '[]'::json) FROM (
      SELECT id::text, country, category, topic, subtopic, title, status, importance, tags
        FROM knowledge_base WHERE ${where}
      LIMIT 500
    ) k;`);
  const matched = JSON.parse(previewJson || '[]');
  if (!matched.length) return { ok: true, dry_run: dryRun, matched_count: 0, preview: [] };
  if (dryRun) return { ok: true, dry_run: true, matched_count: matched.length, preview: matched };

  // Build the SET clause from patch
  const sets = [];
  let affectsEmbedding = false;
  if ('country'    in patch) sets.push(`country = ${q(_normCountry(patch.country))}`);
  if ('topic'      in patch) sets.push(`topic = ${patch.topic == null ? 'NULL' : q(String(patch.topic).toLowerCase())}`);
  if ('subtopic'   in patch) sets.push(`subtopic = ${patch.subtopic == null ? 'NULL' : q(String(patch.subtopic).toLowerCase())}`);
  if ('category'   in patch && VALID_CATEGORIES.has(patch.category)) sets.push(`category = ${q(patch.category)}`);
  if ('status'     in patch && VALID_STATUS.has(patch.status))      sets.push(`status = ${q(patch.status)}`);
  if ('importance' in patch) sets.push(`importance = ${parseInt(patch.importance, 10) || 3}`);
  if ('tags' in patch && Array.isArray(patch.tags)) {
    sets.push(`tags = ${qArr(patch.tags)}`);
    affectsEmbedding = true;
  }
  if (Array.isArray(patch.tags_add) && patch.tags_add.length) {
    // Append unique tags. Postgres array_cat + de-dup via subquery.
    const newTags = qArr(patch.tags_add);
    sets.push(`tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(tags || ${newTags})))`);
    affectsEmbedding = true;
  }
  if (Array.isArray(patch.tags_remove) && patch.tags_remove.length) {
    // Remove specific tags from the array.
    const rmTags = qArr(patch.tags_remove);
    sets.push(`tags = (SELECT ARRAY(SELECT UNNEST(tags) EXCEPT SELECT UNNEST(${rmTags})))`);
    affectsEmbedding = true;
  }
  if (updatedBy) sets.push(`updated_by = ${q(updatedBy)}`);
  if (!sets.length) return { ok: false, error: 'patch is empty' };
  sets.push(`updated_at = NOW()`);
  if (affectsEmbedding) sets.push(`embedding_status = 'pending'`, `embedding_error = NULL`);

  try {
    await query(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE ${where};`);
    // Queue re-embed for affected rows so semantic recall stays accurate.
    if (affectsEmbedding) {
      for (const r of matched) {
        embedRowAsync(r.id);
      }
    }
    return { ok: true, dry_run: false, matched_count: matched.length, applied: true, embed_queued: affectsEmbedding };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

async function embeddingsStatus() {
  const json = await queryValue(`
    SELECT json_build_object(
      'total',   COUNT(*)::int,
      'ready',   COUNT(*) FILTER (WHERE embedding_status = 'ready')::int,
      'pending', COUNT(*) FILTER (WHERE embedding_status = 'pending')::int,
      'failed',  COUNT(*) FILTER (WHERE embedding_status = 'failed')::int,
      'skipped', COUNT(*) FILTER (WHERE embedding_status = 'skipped')::int
    ) FROM knowledge_base;`);
  let stats; try { stats = JSON.parse(json || '{}'); } catch (_) { stats = {}; }
  return {
    ok: true,
    has_key: embeddings.hasKey(),
    model: embeddings.modelId(),
    dim: embeddings.dim(),
    ...stats,
  };
}

async function add({ country, category = null, topic = null, subtopic = null,
                     title, content, facts = {}, source = null,
                     sourceType = 'manual', tags = [], importance = 3,
                     status = 'active', verifiedBy = null,
                     parentId = null, updatedBy = null } = {}) {
  if (!country || !title || !content) {
    return { ok: false, error: 'country, title, content required' };
  }
  // M105 · topic is the new primary axis. category stays for back-compat.
  // If only category was supplied, mirror it into topic. If only topic was
  // supplied, derive a legacy category for old code paths.
  if (!topic && category) topic = category;
  if (!category && topic) category = (VALID_CATEGORIES.has(topic) ? topic : 'other');
  if (!topic) topic = 'other';

  const cnt = _normCountry(country);
  const cat = String(category).toLowerCase();
  // Allow any topic_slug — taxonomy is editable from the dashboard. We just
  // enforce a sane string. Legacy `category` column still expects an enum
  // value, so we coerce when the topic isn't an old enum member.
  const catSafe = VALID_CATEGORIES.has(cat) ? cat : 'other';
  if (!VALID_STATUS.has(status)) return { ok: false, error: `bad status: ${status}` };
  if (!VALID_SOURCE_TYPE.has(sourceType)) sourceType = 'manual';
  const verifiedAt = verifiedBy ? 'NOW()' : 'NULL';
  try {
    const sql = `
      INSERT INTO knowledge_base
        (country, category, topic, subtopic, parent_id, title, content, facts, source, source_type,
         status, verified_at, verified_by, tags, importance, updated_by)
      VALUES
        (${q(cnt)}, ${q(catSafe)}, ${q(String(topic).toLowerCase())},
         ${subtopic ? q(String(subtopic).toLowerCase()) : 'NULL'},
         ${parentId ? q(parentId) : 'NULL'},
         ${q(title)}, ${q(content)}, ${qJsonOrEmpty(facts)},
         ${q(source)}, ${q(sourceType)}, ${q(status)}, ${verifiedAt},
         ${q(verifiedBy)}, ${qArr(tags)}, ${q(importance)},
         ${updatedBy ? q(updatedBy) : 'NULL'})
      RETURNING id::text;`;
    const id = await queryReturning(sql);
    // M106 · Fire-and-forget embed in the background — the new row is
    // immediately readable; semantic recall picks it up as soon as the
    // vector lands. Failures are persisted to embedding_status='failed'.
    embedRowAsync(id);
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
  // M105 · tree fields
  if ('topic'      in patch) sets.push(`topic=${patch.topic == null ? 'NULL' : q(String(patch.topic).toLowerCase())}`);
  if ('subtopic'   in patch) sets.push(`subtopic=${patch.subtopic == null ? 'NULL' : q(String(patch.subtopic).toLowerCase())}`);
  if ('parent_id'  in patch) sets.push(`parent_id=${patch.parent_id == null ? 'NULL' : q(patch.parent_id)}`);
  if ('updated_by' in patch) sets.push(`updated_by=${patch.updated_by == null ? 'NULL' : q(patch.updated_by)}`);
  if (sets.length === 0) return { ok: false, error: 'no fields to update' };
  sets.push('updated_at=NOW()');
  // M106 · If the patch touches anything that affects semantic content, mark
  // the row pending so the next backfill (or an immediate background embed)
  // refreshes the vector. We DON'T re-embed inline because the founder is
  // often updating in rapid succession (e.g. fixing a typo).
  const affectsEmbedding = ['title','content','facts','tags'].some(k => k in patch);
  if (affectsEmbedding) sets.push(`embedding_status='pending'`, `embedding_error=NULL`);
  try {
    await query(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE id=${q(id)};`);
    if (affectsEmbedding) embedRowAsync(id);
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

// M107 · Walk the supersede chain in both directions and return a flat,
// chronologically-ordered list of versions for a given KB entry id.
// Strategy:
//   1. Walk BACKWARD: from current row, follow superseded_by IS NULL to
//      itself, but the predecessors point at us via THEIR superseded_by.
//      So we need: SELECT * FROM kb WHERE superseded_by IN (set we've seen).
//      Iteratively expand until no new rows surface. (Cheap — depth is at most a few.)
//   2. Walk FORWARD: from current row, follow .superseded_by until null.
// Each row is annotated with `is_current` (status != 'superseded' AND no
// row points to it) and `is_starting_point` (no row in the chain points
// to it as its descendant).
async function history(id) {
  if (!id) return { ok: false, error: 'id required' };
  const start = await getOne(id);
  if (!start) return { ok: false, error: 'not found' };

  const seen = new Map();
  seen.set(start.id, start);

  // Walk forward: keep following superseded_by
  let cursor = start;
  while (cursor && cursor.superseded_by) {
    if (seen.has(cursor.superseded_by)) break;   // cycle guard
    const next = await getOne(cursor.superseded_by);
    if (!next) break;
    seen.set(next.id, next);
    cursor = next;
  }

  // Walk backward: find rows whose superseded_by points at any in `seen`.
  // Loop a few times so we capture deep chains.
  for (let i = 0; i < 20; i++) {
    const ids = Array.from(seen.keys()).map(s => `'${s}'::uuid`).join(',');
    const json = await queryValue(`
      SELECT COALESCE(json_agg(row_to_json(k)), '[]'::json) FROM (
        SELECT id::text, country, category, topic, subtopic, parent_id::text,
               title, content, facts, source, source_type,
               status, verified_at::text, verified_by, superseded_by::text, tags,
               importance, updated_by,
               embedding_status, embedding_error, embedded_at::text, embedding_model,
               created_at::text, updated_at::text, last_used_at::text, use_count
          FROM knowledge_base WHERE superseded_by IN (${ids})
      ) k;`);
    const rows = JSON.parse(json || '[]');
    let added = 0;
    for (const r of rows) if (!seen.has(r.id)) { seen.set(r.id, r); added++; }
    if (!added) break;
  }

  // Order by created_at ASC (oldest version first)
  const list = Array.from(seen.values()).sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );
  // Annotate
  const supersedeTargets = new Set(list.map(r => r.superseded_by).filter(Boolean));
  for (const r of list) {
    r.is_current = r.status !== 'superseded' && !supersedeTargets.has(r.id);
    r.is_starting_point = !list.some(x => x.superseded_by === r.id) === false ? false : !list.some(x => x.id !== r.id && x.superseded_by === r.id);
  }
  return { ok: true, versions: list };
}

// M107 · Restore a previous version: takes the OLD row's payload, copies
// its content into a fresh row, and supersedes the CURRENT row with it.
// Net effect: the chain advances forward to a copy of the old version,
// preserving full audit history. Old row's status flips to 'superseded'.
async function restore(versionId, currentId, restoredBy = 'founder') {
  if (!versionId || !currentId) return { ok: false, error: 'versionId + currentId required' };
  if (versionId === currentId) return { ok: false, error: 'version is already current' };
  const v = await getOne(versionId);
  if (!v) return { ok: false, error: 'version not found' };
  const c = await getOne(currentId);
  if (!c) return { ok: false, error: 'current row not found' };

  // Copy the version's content as a brand-new active row, then mark the
  // current row superseded by it.
  const r = await supersede(currentId, {
    country:    v.country,
    category:   v.category,
    topic:      v.topic,
    subtopic:   v.subtopic,
    parent_id:  v.parent_id,
    title:      v.title,
    content:    v.content,
    facts:      v.facts || {},
    source:     v.source,
    sourceType: 'inherited',                 // marks provenance — derived from older row
    tags:       v.tags || [],
    importance: v.importance || 3,
    status:     'active',
    verifiedBy: restoredBy,
  });
  if (!r.ok) return r;
  return { ok: true, restored_from: versionId, new_id: r.id, superseded: r.superseded };
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
      SELECT id::text, country, category, topic, subtopic, parent_id::text,
             title, content, facts, source, source_type,
             status, verified_at::text, verified_by, superseded_by::text, tags,
             importance, updated_by,
             embedding_status, embedding_error, embedded_at::text, embedding_model,
             created_at::text, updated_at::text, last_used_at::text, use_count
        FROM knowledge_base WHERE id = ${q(id)}
    ) k;`;
  try { const out = await queryValue(sql); return out ? JSON.parse(out) : null; }
  catch (_) { return null; }
}

async function list({ country = null, category = null, topic = null, subtopic = null,
                      status = null, query: searchQuery = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const where = [];
  if (country)     where.push(`country = ${q(_normCountry(country))}`);
  if (category)    where.push(`category = ${q(category)}`);
  // M105 · topic/subtopic — both optional, both narrow
  if (topic)       where.push(`(topic = ${q(String(topic).toLowerCase())} OR category = ${q(String(topic).toLowerCase())})`);
  if (subtopic)    where.push(`subtopic = ${q(String(subtopic).toLowerCase())}`);
  if (status)      where.push(`status = ${q(status)}`);
  if (searchQuery) where.push(`(title ILIKE ${q('%'+searchQuery+'%')} OR content ILIKE ${q('%'+searchQuery+'%')})`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(k) ORDER BY importance DESC, updated_at DESC), '[]'::json)
    FROM (SELECT id::text, country, category, topic, subtopic, parent_id::text,
                 title, content, facts, source, source_type,
                 status, verified_at::text, verified_by, tags, importance, updated_by,
                 embedding_status, embedded_at::text,
                 created_at::text, updated_at::text, use_count
            FROM knowledge_base ${w}
           ORDER BY importance DESC, updated_at DESC LIMIT ${limit}) k;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

// M105 · Tree view: nested taxonomy (kb_topics) + per-node entry counts.
// Returns:
//   [
//     { country, topics: [
//       { topic_slug, display_name, entry_count,
//         subtopics: [ { subtopic_slug, display_name, entry_count } ] },
//       ...
//     ] },
//     ...
//   ]
async function tree({ country = null } = {}) {
  const where = country ? `WHERE country = ${q(_normCountry(country))}` : '';
  // Pull taxonomy + counts in two queries; the JSON join is easier in JS.
  const taxJson = await queryValue(`
    SELECT COALESCE(json_agg(row_to_json(t) ORDER BY country, topic_slug, display_order, subtopic_slug NULLS FIRST), '[]'::json)
      FROM (SELECT id::text, country, topic_slug, subtopic_slug, display_name,
                   description, parent_id::text, display_order, enabled
              FROM kb_topics ${where}) t;`);
  const taxonomy = JSON.parse(taxJson || '[]');

  // Counts per (country, topic, subtopic)
  const countJson = await queryValue(`
    SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (
      SELECT country, topic, subtopic, COUNT(*)::int AS n
        FROM knowledge_base
       WHERE status IN ('active','draft')
         ${country ? `AND country = ${q(_normCountry(country))}` : ''}
       GROUP BY country, topic, subtopic
    ) c;`);
  const counts = JSON.parse(countJson || '[]');
  const countLookup = (cnt, top, sub) => {
    const row = counts.find(r => r.country === cnt && r.topic === top && (sub == null ? r.subtopic == null : r.subtopic === sub));
    return row ? row.n : 0;
  };
  // Also: orphan entries (have a topic the founder hasn't added to taxonomy yet)
  const orphanRows = counts.filter(c => !taxonomy.find(t =>
    t.country === c.country && t.topic_slug === c.topic && (c.subtopic ? t.subtopic_slug === c.subtopic : true)
  ));

  // Group taxonomy: country → topic → subtopics
  const byCountry = new Map();
  for (const t of taxonomy) {
    if (!byCountry.has(t.country)) byCountry.set(t.country, new Map());
    const tmap = byCountry.get(t.country);
    if (!t.subtopic_slug) {
      // top-level topic
      if (!tmap.has(t.topic_slug)) tmap.set(t.topic_slug, { ...t, subtopics: [] });
      else Object.assign(tmap.get(t.topic_slug), t);
    } else {
      // subtopic
      if (!tmap.has(t.topic_slug)) tmap.set(t.topic_slug, { country: t.country, topic_slug: t.topic_slug, display_name: t.topic_slug, subtopics: [] });
      tmap.get(t.topic_slug).subtopics.push(t);
    }
  }

  const out = [];
  for (const [cnt, tmap] of byCountry.entries()) {
    const topics = [];
    for (const top of tmap.values()) {
      topics.push({
        ...top,
        entry_count: countLookup(cnt, top.topic_slug, null),
        subtopics: (top.subtopics || []).map(s => ({ ...s, entry_count: countLookup(cnt, s.topic_slug, s.subtopic_slug) })),
      });
    }
    out.push({ country: cnt, topics, orphan_topics: orphanRows.filter(o => o.country === cnt) });
  }
  return out;
}

// ── kb_topics CRUD (founder-managed taxonomy) ──────────────────────────
async function topicsList({ country = null } = {}) {
  const where = country ? `WHERE country = ${q(_normCountry(country))}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t) ORDER BY country, topic_slug, display_order, subtopic_slug NULLS FIRST), '[]'::json)
      FROM (SELECT id::text, country, topic_slug, subtopic_slug, display_name,
                   description, parent_id::text, display_order, enabled
              FROM kb_topics ${where}) t;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

async function topicsAdd({ country, topic_slug, subtopic_slug = null, display_name, description = null, display_order = 100, parent_id = null } = {}) {
  if (!country || !topic_slug || !display_name) return { ok: false, error: 'country, topic_slug, display_name required' };
  try {
    const id = await queryReturning(`
      INSERT INTO kb_topics (country, topic_slug, subtopic_slug, display_name, description, display_order, parent_id, enabled)
      VALUES (${q(_normCountry(country))}, ${q(String(topic_slug).toLowerCase())},
              ${subtopic_slug ? q(String(subtopic_slug).toLowerCase()) : 'NULL'},
              ${q(display_name)},
              ${description ? q(description) : 'NULL'},
              ${parseInt(display_order, 10) || 100},
              ${parent_id ? q(parent_id) : 'NULL'},
              true)
      ON CONFLICT (country, topic_slug, subtopic_slug) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            description  = COALESCE(EXCLUDED.description, kb_topics.description),
            enabled      = true,
            updated_at   = now()
      RETURNING id::text;`);
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function topicsUpdate(id, patch = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const sets = [];
  if ('display_name'  in patch) sets.push(`display_name = ${q(patch.display_name)}`);
  if ('description'   in patch) sets.push(`description = ${patch.description == null ? 'NULL' : q(patch.description)}`);
  if ('display_order' in patch) sets.push(`display_order = ${parseInt(patch.display_order, 10) || 100}`);
  if ('topic_slug'    in patch) sets.push(`topic_slug = ${q(String(patch.topic_slug).toLowerCase())}`);
  if ('subtopic_slug' in patch) sets.push(`subtopic_slug = ${patch.subtopic_slug == null ? 'NULL' : q(String(patch.subtopic_slug).toLowerCase())}`);
  if ('enabled'       in patch) sets.push(`enabled = ${patch.enabled ? 'true' : 'false'}`);
  if ('parent_id'     in patch) sets.push(`parent_id = ${patch.parent_id == null ? 'NULL' : q(patch.parent_id)}`);
  if (!sets.length) return { ok: false, error: 'nothing to update' };
  sets.push('updated_at = NOW()');
  try {
    await query(`UPDATE kb_topics SET ${sets.join(', ')} WHERE id = ${q(id)};`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

async function topicsRemove(id) {
  try {
    // Soft-delete (preserves entries that point at this slot via topic/subtopic strings)
    await query(`UPDATE kb_topics SET enabled = false, updated_at = NOW() WHERE id = ${q(id)};`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}

// Subtopic + tag suggestions. Helps the founder pick consistent terms.
async function subtopicSuggestions({ country = null, topic = null } = {}) {
  const where = [`status IN ('active','draft')`];
  if (country) where.push(`country = ${q(_normCountry(country))}`);
  if (topic)   where.push(`topic = ${q(String(topic).toLowerCase())}`);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY n DESC), '[]'::json) FROM (
      SELECT subtopic, COUNT(*)::int AS n FROM knowledge_base
       WHERE ${where.join(' AND ')} AND subtopic IS NOT NULL
       GROUP BY subtopic ORDER BY n DESC LIMIT 50
    ) s;`;
  const tagsSql = `
    SELECT COALESCE(json_agg(row_to_json(t) ORDER BY n DESC), '[]'::json) FROM (
      SELECT tag, COUNT(*)::int AS n FROM (
        SELECT UNNEST(tags) AS tag FROM knowledge_base WHERE ${where.join(' AND ')}
      ) x GROUP BY tag ORDER BY n DESC LIMIT 30
    ) t;`;
  try {
    return {
      subtopics: JSON.parse((await queryValue(sql)) || '[]'),
      tags:      JSON.parse((await queryValue(tagsSql)) || '[]'),
    };
  } catch (_) { return { subtopics: [], tags: [] }; }
}

// ── Recall (for prompt grounding) ───────────────────────────────────
// Active+verified entries first, scored by importance × recency, plus a
// keyword-match bonus when query is supplied. GLOBAL country always
// included as fallback context.
async function recall({ country = null, category = null, topic = null, subtopic = null,
                        query: searchQuery = null, limit = 8,
                        semantic = 'auto' } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 30);
  const where = [`status IN ('active','draft')`];

  // M106 · Hybrid recall. When OPENAI_API_KEY is present AND a query is
  // supplied AND semantic !== 'off', embed the query and add a cosine
  // similarity score term. The keyword/importance/recency scoring still
  // applies — vector is additive, not exclusive. So tag exact-matches and
  // recently-touched rows still win when they should.
  let vectorTerm = '';
  if (searchQuery && semantic !== 'off' && embeddings.hasKey()) {
    try {
      const er = await embeddings.embed(searchQuery);
      if (er.ok && er.vector) {
        const vlit = embeddings.toPgVectorLiteral(er.vector);
        // 1 - cosine_distance ∈ [-1, 1]; multiply by 8 so a perfect semantic
        // hit contributes ~8 score points, comparable to a tag bonus (3) +
        // title contains (5).
        vectorTerm = ` + (CASE WHEN embedding IS NOT NULL THEN 8.0 * (1 - (embedding <=> ${vlit})) ELSE 0 END)`;
      }
    } catch (_) { /* non-fatal — fall through to keyword-only scoring */ }
  }
  if (country) {
    const c = _normCountry(country);
    where.push(`(country = ${q(c)} OR country = 'GLOBAL')`);
  }
  if (category) where.push(`category = ${q(category)}`);
  // M105 · topic/subtopic boost vs hard filter. We DON'T hard-filter on
  // topic — we score-boost so adjacent facts can still surface (better
  // recall behaviour). subtopic is a stronger boost.
  let scoreExpr = `importance::float * (1.0 / (1.0 + EXTRACT(EPOCH FROM NOW() - last_used_at) / 2592000.0))`;
  if (topic) {
    const tSafe = String(topic).toLowerCase().replace(/'/g, "''");
    scoreExpr += ` + CASE WHEN topic = '${tSafe}' THEN 4 WHEN category = '${tSafe}' THEN 2 ELSE 0 END`;
  }
  if (subtopic) {
    const sSafe = String(subtopic).toLowerCase().replace(/'/g, "''");
    scoreExpr += ` + CASE WHEN subtopic = '${sSafe}' THEN 6 ELSE 0 END`;
  }
  if (searchQuery) {
    const safe = String(searchQuery).replace(/'/g, "''").slice(0, 200);
    scoreExpr += ` + CASE WHEN (title ILIKE '%${safe}%' OR content ILIKE '%${safe}%') THEN 5 ELSE 0 END`;
    const kws = String(searchQuery).toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 5);
    if (kws.length) {
      scoreExpr += ` + CASE WHEN tags && ${qArr(kws)} THEN 3 ELSE 0 END`;
    }
  }
  scoreExpr += vectorTerm;   // M106 · semantic similarity boost (no-op when key missing)
  const sql = `
    WITH ranked AS (
      SELECT id, country, category, topic, subtopic, title, content, facts, source, status,
             tags, importance, verified_at, last_used_at,
             (${scoreExpr}) AS score
        FROM knowledge_base
       WHERE ${where.join(' AND ')}
    )
    SELECT COALESCE(json_agg(row_to_json(r) ORDER BY score DESC, importance DESC), '[]'::json)
    FROM (SELECT id::text, country, category, topic, subtopic, title, content, facts, source, status,
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
async function renderAsBlock({ country = null, query: searchQuery = null, limit = 6,
                                category = null, topic = null, subtopic = null } = {}) {
  const rows = await recall({ country, category, topic, subtopic, query: searchQuery, limit });
  if (!rows.length) return '';
  const scope = subtopic ? `${_normCountry(country) || ''} / ${topic || ''} / ${subtopic}`
              : topic    ? `${_normCountry(country) || ''} / ${topic}`
              : country  ? `${_normCountry(country)}`
                         : 'all countries';
  const header = `KNOWLEDGE BASE — ${scope} (verified facts; cite when used; address shown as [country / topic / subtopic]):`;
  const lines = rows.map(r => {
    const v = r.verified_at ? '✓' : '·';
    const factSummary = (r.facts && Object.keys(r.facts).length)
      ? ` [${Object.entries(r.facts).slice(0,3).map(([k,v])=>`${k}=${v}`).join(', ')}]`
      : '';
    const src = r.source ? ` (src: ${String(r.source).slice(0,60)})` : '';
    const body = String(r.content || '').slice(0, 280);
    // M105 · address: prefer topic/subtopic; fall back to legacy category
    const addr = r.subtopic ? `${r.country}/${r.topic || r.category}/${r.subtopic}`
              : r.topic     ? `${r.country}/${r.topic}`
                            : `${r.country}/${r.category || '?'}`;
    return `${v} [${addr}] ${r.title}: ${body}${factSummary}${src}`;
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
  // M105 · tree + taxonomy
  tree, topicsList, topicsAdd, topicsUpdate, topicsRemove, subtopicSuggestions,
  // M106 · embeddings
  embedRowAsync, backfillEmbeddings, embeddingsStatus,
  // M107 · versioning · M108 · bulk re-tag
  history, restore, bulkUpdate,
  VALID_CATEGORIES: Array.from(VALID_CATEGORIES),
  VALID_STATUS: Array.from(VALID_STATUS),
};
