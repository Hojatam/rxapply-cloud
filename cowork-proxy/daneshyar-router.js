// cowork-proxy/daneshyar-router.js
// =====================================================================
// K6 · Daneshyar — KB scholar agent.
//
// Routes (mounted by server.js):
//   POST /daneshyar/parse           {text, country?, hint?} → {entries, notes, cost}
//   POST /daneshyar/parse-and-save  {text, country?}        → {saved:[ids], cost}
//   POST /daneshyar/verify          {id}                    → {verdict, evidence, cost}
//   POST /daneshyar/find-more       {id}                    → {missing_facts, cost}
//   POST /daneshyar/refine          {id, new_source?}       → {suggested_patch, cost}
//
// Internally calls Anthropic with the per-agent LLM (Settings → Per-agent
// LLM model) plus injected brand block. Writes results back through
// knowledge-base.js so all UI/API readers stay consistent.
// =====================================================================

const agentModels = require('./agent-models');
const brandProfile = require('./brand-profile');
const agentMemory = require('./agent-memory');
const handoffs = require('./agent-handoffs');
const KB = require('./knowledge-base');

const DANESHYAR_PARSE_SYSTEM = `You are Daneshyar — RxApply's knowledge-base scholar.
Your job: parse the user-provided raw text into structured per-country fact
entries. One discrete fact per entry. Never invent. Never hedge.

Allowed countries: UK, USA, DE, AU, CA, UAE, SA, GLOBAL.
Allowed categories: exam, visa, milestone, regulator, timeline, cost, document, other.

OUTPUT FORMAT — return ONLY this JSON, nothing else:
{
  "entries": [
    {
      "country": "<code>",
      "category": "<one of allowed>",
      "title": "<short label>",
      "content": "<canonical wording, prose>",
      "facts": { "<key>": "<value>" },
      "tags": ["<tag1>", "<tag2>"],
      "importance": 1-5,
      "source": "<URL or 'founder note'>",
      "source_type": "parsed"
    }
  ],
  "notes": "<one sentence on ambiguity / what was skipped>"
}

Rules:
- Split lumped facts into separate entries (e.g. ORE Part 1 eligibility ≠ ORE Part 1 cost).
- facts must be structured key/value (numbers, dates, named entities only).
- importance: 5 legal requirement; 4 major cost/timeline; 3 useful; 2 minor; 1 trivia.
- If the source is silent on a field, omit it. No fabricated URLs.`;

const DANESHYAR_VERIFY_SYSTEM = `You are Daneshyar — verifying a single existing knowledge-base entry.
Read the entry, decide one of: active, stale, superseded, rejected.

OUTPUT FORMAT — return ONLY this JSON:
{
  "verdict": "active" | "stale" | "superseded" | "rejected",
  "verdict_reason": "<one sentence>",
  "evidence": "<short — what the entry says, plus your assessment>",
  "suggested_patch": null | { "content": "...", "facts": {...}, "title": "..." }
}

Rules:
- "active" = the entry still reads as accurate and well-formed.
- "stale" = facts look outdated (more than ~12 months without verification, or refers to old fee schedule, etc.).
- "superseded" = a specific newer rule replaces it; provide suggested_patch with the new wording.
- "rejected" = the entry is wrong or non-factual; provide suggested_patch=null.
You do NOT have web access — base your verdict on internal coherence + freshness signals.`;

const DANESHYAR_FIND_SYSTEM = `You are Daneshyar — surfacing related facts the KB is missing.
Given one anchor entry (country + category + title + content), propose 3-8 facts
that a complete KB on this topic would contain but the founder hasn't added yet.

OUTPUT FORMAT — return ONLY this JSON:
{
  "anchor_entry_id": "<echo>",
  "country": "<echo>",
  "category": "<echo>",
  "missing_facts": [
    { "title": "<short label>", "why": "<one sentence on why this matters>", "category": "<allowed category>" }
  ]
}

Rules:
- Be specific. "ORE Part 2 → registration timeline" beats "more about ORE".
- Cover cost, timeline, eligibility, common pitfalls, document requirements where relevant.
- Never invent values; just propose the titles and reasons.`;

// ── Generic Anthropic call (JSON-only) ────────────────────────────────
async function _callAnthropic(model, systemPrompt, userPrompt, maxTokens = 2500) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  let text = ((j.content || []).filter(c => c.type === 'text').map(c => c.text).join('')).trim();
  // Strip ``` fences and trim to JSON braces.
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    text = lines.join('\n');
  }
  if (!text.startsWith('{')) {
    const i = text.indexOf('{');
    if (i >= 0) text = text.slice(i);
  }
  if (!text.endsWith('}')) {
    const i = text.lastIndexOf('}');
    if (i > 0) text = text.slice(0, i + 1);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error(`model returned non-JSON: ${e.message}`); }
  const usage = j.usage || {};
  const cost = agentModels.calcCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
  return { parsed, model: j.model || model,
            input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
            cost_usd: cost };
}

// ── Operations ────────────────────────────────────────────────────────

async function parse({ text, country = null, hint = null }) {
  if (!text || String(text).trim().length < 10) {
    return { ok: false, error: 'text too short' };
  }
  const detected = country || KB.detectCountry(text);
  const { id: model } = agentModels.resolveModel('daneshyar');
  const brand = brandProfile.renderAsPromptBlock();
  const memory = agentMemory.renderAsBlock('daneshyar', { limit: 4 });
  const sys = [DANESHYAR_PARSE_SYSTEM, brand, memory].filter(Boolean).join('\n\n');
  const usr = [
    detected ? `Default country if unclear: ${detected}` : null,
    hint ? `Founder hint: ${hint}` : null,
    `Raw text to parse:`,
    String(text).slice(0, 12000),
    `\nReturn the entries JSON now.`,
  ].filter(Boolean).join('\n\n');
  const r = await _callAnthropic(model, sys, usr, 3000);
  // Log episodic memory
  try {
    agentMemory.write({
      agent: 'daneshyar', type: 'episodic',
      content: `parsed ${(r.parsed.entries||[]).length} entries from ${String(text).length}-char source` +
                (detected ? ` (country=${detected})` : ''),
      tags: ['kb','parse', detected || 'unknown'].filter(Boolean),
      importance: 2, source: 'auto',
    });
  } catch (_) { /* non-fatal */ }
  return { ok: true, entries: r.parsed.entries || [], notes: r.parsed.notes || '',
           detected_country: detected,
           model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
           cost_usd: r.cost_usd };
}

async function parseAndSave({ text, country = null, hint = null }) {
  const r = await parse({ text, country, hint });
  if (!r.ok) return r;
  const saved = [];
  const errors = [];
  for (const e of (r.entries || [])) {
    const ins = KB.add({
      country: e.country, category: e.category, title: e.title, content: e.content,
      facts: e.facts || {}, source: e.source, sourceType: 'parsed',
      tags: e.tags || [], importance: e.importance || 3, status: 'draft',
      verifiedBy: null,
    });
    if (ins.ok) saved.push({ id: ins.id, title: e.title, country: e.country, category: e.category });
    else errors.push({ title: e.title, error: ins.error });
  }
  return { ok: true, saved, errors, notes: r.notes,
           detected_country: r.detected_country,
           model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
           cost_usd: r.cost_usd };
}

async function verify({ id }) {
  const entry = KB.getOne(id);
  if (!entry) return { ok: false, error: 'entry not found' };
  const { id: model } = agentModels.resolveModel('daneshyar');
  const brand = brandProfile.renderAsPromptBlock();
  const sys = [DANESHYAR_VERIFY_SYSTEM, brand].filter(Boolean).join('\n\n');
  const usr = `Entry to verify:\n` +
              `country: ${entry.country}\ncategory: ${entry.category}\n` +
              `title: ${entry.title}\ncontent: ${entry.content}\n` +
              `facts: ${JSON.stringify(entry.facts || {})}\n` +
              `source: ${entry.source || '(none)'}\n` +
              `verified_at: ${entry.verified_at || '(never)'}\n\n` +
              `Return the verify JSON now.`;
  const r = await _callAnthropic(model, sys, usr, 1500);
  // If active, mark verified by daneshyar
  try {
    if (r.parsed.verdict === 'active') KB.markVerified(id, 'daneshyar');
    else if (r.parsed.verdict === 'stale') KB.markStale(id);
    // 'superseded' / 'rejected' left for founder to act on (would otherwise auto-mutate).
  } catch (_) { /* non-fatal */ }
  return { ok: true, verdict: r.parsed.verdict, verdict_reason: r.parsed.verdict_reason,
           evidence: r.parsed.evidence, suggested_patch: r.parsed.suggested_patch,
           model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
           cost_usd: r.cost_usd };
}

async function findMore({ id }) {
  const entry = KB.getOne(id);
  if (!entry) return { ok: false, error: 'entry not found' };
  const { id: model } = agentModels.resolveModel('daneshyar');
  const brand = brandProfile.renderAsPromptBlock();
  const sys = [DANESHYAR_FIND_SYSTEM, brand].filter(Boolean).join('\n\n');
  const usr = `Anchor entry id: ${entry.id}\ncountry: ${entry.country}\ncategory: ${entry.category}\n` +
              `title: ${entry.title}\ncontent: ${entry.content}\n\n` +
              `Return the missing-facts JSON now.`;
  const r = await _callAnthropic(model, sys, usr, 1500);
  return { ok: true, anchor_entry_id: entry.id, country: entry.country, category: entry.category,
           missing_facts: r.parsed.missing_facts || [],
           model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
           cost_usd: r.cost_usd };
}

module.exports = { parse, parseAndSave, verify, findMore };
