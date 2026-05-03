// cowork-proxy/brand-intelligence.js
// =====================================================================
// M55 · Dynamic agent training layer.
//
// Every Compose run, every chat call, every DM reply: this module
// queries the live DB for relevant rules + exemplars and injects them
// into the agent's system prompt. Founder edits any row → next call
// uses the new value. No code changes, no redeploy.
//
// Public API:
//   getRulesForAgent({ agent, platform, language, kinds, limit }) → []
//   getExemplarsForAgent({ kind, platform, language, limit, tags }) → []
//   getVoiceFingerprint({ cluster, language }) → []
//
//   renderAsPromptBlock({ agent, platform, language }) → string
//   renderExemplarsBlock({ kind, platform, language, limit }) → string
//
//   CRUD:
//     listIntelligence({ filters }) / createIntelligence(...) /
//     updateIntelligence(id, ...) / deleteIntelligence(id)
//   (same shape for exemplars + fingerprint)
//
//   Bulk import (from analyzer JSONs):
//     importPublicArchive({ patterns, exemplars, fingerprint, visualProfile, engagementAnalysis, sourceLabel })
//     importDmAnalysis({ questionPatterns, objectionPlaybook, voiceFingerprint, intentExamples, sourceLabel })
//
// Cache: 60s TTL on rule + exemplar reads — covers the hot path. Edits
// invalidate the cache for the affected (agent, platform, lang) key.
// =====================================================================

'use strict';

const { query, queryRows, queryValue, queryReturning, q, qJson, qArr } = require('./db');

// ── Cache ────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000;
let _cache = { rules: new Map(), exemplars: new Map(), fingerprint: new Map() };

function _ck(parts) { return parts.map(p => p == null ? '_' : String(p)).join('|'); }
function _cacheGet(map, key) {
  const v = map.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) { map.delete(key); return null; }
  return v.value;
}
function _cacheSet(map, key, value) {
  map.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}
function clearCache() {
  _cache = { rules: new Map(), exemplars: new Map(), fingerprint: new Map() };
}

// ── Rules · CRUD + getters ───────────────────────────────────────────

async function getRulesForAgent({ agent = null, platform = null, language = null,
                                   kinds = null, limit = 30 } = {}) {
  const key = _ck(['rules', agent, platform, language, (kinds || []).join(','), limit]);
  const hit = _cacheGet(_cache.rules, key);
  if (hit) return hit;

  const conds = ['enabled = TRUE'];
  // Agent filter — match exact OR null (broad rule)
  if (agent) conds.push(`(target_agent = ${q(agent)} OR target_agent IS NULL)`);
  // Platform filter — match exact OR null
  if (platform) conds.push(`(scope_platform = ${q(platform)} OR scope_platform IS NULL)`);
  // Language filter — match exact OR null
  if (language) conds.push(`(scope_language = ${q(language)} OR scope_language IS NULL)`);
  // Kind filter
  if (Array.isArray(kinds) && kinds.length) {
    const list = kinds.map(k => q(k)).join(',');
    conds.push(`kind IN (${list})`);
  }
  const sql = `
    SELECT id::text, kind, target_agent, scope_platform, scope_language,
            rule_text, rule_data, importance, source, founder_edited
      FROM brand_intelligence
     WHERE ${conds.join(' AND ')}
     ORDER BY importance DESC, founder_edited DESC, updated_at DESC
     LIMIT ${parseInt(limit, 10) || 30};
  `;
  const rows = await queryRows(sql);
  _cacheSet(_cache.rules, key, rows);
  return rows;
}

async function listIntelligence({ kind = null, target_agent = null, platform = null,
                                   language = null, enabled = null, limit = 200, offset = 0 } = {}) {
  const conds = [];
  if (kind)         conds.push(`kind = ${q(kind)}`);
  if (target_agent) conds.push(`target_agent = ${q(target_agent)}`);
  if (platform)     conds.push(`scope_platform = ${q(platform)}`);
  if (language)     conds.push(`scope_language = ${q(language)}`);
  if (enabled === true)  conds.push(`enabled = TRUE`);
  if (enabled === false) conds.push(`enabled = FALSE`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return await queryRows(`
    SELECT id::text, kind, target_agent, scope_platform, scope_language,
            rule_text, rule_data, importance, source, source_ref,
            enabled, founder_edited, founder_note,
            created_at::text, updated_at::text
      FROM brand_intelligence ${where}
      ORDER BY importance DESC, updated_at DESC
      LIMIT ${parseInt(limit, 10) || 200} OFFSET ${parseInt(offset, 10) || 0};`);
}

async function createIntelligence(row) {
  if (!row.kind || !row.rule_text) throw new Error('kind + rule_text required');
  const id = await queryReturning(`
    INSERT INTO brand_intelligence
      (kind, target_agent, scope_platform, scope_language, rule_text, rule_data,
        importance, source, source_ref, enabled, founder_edited, founder_note, topic_tags)
    VALUES (
      ${q(row.kind)}, ${q(row.target_agent)}, ${q(row.scope_platform)}, ${q(row.scope_language)},
      ${q(row.rule_text)}, ${qJson(row.rule_data || {})},
      ${parseInt(row.importance || 3, 10)}, ${q(row.source || 'manual')}, ${q(row.source_ref)},
      ${row.enabled === false ? 'FALSE' : 'TRUE'},
      ${row.founder_edited === true ? 'TRUE' : 'FALSE'},
      ${q(row.founder_note)},
      ${qArr(Array.isArray(row.topic_tags) ? row.topic_tags : [])}
    ) RETURNING id::text;`);
  clearCache();
  return { ok: true, id };
}

async function updateIntelligence(id, fields) {
  const allowed = ['kind', 'target_agent', 'scope_platform', 'scope_language',
                    'rule_text', 'importance', 'enabled', 'founder_note'];
  const sets = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'enabled') sets.push(`${k} = ${v ? 'TRUE' : 'FALSE'}`);
    else if (k === 'importance') sets.push(`${k} = ${parseInt(v, 10) || 3}`);
    else sets.push(`${k} = ${q(v)}`);
  }
  if (fields && fields.rule_data != null) sets.push(`rule_data = ${qJson(fields.rule_data)}`);
  if (Array.isArray(fields && fields.topic_tags)) sets.push(`topic_tags = ${qArr(fields.topic_tags)}`);
  if (sets.length === 0) return { ok: false, error: 'no valid fields' };
  // Mark as founder_edited automatically on any edit
  sets.push(`founder_edited = TRUE`);
  sets.push(`updated_at = NOW()`);
  await query(`UPDATE brand_intelligence SET ${sets.join(', ')} WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

async function deleteIntelligence(id) {
  // Soft delete via enabled=false so we keep provenance
  await query(`UPDATE brand_intelligence SET enabled = FALSE, updated_at = NOW() WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

async function hardDeleteIntelligence(id) {
  await query(`DELETE FROM brand_intelligence WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

// ── Exemplars · CRUD + getters ───────────────────────────────────────

async function getExemplarsForAgent({ kind = null, platform = null, language = null,
                                       tags = null, limit = 5 } = {}) {
  const key = _ck(['exemplars', kind, platform, language, (tags || []).join(','), limit]);
  const hit = _cacheGet(_cache.exemplars, key);
  if (hit) return hit;

  const conds = ['enabled = TRUE'];
  if (kind)     conds.push(`kind = ${q(kind)}`);
  if (platform) conds.push(`(platform = ${q(platform)} OR platform IS NULL)`);
  if (language) conds.push(`(language = ${q(language)} OR language IS NULL)`);
  if (Array.isArray(tags) && tags.length) {
    conds.push(`topic_tags && ${qArr(tags)}`);
  }
  const rows = await queryRows(`
    SELECT id::text, kind, platform, language, body, context, topic_tags,
            importance, source, outcome, founder_note
      FROM brand_exemplars
     WHERE ${conds.join(' AND ')}
     ORDER BY importance DESC, updated_at DESC
     LIMIT ${parseInt(limit, 10) || 5};`);
  _cacheSet(_cache.exemplars, key, rows);
  return rows;
}

async function listExemplars({ kind = null, platform = null, language = null,
                                limit = 200, offset = 0 } = {}) {
  const conds = [];
  if (kind)     conds.push(`kind = ${q(kind)}`);
  if (platform) conds.push(`platform = ${q(platform)}`);
  if (language) conds.push(`language = ${q(language)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return await queryRows(`
    SELECT id::text, kind, platform, language, body, context, topic_tags,
            importance, source, source_ref, outcome,
            enabled, founder_note, created_at::text, updated_at::text
      FROM brand_exemplars ${where}
      ORDER BY importance DESC, updated_at DESC
      LIMIT ${parseInt(limit, 10) || 200} OFFSET ${parseInt(offset, 10) || 0};`);
}

async function createExemplar(row) {
  if (!row.kind || !row.body) throw new Error('kind + body required');
  const id = await queryReturning(`
    INSERT INTO brand_exemplars
      (kind, platform, language, body, context, topic_tags,
        importance, source, source_ref, outcome, enabled, founder_note)
    VALUES (
      ${q(row.kind)}, ${q(row.platform)}, ${q(row.language)},
      ${q(row.body)}, ${q(row.context)},
      ${qArr(row.topic_tags || [])},
      ${parseInt(row.importance || 3, 10)}, ${q(row.source || 'manual')}, ${q(row.source_ref)},
      ${q(row.outcome)},
      ${row.enabled === false ? 'FALSE' : 'TRUE'},
      ${q(row.founder_note)}
    ) RETURNING id::text;`);
  clearCache();
  return { ok: true, id };
}

async function updateExemplar(id, fields) {
  const allowed = ['kind', 'platform', 'language', 'body', 'context',
                    'importance', 'enabled', 'outcome', 'founder_note'];
  const sets = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'enabled') sets.push(`${k} = ${v ? 'TRUE' : 'FALSE'}`);
    else if (k === 'importance') sets.push(`${k} = ${parseInt(v, 10) || 3}`);
    else sets.push(`${k} = ${q(v)}`);
  }
  if (Array.isArray(fields && fields.topic_tags)) sets.push(`topic_tags = ${qArr(fields.topic_tags)}`);
  if (sets.length === 0) return { ok: false, error: 'no valid fields' };
  sets.push(`updated_at = NOW()`);
  await query(`UPDATE brand_exemplars SET ${sets.join(', ')} WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

async function deleteExemplar(id) {
  await query(`UPDATE brand_exemplars SET enabled = FALSE, updated_at = NOW() WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

// ── Voice fingerprint · CRUD + getters ───────────────────────────────

async function getVoiceFingerprint({ cluster = null, language = null, limit = 50 } = {}) {
  const key = _ck(['fp', cluster, language, limit]);
  const hit = _cacheGet(_cache.fingerprint, key);
  if (hit) return hit;
  const conds = ['enabled = TRUE'];
  if (cluster)  conds.push(`cluster = ${q(cluster)}`);
  if (language) conds.push(`language = ${q(language)}`);
  const rows = await queryRows(`
    SELECT id::text, cluster, language, body, why_picked, importance, source
      FROM brand_voice_fingerprint
     WHERE ${conds.join(' AND ')}
     ORDER BY importance DESC, created_at DESC
     LIMIT ${parseInt(limit, 10) || 50};`);
  _cacheSet(_cache.fingerprint, key, rows);
  return rows;
}

async function listFingerprint({ cluster = null, language = null, limit = 200 } = {}) {
  const conds = [];
  if (cluster)  conds.push(`cluster = ${q(cluster)}`);
  if (language) conds.push(`language = ${q(language)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return await queryRows(`
    SELECT id::text, cluster, language, body, why_picked, importance,
            source, source_ref, enabled, founder_note, created_at::text
      FROM brand_voice_fingerprint ${where}
      ORDER BY importance DESC, created_at DESC LIMIT ${parseInt(limit, 10) || 200};`);
}

async function createFingerprint(row) {
  if (!row.cluster || !row.language || !row.body) throw new Error('cluster + language + body required');
  const id = await queryReturning(`
    INSERT INTO brand_voice_fingerprint
      (cluster, language, body, why_picked, importance, source, source_ref, founder_note)
    VALUES (
      ${q(row.cluster)}, ${q(row.language)}, ${q(row.body)}, ${q(row.why_picked)},
      ${parseInt(row.importance || 4, 10)},
      ${q(row.source || 'manual')}, ${q(row.source_ref)}, ${q(row.founder_note)}
    ) RETURNING id::text;`);
  clearCache();
  return { ok: true, id };
}

async function updateFingerprint(id, fields) {
  const allowed = ['cluster', 'language', 'body', 'why_picked', 'importance', 'enabled', 'founder_note'];
  const sets = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'enabled') sets.push(`${k} = ${v ? 'TRUE' : 'FALSE'}`);
    else if (k === 'importance') sets.push(`${k} = ${parseInt(v, 10) || 4}`);
    else sets.push(`${k} = ${q(v)}`);
  }
  if (sets.length === 0) return { ok: false, error: 'no valid fields' };
  await query(`UPDATE brand_voice_fingerprint SET ${sets.join(', ')} WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

async function deleteFingerprint(id) {
  await query(`UPDATE brand_voice_fingerprint SET enabled = FALSE WHERE id = ${q(id)};`);
  clearCache();
  return { ok: true };
}

// ── Prompt-block renderers ───────────────────────────────────────────
//
// These are what compose-orchestrator calls when building system prompts.
// They turn DB rows into formatted text the LLM will read.

async function renderAsPromptBlock({ agent, platform = null, language = null }) {
  if (!agent) return '';
  const rules = await getRulesForAgent({ agent, platform, language, limit: 25 });
  if (rules.length === 0) return '';
  // Group by kind so the block is scannable
  const byKind = {};
  for (const r of rules) {
    if (!byKind[r.kind]) byKind[r.kind] = [];
    byKind[r.kind].push(r);
  }
  const lines = [`# Brand intelligence (live, ${rules.length} active rules)`];
  for (const [kind, rows] of Object.entries(byKind)) {
    const label = kind.replace(/_/g, ' ');
    lines.push(`\n## ${label}`);
    for (const r of rows) {
      const star = r.importance >= 5 ? '⭐ ' : r.importance >= 4 ? '★ ' : '  ';
      lines.push(`${star}${r.rule_text}`);
    }
  }
  return lines.join('\n');
}

async function renderExemplarsBlock({ kind, platform = null, language = null, limit = 3, tags = null }) {
  const rows = await getExemplarsForAgent({ kind, platform, language, tags, limit });
  if (rows.length === 0) return '';
  const lines = [`# Exemplar ${kind.replace(/_/g, ' ')} (${rows.length})`];
  for (const r of rows) {
    lines.push(`\n--- exemplar (importance=${r.importance}${r.outcome ? `, outcome=${r.outcome}` : ''}) ---`);
    if (r.context) lines.push(`Context: ${r.context}`);
    lines.push(r.body);
  }
  return lines.join('\n');
}

// ── Bulk import (called by upload endpoint) ──────────────────────────

// Translates the public-archive analyzer JSONs into DB rows.
// Idempotent on (source, source_ref) — re-uploading replaces.
async function importPublicArchive({ patterns, exemplars, fingerprint, visualProfile,
                                      engagementAnalysis, sourceLabel = null }) {
  const stamp = sourceLabel || `archive_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  let intel = 0, exem = 0, fp = 0;
  let lastSection = 'init';

  try {
  // Wipe prior rows from the same source so re-uploads don't duplicate.
  await query(`DELETE FROM brand_intelligence WHERE source = ${q(stamp)};`);
  await query(`DELETE FROM brand_exemplars     WHERE source = ${q(stamp)};`);
  await query(`DELETE FROM brand_voice_fingerprint WHERE source = ${q(stamp)};`);

  // ── Voice patterns → intelligence rows ────
  lastSection = 'voice_patterns';
  if (patterns && patterns.patterns) {
    for (const [groupKey, group] of Object.entries(patterns.patterns)) {
      if (!group || group.insufficient_data) continue;
      const platform = group.platform;
      const language = group.language;

      // Banned phrases — high importance
      for (const ph of (group.banned_or_avoided || [])) {
        await createIntelligence({
          kind: 'banned_phrase', scope_platform: platform, scope_language: language,
          target_agent: null,            // applies to all agents
          rule_text: `Never use: ${ph}`,
          rule_data: { phrase: ph },
          importance: 5, source: stamp,
        });
        intel++;
      }
      // Favored phrases
      for (const ph of (group.favored_phrases || [])) {
        await createIntelligence({
          kind: 'favored_phrase', scope_platform: platform, scope_language: language,
          rule_text: `Brand often uses: "${ph}"`,
          rule_data: { phrase: ph },
          importance: 3, source: stamp,
        });
        intel++;
      }
      // Voice signature words → protected terms
      for (const w of (group.voice_signature_words || [])) {
        await createIntelligence({
          kind: 'protected_term', scope_platform: platform, scope_language: language,
          rule_text: `Brand-signature term: "${w}" — keep verbatim across translations.`,
          rule_data: { term: w },
          importance: 4, source: stamp,
        });
        intel++;
      }
      // Length stats → voice rule
      if (group.length_stats && group.length_stats.word_count) {
        const ls = group.length_stats.word_count;
        await createIntelligence({
          kind: 'voice_rule', scope_platform: platform, scope_language: language,
          target_agent: 'sepehr',
          rule_text: `${platform}-${language} caption length: target ${ls.p25}-${ls.p75} words (mean ${ls.mean}). p95 = ${ls.p95}; rarely exceed.`,
          rule_data: ls,
          importance: 4, source: stamp,
        });
        intel++;
      }
      // Hashtag count → adapt rule
      if (group.hashtags && group.hashtags.count_distribution) {
        const hd = group.hashtags.count_distribution;
        const mix = group.hashtags.language_mix_pct || {};
        const mixStr = Object.entries(mix).map(([k, v]) => `${k}:${v}%`).join(', ');
        await createIntelligence({
          kind: 'voice_rule', scope_platform: platform, scope_language: language,
          target_agent: 'avang',
          rule_text: `${platform}-${language} hashtags: ${hd.p25 || 0}-${hd.p75 || 0} per post (mean ${hd.mean || 0}). Mix: ${mixStr || 'n/a'}.`,
          rule_data: { distribution: hd, mix },
          importance: 4, source: stamp,
        });
        intel++;
      }
      // Punctuation tics
      for (const t of (group.punctuation_tics || [])) {
        await createIntelligence({
          kind: 'voice_rule', scope_platform: platform, scope_language: language,
          target_agent: 'sepehr',
          rule_text: `Punctuation: ${t}`,
          rule_data: { tic: t },
          importance: 3, source: stamp,
        });
        intel++;
      }
      // Opener templates → opener_template rows + an aggregate rule
      for (const op of (group.openers && group.openers.templates || [])) {
        await createIntelligence({
          kind: 'opener_template', scope_platform: platform, scope_language: language,
          target_agent: 'sepehr',
          rule_text: `Opener pattern (${op.frequency || 0}×): ${op.shape}. Example: "${op.example || ''}"`,
          rule_data: op,
          importance: Math.min(5, 2 + Math.floor(Math.log10(1 + (op.frequency || 1)))),
          source: stamp,
        });
        intel++;
      }
      // CTA templates
      for (const cta of (group.ctas && group.ctas.templates || [])) {
        await createIntelligence({
          kind: 'cta_template', scope_platform: platform, scope_language: language,
          target_agent: 'sepehr',
          rule_text: `CTA pattern (${cta.frequency || 0}×): ${cta.form}. Example: "${cta.example || ''}"`,
          rule_data: cta,
          importance: Math.min(5, 2 + Math.floor(Math.log10(1 + (cta.frequency || 1)))),
          source: stamp,
        });
        intel++;
      }
    }
  }

  // ── Exemplars ────
  lastSection = 'exemplars';
  if (exemplars && Array.isArray(exemplars.exemplars)) {
    for (const ex of exemplars.exemplars) {
      await createExemplar({
        kind: 'post_caption',
        platform: ex.platform, language: ex.language,
        body: ex.caption || '',
        context: ex.hashtags ? `Hashtags: ${(ex.hashtags || []).join(' ')}` : null,
        topic_tags: [],
        importance: ex.importance || 3,
        source: stamp, source_ref: ex.id,
        outcome: ex.source === 'engagement-top' ? 'high_engagement' : (ex.source === 'last-30' ? 'recent' : null),
      });
      exem++;
    }
  }

  // ── Voice fingerprint ────
  lastSection = 'fingerprint';
  if (fingerprint && Array.isArray(fingerprint.cluster)) {
    for (const c of fingerprint.cluster) {
      await createFingerprint({
        cluster: 'broadcast', language: c.language || 'en',
        body: c.caption || '', why_picked: c.why_picked || null,
        importance: 4, source: stamp, source_ref: c.id,
      });
      fp++;
    }
  }

  // ── Visual rules (Afshin) ────
  lastSection = 'visual_rules';
  if (visualProfile && visualProfile.aggregate && Array.isArray(visualProfile.aggregate.brand_rules_inferred)) {
    for (const ruleText of visualProfile.aggregate.brand_rules_inferred) {
      // Auto-derive topic_tags from rule text so retrieval can match by topic
      const lt = ruleText.toLowerCase();
      const tags = ['visual'];
      if (/logo/.test(lt))                  tags.push('logo');
      if (/color|teal|navy|palette/.test(lt)) tags.push('palette');
      if (/typography|type/.test(lt))       tags.push('typography');
      if (/template|poster/.test(lt))       tags.push('template');
      if (/country|usa|germany|canada/.test(lt)) tags.push('country');
      if (/watercolor|occasion|greeting/.test(lt)) tags.push('occasion');
      if (/aspect|ratio|portrait|square/.test(lt)) tags.push('aspect-ratio');
      if (/photoreal|photo/.test(lt))       tags.push('photoreal');
      if (/wordmark|spaced/.test(lt))       tags.push('wordmark');

      await createIntelligence({
        kind: 'visual_rule', target_agent: 'afshin',
        rule_text: ruleText,
        rule_data: { aggregate: visualProfile.aggregate },
        importance: 5, source: stamp,
        topic_tags: tags,
      });
      intel++;
    }
  }

  // ── Engagement insights ────
  lastSection = 'engagement_insights';
  if (engagementAnalysis) {
    // Top topics by engagement
    if (engagementAnalysis.topic_x_engagement) {
      const ranked = Object.entries(engagementAnalysis.topic_x_engagement)
        .filter(([, s]) => s.n >= 3)
        .sort((a, b) => (b[1].mean || 0) - (a[1].mean || 0))
        .slice(0, 8);
      for (const [topic, stats] of ranked) {
        await createIntelligence({
          kind: 'engagement_insight', target_agent: 'pooya',
          rule_text: `Topic "${topic}" engages: ${stats.n} samples, mean score ${Math.round(stats.mean)}, median ${stats.median}.`,
          rule_data: { topic, ...stats },
          importance: 4, source: stamp,
        });
        intel++;
      }
    }
    // Length sweet spot
    if (engagementAnalysis.caption_length_x_engagement) {
      const ranked = Object.entries(engagementAnalysis.caption_length_x_engagement)
        .sort((a, b) => (b[1].mean || 0) - (a[1].mean || 0));
      const [bestBand, bestStats] = ranked[0];
      await createIntelligence({
        kind: 'engagement_insight', target_agent: 'sepehr',
        rule_text: `Caption length sweet spot: "${bestBand}" — mean engagement ${Math.round(bestStats.mean)} vs others ${Math.round((ranked[1][1].mean) || 0)}.`,
        rule_data: { ranking: ranked },
        importance: 4, source: stamp,
      });
      intel++;
    }
    // Hashtag count sweet spot
    if (engagementAnalysis.hashtag_count_x_engagement) {
      const ranked = Object.entries(engagementAnalysis.hashtag_count_x_engagement)
        .sort((a, b) => (b[1].mean || 0) - (a[1].mean || 0));
      const [bestBand, bestStats] = ranked[0];
      await createIntelligence({
        kind: 'engagement_insight', target_agent: 'avang',
        rule_text: `Hashtag count sweet spot: ${bestBand} — mean engagement ${Math.round(bestStats.mean)}.`,
        rule_data: { ranking: ranked },
        importance: 4, source: stamp,
      });
      intel++;
    }
    // Feature flags
    if (engagementAnalysis.feature_flag_x_engagement) {
      for (const [flag, sides] of Object.entries(engagementAnalysis.feature_flag_x_engagement)) {
        const w = sides.with, wo = sides.without;
        if (!w || !wo || !w.n || w.n < 3) continue;
        const lift = w.mean && wo.mean ? Math.round(((w.mean / wo.mean) - 1) * 100) : 0;
        if (Math.abs(lift) < 10) continue;   // skip noise
        await createIntelligence({
          kind: 'engagement_insight', target_agent: 'sepehr',
          rule_text: `Posts ${flag}: ${lift > 0 ? '+' : ''}${lift}% engagement vs without (n=${w.n} vs ${wo.n}).`,
          rule_data: { flag, with: w, without: wo, lift_pct: lift },
          importance: lift > 0 ? 4 : 3, source: stamp,
        });
        intel++;
      }
    }
    // Top winners → exemplars (high importance)
    if (Array.isArray(engagementAnalysis.top_25_winners)) {
      for (const w of engagementAnalysis.top_25_winners.slice(0, 25)) {
        if (!w.caption_preview) continue;
        await createExemplar({
          kind: 'post_caption',
          platform: w.id && w.id.startsWith('ig-') ? 'instagram' : (w.id && w.id.startsWith('tg-') ? 'telegram' : null),
          language: null,        // detected upstream
          body: w.caption_preview, context: `topic=${w.topic} opener=${w.opener} score=${w.score}`,
          topic_tags: w.topic ? [w.topic] : [],
          importance: 5,
          source: stamp, source_ref: w.id, outcome: 'top_engagement',
        });
        exem++;
      }
    }
  }

  lastSection = 'provenance';
  // Provenance row
  await query(`
    INSERT INTO brand_archive_uploads
      (upload_kind, source_label, intelligence_inserted, exemplars_inserted, fingerprint_inserted, meta)
    VALUES ('public_archive', ${q(stamp)}, ${intel}, ${exem}, ${fp}, ${qJson({ patterns: !!patterns, exemplars: !!exemplars, fingerprint: !!fingerprint, visualProfile: !!visualProfile, engagementAnalysis: !!engagementAnalysis })});
  `);

  clearCache();
  return { ok: true, source: stamp, intelligence: intel, exemplars: exem, fingerprint: fp };
  } catch (e) {
    // Diagnostic-friendly error: tell the founder which section blew up
    e.message = `[importPublicArchive · last section: ${lastSection} · intel=${intel} exem=${exem} fp=${fp}] ${e.message}`;
    throw e;
  }
}

// DM analyzer JSONs → DB rows. Same idempotency on (source, source_ref).
async function importDmAnalysis({ questionPatterns, objectionPlaybook, voiceFingerprint,
                                   intentExamples, sourceLabel = null }) {
  const stamp = sourceLabel || `dm_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  let intel = 0, exem = 0, fp = 0;

  await query(`DELETE FROM brand_intelligence WHERE source = ${q(stamp)};`);
  await query(`DELETE FROM brand_exemplars     WHERE source = ${q(stamp)};`);
  await query(`DELETE FROM brand_voice_fingerprint WHERE source = ${q(stamp)};`);

  // Question patterns → intelligence rows for Pooya (content backlog) + Avang (hooks)
  if (questionPatterns && Array.isArray(questionPatterns.patterns)) {
    for (const p of questionPatterns.patterns) {
      await createIntelligence({
        kind: 'dm_question_pattern', target_agent: 'pooya',
        rule_text: `Q-pattern (${p.frequency}×): ${p.topic}. ${p.content_idea_for_pooya || ''}`,
        rule_data: p,
        importance: Math.min(5, 2 + Math.floor(Math.log10(1 + (p.frequency || 1)))),
        source: stamp, source_ref: `qp_${p.rank || ''}`,
      });
      intel++;
    }
  }

  // Objection playbook → intelligence rows for Mehrban + exemplars
  if (objectionPlaybook && Array.isArray(objectionPlaybook.objections)) {
    for (const o of objectionPlaybook.objections) {
      // The agent rule for Mehrban
      await createIntelligence({
        kind: 'dm_objection', target_agent: 'mehrban',
        rule_text: `Objection (${o.frequency}×): ${o.objection_pattern}. ${o.agent_rule_for_mehrban || ''}`,
        rule_data: o, importance: 5, source: stamp, source_ref: `obj_${o.rank || ''}`,
      });
      intel++;
      // The best reply as an exemplar
      if (o.founder_best_reply && o.founder_best_reply.reply_text) {
        await createExemplar({
          kind: 'objection_handler',
          language: null, body: o.founder_best_reply.reply_text,
          context: o.verbatim_samples && o.verbatim_samples[0],
          topic_tags: [o.objection_pattern.toLowerCase().slice(0, 32)],
          importance: 5, source: stamp, source_ref: `obj_${o.rank || ''}`,
          outcome: o.founder_best_reply.outcome_proxy || 'engaged',
        });
        exem++;
      }
    }
  }

  // Voice fingerprint cluster (DM)
  if (voiceFingerprint && Array.isArray(voiceFingerprint.cluster)) {
    for (const c of voiceFingerprint.cluster) {
      await createFingerprint({
        cluster: 'dm_reply', language: c.language || 'en',
        body: c.founder_reply || '', why_picked: c.why_picked || null,
        importance: 5, source: stamp, source_ref: c.thread_id,
      });
      fp++;
    }
  }

  // Intent examples (Bineh training data)
  if (intentExamples && intentExamples.buckets) {
    for (const [bucket, items] of Object.entries(intentExamples.buckets)) {
      for (const it of (items || [])) {
        await createExemplar({
          kind: `intent_example_${bucket.replace('-', '_')}`,
          language: it.language || null,
          body: it.first_inbound || '',
          context: `signals: ${(it.signals || []).join(', ')}`,
          topic_tags: ['bineh', bucket],
          importance: 5, source: stamp, source_ref: it.thread_id,
          outcome: bucket,
        });
        exem++;
      }
    }
  }

  await query(`
    INSERT INTO brand_archive_uploads
      (upload_kind, source_label, intelligence_inserted, exemplars_inserted, fingerprint_inserted, meta)
    VALUES ('dm_archive', ${q(stamp)}, ${intel}, ${exem}, ${fp},
            ${qJson({ questionPatterns: !!questionPatterns, objectionPlaybook: !!objectionPlaybook, voiceFingerprint: !!voiceFingerprint, intentExamples: !!intentExamples })});`);

  clearCache();
  return { ok: true, source: stamp, intelligence: intel, exemplars: exem, fingerprint: fp };
}

// M56 Phase 2 · DM tone profile import (dm_tone_profile.json from local analyzer).
// Different from importDmAnalysis (which expects question_patterns + objection_playbook
// from DM-INSTRUCTIONS.md). This handles the broader tone-profile output.
async function importDmToneProfile({ toneProfile, sourceLabel = null }) {
  if (!toneProfile) return { ok: false, error: 'toneProfile required' };
  const stamp = sourceLabel || `dm_tone_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  let intel = 0, exem = 0, fp = 0;

  await query(`DELETE FROM brand_intelligence WHERE source = ${q(stamp)};`);
  await query(`DELETE FROM brand_exemplars     WHERE source = ${q(stamp)};`);

  // ── Reply latency (Mehrban response-time rule) ────
  if (toneProfile.reply_latency_buckets_pct) {
    const b = toneProfile.reply_latency_buckets_pct;
    const fast = (b['<5min'] || 0) + (b['5-30min'] || 0);
    await createIntelligence({
      kind: 'voice_rule', target_agent: 'mehrban', scope_platform: 'instagram',
      rule_text: `Historical reply latency: ${fast}% within 30min, p50=${Math.round((toneProfile.reply_latency_minutes && toneProfile.reply_latency_minutes.p50) || 0)}min. Aim to draft replies fast — hot leads should get a draft ready in <5min so the founder can send within 30min of receipt.`,
      rule_data: b, importance: 4, source: stamp,
      topic_tags: ['dm', 'latency'],
    });
    intel++;
  }

  // ── Length profile ────
  if (toneProfile.length && toneProfile.length.brand_words) {
    const lw = toneProfile.length.brand_words;
    const shortPct = toneProfile.length['brand_short_msg_pct (≤3 words)'] || 0;
    const longPct  = toneProfile.length['brand_long_msg_pct (≥30 words)'] || 0;
    await createIntelligence({
      kind: 'voice_rule', target_agent: 'mehrban', scope_platform: 'instagram',
      rule_text: `DM reply length: median ${lw.p50} words (p25=${lw.p25}, p75=${lw.p75}). ${shortPct}% are very short (≤3 words — quick acknowledgments), ${longPct}% are long (≥30 words — substantive). Match the conversation rhythm — don't over-explain.`,
      rule_data: lw, importance: 4, source: stamp,
      topic_tags: ['dm', 'length'],
    });
    intel++;
  }

  // ── Formality ────
  if (toneProfile.formality) {
    const f = toneProfile.formality;
    await createIntelligence({
      kind: 'voice_rule', target_agent: 'mehrban', scope_platform: 'instagram', scope_language: 'fa',
      rule_text: `Formality register: formal pronoun (شما) used in ${f.formal_pronoun_pct}% of messages, informal in ${f.informal_pronoun_pct}%. Honorifics (دکتر/خانم/آقای) in ${f['honorific_use_pct (دکتر/خانم/آقای/...)']}%. Default to formal+honorific unless audience signals informal first.`,
      rule_data: f, importance: 5, source: stamp,
      topic_tags: ['dm', 'formality', 'register'],
    });
    intel++;
  }

  // ── Top emojis ────
  if (toneProfile.emoji && Array.isArray(toneProfile.emoji.brand_top20)) {
    const top5 = toneProfile.emoji.brand_top20.slice(0, 5);
    const list = top5.map(e => `${e.emoji} (${e.count}×)`).join(', ');
    await createIntelligence({
      kind: 'voice_rule', target_agent: 'mehrban', scope_platform: 'instagram',
      rule_text: `Top emojis used in DMs: ${list}. ${toneProfile.emoji.brand_msgs_with_emoji_pct || 0}% of messages contain at least one emoji. Use 🌹 to soften / express warmth, 🙏 for thanks, 🌱 for hope. Never overuse — one or two per message.`,
      rule_data: { top: top5, msgs_with_emoji_pct: toneProfile.emoji.brand_msgs_with_emoji_pct },
      importance: 4, source: stamp,
      topic_tags: ['dm', 'emoji', 'tone'],
    });
    intel++;
  }

  // ── Greetings ────
  if (toneProfile.greetings && toneProfile.greetings.by_form) {
    const greets = toneProfile.greetings.by_form.slice(0, 3).map(g => `"${g.phrase}" (${g.count}×)`).join(', ');
    await createIntelligence({
      kind: 'opener_template', target_agent: 'mehrban', scope_platform: 'instagram', scope_language: 'fa',
      rule_text: `${toneProfile.greetings.msgs_starting_with_greeting_pct || 0}% of DM replies open with a greeting. Top forms: ${greets}. Use "سلام" for general; add "وقت بخیر" / "وقتتون بخیر" for first contact in a new thread.`,
      rule_data: toneProfile.greetings,
      importance: 4, source: stamp,
      topic_tags: ['dm', 'greeting', 'opener'],
    });
    intel++;
  }

  // ── Templated brand phrases → exemplars (real founder phrasings) ────
  if (Array.isArray(toneProfile.templated_brand_phrases_top30)) {
    for (const p of toneProfile.templated_brand_phrases_top30.slice(0, 8)) {
      await createExemplar({
        kind: 'dm_reply', platform: 'instagram', language: 'fa',
        body: p.phrase,
        context: `Recurring brand phrase used in ${p.n_conversations} distinct conversations`,
        topic_tags: ['dm', 'templated-phrase'],
        importance: 4, source: stamp, source_ref: `tmpl_${p.phrase.slice(0, 20)}`,
        outcome: 'recurring_brand_phrase',
      });
      exem++;
    }
  }

  // ── 10 brand canned replies → exemplars (importance 5 — these are gold) ────
  if (Array.isArray(toneProfile.brand_canned_replies_top10)) {
    for (let i = 0; i < toneProfile.brand_canned_replies_top10.length; i++) {
      const c = toneProfile.brand_canned_replies_top10[i];
      if (!c.text_preview) continue;
      // Infer topic tags from the canned reply text
      const tags = ['dm', 'canned-reply'];
      const t = c.text_preview.toLowerCase();
      if (/کارگاه|workshop/.test(t))      tags.push('workshop');
      if (/تخفیف|کد|coupon/.test(t))      tags.push('discount');
      if (/ویدیو|video/.test(t))         tags.push('video');
      if (/هدیه|gift/.test(t))           tags.push('gift');
      if (/ثبت\s*نام|register/.test(t))  tags.push('signup');
      if (/پیج|page|اینستاگرام/.test(t)) tags.push('engagement-ask');
      if (/ایمیل|email/.test(t))         tags.push('email-pivot');
      if (/مهاجرت|migration/.test(t))    tags.push('migration');
      if (/کانادا|آمریکا|آلمان/.test(t)) tags.push('country-info');

      await createExemplar({
        kind: 'dm_reply', platform: 'instagram', language: 'fa',
        body: c.text_preview,
        context: `Founder's canned reply, sent ${c.sent_n_times} times across the archive. Use as a starting template — adapt to the specific question.`,
        topic_tags: tags,
        importance: 5, source: stamp, source_ref: `canned_${i + 1}`,
        outcome: 'recurring_canned_reply',
      });
      exem++;
    }
  }

  // ── Audience FAQ phrases → signals for Bineh (intent triage) ────
  if (Array.isArray(toneProfile.audience_faq_phrases_top30)) {
    const top5 = toneProfile.audience_faq_phrases_top30.slice(0, 5);
    const list = top5.map(p => `"${p.phrase}" (${p.n_conversations} threads)`).join('; ');
    await createIntelligence({
      kind: 'dm_question_pattern', target_agent: 'bineh', scope_platform: 'instagram', scope_language: 'fa',
      rule_text: `Top opening phrases in inbound DMs: ${list}. Many threads start with greetings — don't classify on greeting alone; wait for the substantive question.`,
      rule_data: { phrases: top5 },
      importance: 4, source: stamp,
      topic_tags: ['dm', 'inbound', 'triage-signal'],
    });
    intel++;
  }

  // ── Contact pivot stats ────
  if (toneProfile.contact_pivot_pct) {
    const cp = toneProfile.contact_pivot_pct;
    await createIntelligence({
      kind: 'voice_rule', target_agent: 'mehrban', scope_platform: 'instagram',
      rule_text: `Contact pivots in DMs: site link ${cp['site link']||0}%, email pivot ${cp['email pivot']||0}%, phone share rare (${cp['phone-number share']||0}%). Prefer site link / email; never push phone number share unless audience asked.`,
      rule_data: cp, importance: 4, source: stamp,
      topic_tags: ['dm', 'contact-pivot'],
    });
    intel++;
  }

  // ── Provenance ────
  await query(`
    INSERT INTO brand_archive_uploads
      (upload_kind, source_label, intelligence_inserted, exemplars_inserted, fingerprint_inserted, meta)
    VALUES ('dm_tone_profile', ${q(stamp)}, ${intel}, ${exem}, ${fp},
            ${qJson({ scope: toneProfile.scope || null })});`);

  clearCache();
  return { ok: true, source: stamp, intelligence: intel, exemplars: exem, fingerprint: fp };
}

async function listUploads({ limit = 50 } = {}) {
  return await queryRows(`
    SELECT id::text, upload_kind, source_label,
            intelligence_inserted, exemplars_inserted, fingerprint_inserted,
            meta, created_at::text
      FROM brand_archive_uploads
      ORDER BY created_at DESC LIMIT ${parseInt(limit, 10) || 50};`);
}

async function counts() {
  const intel = parseInt(await queryValue(`SELECT COUNT(*)::int FROM brand_intelligence WHERE enabled = TRUE;`), 10) || 0;
  const exem  = parseInt(await queryValue(`SELECT COUNT(*)::int FROM brand_exemplars WHERE enabled = TRUE;`), 10) || 0;
  const fp    = parseInt(await queryValue(`SELECT COUNT(*)::int FROM brand_voice_fingerprint WHERE enabled = TRUE;`), 10) || 0;
  return { intelligence: intel, exemplars: exem, fingerprint: fp };
}

module.exports = {
  // Getters (hot path)
  getRulesForAgent, getExemplarsForAgent, getVoiceFingerprint,
  // Prompt-block renderers
  renderAsPromptBlock, renderExemplarsBlock,
  // Intelligence CRUD
  listIntelligence, createIntelligence, updateIntelligence, deleteIntelligence, hardDeleteIntelligence,
  // Exemplar CRUD
  listExemplars, createExemplar, updateExemplar, deleteExemplar,
  // Fingerprint CRUD
  listFingerprint, createFingerprint, updateFingerprint, deleteFingerprint,
  // Bulk import
  importPublicArchive, importDmAnalysis, importDmToneProfile,
  // Provenance + counts
  listUploads, counts,
  // Cache
  clearCache,
};
