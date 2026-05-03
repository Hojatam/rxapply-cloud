// cowork-proxy/kb-protected-terms.js
// =====================================================================
// M41 · Auto-derive a "protected terms" glossary from the KB.
//
// These are terms whose meaning must NOT drift across languages: regulators,
// exam names, institutions, brand-defined acronyms, country-licensure terms.
// Used by Daneshyar's verify-translation stage to cross-check that every
// translation preserves them faithfully.
//
// IMPORTANT — no seeding from outside.
// The glossary is built ENTIRELY from KB content. If a term doesn't appear
// in the KB, it isn't protected. As the founder enriches the KB, the
// glossary grows automatically. No hard-coded lists in this file.
//
// Two extraction passes:
//   1. Per-entry metadata `protected_terms: ["NDEB", "ORE"]` (preferred —
//      KB authors mark terms explicitly when adding entries)
//   2. Heuristic regex scan for ALL-CAPS acronyms (2-5 chars) that recur
//      across multiple KB entries — picks up implicit protected terms
//
// Pass 2 is the safety net while you build the KB up; over time as you tag
// terms in pass 1, the heuristic gets less work to do.
// =====================================================================

'use strict';

const { queryRows, queryValue, q } = require('./db');

let _cache = null;
let _cacheUntil = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour

// Heuristic: ALL-CAPS sequences of 2-5 letters, optional trailing dot,
// not preceded/followed by lowercase letters. Filters out random sentence-start
// caps. Examples it catches: NDEB, ORE, GDC, AHPRA, AGAM, IELTS, OET.
const ACRONYM_REGEX = /(?<![A-Za-z])([A-Z]{2,5})(?![a-z])/g;

// Common English / Persian / Arabic stop-words that look like acronyms but aren't.
const STOPLIST = new Set([
  'IS', 'AT', 'BY', 'OF', 'TO', 'IN', 'ON', 'OR', 'AS', 'AN', 'BE', 'DO',
  'WE', 'ME', 'IT', 'IF', 'NO', 'SO', 'ALL', 'AND', 'BUT', 'NOT', 'YOU',
  'THE', 'FOR', 'ARE', 'WAS', 'HAS', 'CAN', 'OUR', 'ONE', 'TWO', 'NEW',
  'WAY', 'GET', 'USE', 'NOW', 'OUT', 'YES', 'TIP', 'TOP', 'HOT', 'OFF',
  'PDF', 'JPG', 'PNG', 'URL',
]);

async function _scanFromKb() {
  // Pass 1 — explicit metadata.protected_terms
  let explicit = [];
  try {
    const rows = await queryRows(`
      SELECT metadata
        FROM knowledge_base
       WHERE metadata ? 'protected_terms'
       LIMIT 1000;
    `);
    for (const r of (rows || [])) {
      const m = r.metadata;
      if (m && Array.isArray(m.protected_terms)) {
        for (const t of m.protected_terms) {
          if (t && typeof t === 'string') explicit.push(String(t).trim());
        }
      }
    }
  } catch (_) { /* table may not exist yet; non-fatal */ }

  // Pass 2 — heuristic ALL-CAPS scan across ALL KB content text
  const acronymCounts = {};
  try {
    const rows = await queryRows(`
      SELECT content
        FROM knowledge_base
       WHERE COALESCE(archived, false) = false
       LIMIT 5000;
    `);
    for (const r of (rows || [])) {
      const txt = String(r.content || '').slice(0, 50000);
      let m;
      ACRONYM_REGEX.lastIndex = 0;
      while ((m = ACRONYM_REGEX.exec(txt)) !== null) {
        const tok = m[1];
        if (STOPLIST.has(tok)) continue;
        acronymCounts[tok] = (acronymCounts[tok] || 0) + 1;
      }
    }
  } catch (_) { /* same — non-fatal */ }

  // Only keep acronyms that recur across ≥3 occurrences (filters noise)
  const heuristic = Object.entries(acronymCounts)
    .filter(([_, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);

  // Merge + dedupe (case-sensitive — "NDEB" and "Ndeb" are intentionally different)
  const merged = Array.from(new Set([
    ...explicit,
    ...heuristic,
  ])).filter(Boolean);

  return {
    generated_at: new Date().toISOString(),
    n_explicit: explicit.length,
    n_heuristic: heuristic.length,
    n_total: merged.length,
    terms: merged,
  };
}

async function get({ refresh = false } = {}) {
  if (!refresh && _cache && Date.now() < _cacheUntil) return _cache;
  _cache = await _scanFromKb();
  _cacheUntil = Date.now() + CACHE_TTL_MS;
  return _cache;
}

// For inclusion in LLM prompts
async function renderAsPromptBlock() {
  const g = await get();
  if (!g.terms.length) {
    return '# Protected terms\n(none yet — KB is empty or has no taggable terms)';
  }
  return [
    `# Protected terms (auto-derived from KB · ${g.terms.length} terms)`,
    '',
    'These terms must be preserved EXACTLY as they appear here when translating',
    'or paraphrasing. Do NOT translate, abbreviate, or substitute. They are',
    'regulator names, exam names, institutions, and brand-defined terms.',
    '',
    g.terms.map(t => `  - ${t}`).join('\n'),
  ].join('\n');
}

module.exports = { get, renderAsPromptBlock };
