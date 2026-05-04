// cowork-proxy/compose-orchestrator.js
// =====================================================================
// M24 · Compose orchestrator — recipe-driven, multi-format, multi-stage.
//
// Replaces compose-stages.js (which was hardcoded to the IG flow) with a
// generic engine that reads a recipe JSON and runs its stages in order,
// honouring:
//   • per-run agent overrides
//   • per-run gate strategy (none / critique / critique+adapt / every)
//   • per-run language selection (master + targets, translate after gates)
//   • per-stage capability resolution via agent-capabilities.js
//   • handoff_intent emitted by agents (recorded but non-blocking)
//   • cost rollup per run / per stage
//
// Public API:
//   start(input)       → creates a compose_runs row, returns { id }
//   tick(runId)        → advances the run by one stage; returns updated run
//   approve(runId, note)   → unblocks an awaiting_approval run
//   getRun(runId)      → run + ordered stages
//   listRuns({limit, recipe, status})
//
// The orchestrator does NOT loop autonomously after a gate. The HTTP
// route calls tick() repeatedly until status changes to a terminal or
// blocked state. Streaming a run's progress to the dashboard is a thin
// SSE wrapper over tick().
// =====================================================================

const path = require('path');
const fs   = require('fs');

const { query, queryValue, queryReturning, q, qJson, qArr } = require('./db');
const llm           = require('./llm');
const agentModels   = require('./agent-models');
const agentMemory   = require('./agent-memory');
const brandProfile  = require('./brand-profile');
const KB            = require('./knowledge-base');
const handoffs      = require('./agent-handoffs');
const capabilities  = require('./agent-capabilities');
const renderers     = require('./compose-renderers');
const logWriter     = require('./log-writer');
const protectedTerms = require('./kb-protected-terms');
const costRouter     = require('./cost-aware-router');
const contracts      = require('./agent-contracts');     // M49 · per-stage output validation
const brandInt       = require('./brand-intelligence');  // M55 · dynamic brand training data
const trainingRetrieval = require('./agent-training-retrieval');  // M56 · unified topic-aware retrieval

const RECIPES_DIR = path.resolve(__dirname, '..', 'compose-recipes');

// ── Recipe loading (M72A: DB-backed via cowork-proxy/pipelines.js) ───
//
// Resolution order on the hot path (sync — orchestrator's stage tick):
//   1. pipelines.getCachedSync(id) — populated by pipelines.refreshCache()
//      (DB pull, runs at boot + on every save)
//   2. compose-recipes/<id>.json file fallback (boot safety + during the
//      transition window where DB hasn't been seeded yet)
//
// pipelines.onChange wires cache invalidation in both directions: when
// the founder saves a pipeline via the API, our local cache flips, the
// next stage tick sees the new definition.
const pipelines = require('./pipelines');
let _fileCache = null;          // legacy file-based fallback cache
let _dbReady = false;           // flips true once DB seed/refresh succeeds

function _loadRecipesFromFiles() {
  if (_fileCache) return _fileCache;
  const out = {};
  if (fs.existsSync(RECIPES_DIR)) {
    for (const f of fs.readdirSync(RECIPES_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, f), 'utf8'));
        if (r && r.id) out[r.id] = r;
      } catch (e) {
        console.error(`[compose] bad recipe ${f}: ${e.message}`);
      }
    }
  }
  _fileCache = out;
  return out;
}

// Background seed + cache warm. Called once from server boot. Best-effort —
// if the DB isn't ready yet (e.g. first deploy before migration runs), we
// silently fall back to file-based recipes until the next refresh succeeds.
async function ensurePipelinesLoaded() {
  try {
    const seedRes = await pipelines.seedFromFiles({ recipesDir: RECIPES_DIR });
    if (seedRes && seedRes.seeded > 0) {
      console.log(`[pipelines] seeded ${seedRes.seeded} pipelines from ${RECIPES_DIR}`);
    }
    await pipelines.refreshCache();
    _dbReady = true;
  } catch (e) {
    console.warn('[pipelines] DB load failed, falling back to file-based recipes:', e.message);
    _dbReady = false;
  }
}

// Re-run on every pipelines change so any cross-cutting state stays fresh.
pipelines.onChange(() => { _dbReady = pipelines.listCachedSync().length > 0; });

function getRecipe(id) {
  const fromDb = _dbReady ? pipelines.getCachedSync(id) : null;
  if (fromDb && fromDb.definition) return fromDb.definition;
  const fromFile = _loadRecipesFromFiles()[id];
  if (fromFile) return fromFile;
  throw new Error(`Unknown recipe: ${id}`);
}
function listRecipes() {
  // Prefer DB list when ready; otherwise file list. Both produce the same shape.
  const fromDb = _dbReady ? pipelines.listCachedSync() : [];
  const list = fromDb.length
    ? fromDb.map(p => p.definition || {})
    : Object.values(_loadRecipesFromFiles());
  return list.map(r => ({
    id: r.id, label: r.label, icon: r.icon || null,
    description: r.description || '',
    options_schema: r.options_schema || [],
    default_target_langs: r.default_target_langs || [],
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────
function _shouldGate(stageName, recipe, strategy) {
  if (strategy === 'none') return false;
  if (!(recipe.gateable_stages || []).includes(stageName)) return false;
  if (strategy === 'every') return true;
  if (strategy === 'critique') return stageName === 'critique';
  if (strategy === 'critique+adapt') return stageName === 'critique' || stageName === 'adapt';
  return false;
}

function _stripJsonFences(text) {
  let body = String(text || '').trim();
  if (body.startsWith('```')) {
    const lines = body.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    body = lines.join('\n');
  }
  if (!body.startsWith('{') && !body.startsWith('[')) {
    const i = Math.min(...['{','['].map(c => { const k = body.indexOf(c); return k < 0 ? Infinity : k; }));
    if (i !== Infinity) body = body.slice(i);
  }
  return body;
}

function _parseJsonOrThrow(text, contextLabel) {
  const body = _stripJsonFences(text);
  try { return JSON.parse(body); }
  catch (e) {
    throw new Error(`${contextLabel}: model returned non-JSON. ${e.message}. First 200 chars: ${String(text).slice(0, 200)}`);
  }
}

// Build the system prompt for a stage. Composed of:
//   • the agent's base SKILL prompt (from prompt-versions if present)
//   • brand context
//   • KB block (for research / draft / critique)
//   • per-agent memory
//   • the stage-specific instruction template
async function _buildSystemPrompt({ agent, stageName, recipe, run, masterDraft, lang, protectedTermsBlock = null, fingerprintBlock = null }) {
  const blocks = [];

  // The agent's own SKILL is loaded from disk (agents/<agent>/SKILL.md).
  // We keep it in the system prompt so the agent's voice carries even
  // when invoked via this orchestrator, not via /agent-chat.
  try {
    const skillPath = path.resolve(__dirname, '..', 'agents', agent, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const md = fs.readFileSync(skillPath, 'utf8');
      if (md && md.trim()) blocks.push(`# ${agent}'s base brief\n${md}`);
    }
  } catch (_) { /* non-fatal */ }

  // M68 · Stage-specific instruction template, resolution order:
  //   1. recipe.stage_prompts[stageName]   — per-recipe override (rare)
  //   2. agents/<agent>/stages/<stage>.md  — per-agent stage file (preferred)
  //   3. _DEFAULT_STAGE_PROMPTS[stage]     — hardcoded last-resort fallback
  // The per-agent file is the source of truth; the dashboard's Pipeline tab
  // edits it directly. Cache with file-mtime invalidation.
  let tmpl = (recipe.stage_prompts && recipe.stage_prompts[stageName])
          || _loadStagePrompt(agent, stageName)
          || _DEFAULT_STAGE_PROMPTS[stageName];
  if (tmpl) {
    blocks.push(`# This stage: ${stageName}\n${_renderTemplate(tmpl, { run, recipe, masterDraft, lang })}`);
  }

  // Brand profile (always included — every output has to match the brand).
  const brand = brandProfile.renderAsPromptBlock();
  if (brand) blocks.push(brand);

  // KB grounding for research / verify / verify-translation / draft / critique / audit stages
  if (['research', 'verify', 'verify-translation', 'draft', 'critique', 'audit'].includes(stageName)) {
    try {
      const country = KB.detectCountry(run.topic);
      const kb = KB.renderAsBlock({ country, query: run.topic, limit: 6 });
      if (kb) blocks.push(kb);
    } catch (_) { /* non-fatal */ }
  }

  // M41 · Protected terms glossary — auto-derived from KB, never seeded.
  // Injected for verify-translation (where it matters most) and translate (so the translator
  // sees the protected list before it's checked against). Empty on first run; grows as KB grows.
  if (protectedTermsBlock && ['verify-translation', 'translate'].includes(stageName)) {
    blocks.push(protectedTermsBlock);
  }

  // M50 · Voice fingerprint cluster — injected ONLY for the voice-critic stage.
  // Empty cluster → orchestrator skips this stage entirely (handled upstream).
  if (fingerprintBlock && stageName === 'voice-critic') {
    blocks.push(fingerprintBlock);
  }

  // M56 · Unified, budgeted, topic-aware retrieval. ONE call replaces:
  //   - the old per-agent memory dump (6 items, no relevance ranking)
  //   - brandInt.renderAsPromptBlock (top-25 rules with no topic match)
  //   - brandInt.renderExemplarsBlock (top-3 exemplars, no rotation)
  // Per-stage budgets are tight (typical: 3 rules + 2 exemplars + 5 memories).
  // Topic_tags drive matching — empty topic_tags treats as "applies to all topics."
  // Conflicts between global rules and per-agent memories are surfaced in-prompt
  // so the model resolves toward the more-specific instruction explicitly.
  try {
    const platform = recipe && recipe.id;
    const topicKw = String(run.topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5).map(s => s.toLowerCase());
    const packet = await trainingRetrieval.getTrainingPacket({
      agent, stageName, platform,
      language: lang || run.master_lang,
      topicTags: topicKw,                  // simple topic-tag inference from the topic words
      recipe,
    });
    const block = trainingRetrieval.renderUnifiedBlock(packet);
    if (block) blocks.push(block);
  } catch (e) {
    // Fallback to legacy renderers (graceful degradation if retrieval fails)
    try {
      const mem = agentMemory.renderAsBlock(agent, {
        limit: 6,
        queryKeywords: String(run.topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5),
      });
      if (mem) blocks.push(mem);
    } catch (_) {}
  }

  return blocks.join('\n\n');
}

// Default per-stage instruction templates. Each recipe can override
// any of these via `stage_prompts: { stageName: "..." }`.
const _DEFAULT_STAGE_PROMPTS = {
  plan:
`Given the topic + audience below, produce a structured plan that downstream
stages will use. Return ONLY this JSON (no prose, no markdown):

{
  "topic": "<echoed topic>",
  "audience_pain_point": "<one sentence — the specific frustration this content addresses>",
  "angle": "<one sentence — the perspective / hook>",
  "channel_fit_notes": "<one or two sentences on what this format demands; e.g. email needs subject + preview>",
  "success_criteria": ["<criterion 1>", "<criterion 2>", "..."],
  "complexity": "trivial | standard | deep",
  "complexity_reason": "<one sentence — why this complexity tier>",
  "handoff_intent": null
}

Complexity guide (M40 · effort-scaling — every level still runs verify):
  • trivial  — short, casual post on a topic the KB already covers well
                (a daily Telegram update, a quick IG caption with no new claims).
                Skips the structured RESEARCH stage; KB block is still injected
                into the draft so the agent has full KB access.
  • standard — most content. Needs structured research + critique + verify.
                Default for any post that takes a position, makes claims,
                or covers a topic at length. (DEFAULT if you can't decide.)
  • deep     — high-stakes content (regulatory deep-dive, official launches,
                country-launch announcements, anything where a hallucinated fact
                would damage trust). Adds adversarial audit on top of standard.

Bias toward "standard" when uncertain. Never pick "trivial" for content that
makes regulatory / numeric / legal claims. Never pick "deep" for short posts.`,

  research:
`Given the plan below, research the topic. Cite real institutions / regulators / numbers from the
knowledge base — never invent URLs. Return ONLY this JSON:

{
  "key_facts": ["<fact 1 with named source>", "..."],
  "regulatory_context": "<one sentence — relevant regulator or 'none'>",
  "competitor_angles": ["<angle 1>", "..."],
  "must_avoid": ["<phrase or claim to NOT make>"],
  "sources_used": ["<name of KB section / institution>"],
  "handoff_intent": null
}`,

  verify:
`You are Daneshyar, the KB-grounded fact verifier. Cross-check every numeric / regulatory / institutional
claim in the upstream RESEARCH and DRAFT below against the knowledge base block in your system prompt.
Mark anything you cannot verify. Do NOT propose new facts; only verify the existing ones.

Return ONLY this JSON:

{
  "passed": true | false,
  "verified_facts": [
    { "claim": "<exact claim>", "kb_reference": "<which KB doc / section>", "confidence": 0.00 }
  ],
  "issues": [
    { "claim": "<exact claim>", "problem": "<why it's wrong / unverifiable>", "fix": "<safer phrasing or removal>" }
  ],
  "overall_confidence": 0.00,
  "handoff_intent": null
}

Pass requires: zero issues with confidence < 0.7 AND no claim flagged "unverifiable" or "wrong".`,

  draft:
`Using the plan + research, write the FIRST DRAFT in the master voice for the format below.
Format: {{recipe.label}}. Length target (recipe-level guidance): {{recipe.length_target_words}}.
Master language: {{run.master_lang}}. Do NOT translate; downstream stages handle that.

PRIORITY ORDER FOR LENGTH AND VOICE (M58 hard rule):
  1. The "Brand intelligence" rules in your system prompt are the BRAND'S
     ACTUAL DATA from 5 years of real posts. They WIN. If a brand rule
     says caption length is "38–75 words" and the recipe says something
     different, FOLLOW THE BRAND RULE.
  2. Brand voice opener patterns (lead-with-bullet emoji, plain-statement
     etc.) — match the highest-frequency pattern relevant to platform+language.
  3. Brand voice CTA patterns — use the dominant statement-close style;
     hard-sell CTAs are explicitly avoided by the brand (<2% of all posts).
  4. The recipe's length range above is a fallback ONLY when no brand
     length rule is present in your system prompt.

HARD CAPS (never exceed):
  • Instagram FA: never exceed 119 words (brand p95).
  • Telegram FA:  never exceed 139 words (brand p95).
  • If you write past these, the critique stage WILL fail the draft.

Return ONLY this JSON:

{
  "title": "<the headline / subject / hook line>",
  "body": "<the full draft body in the master language>",
  "word_count": <integer — count words in body, you must be honest>,
  "tone_notes": "<one sentence — how the voice carries>",
  "length_check": "<one sentence — which brand length rule applies and your word count vs that range>",
  "handoff_intent": null
}`,

  critique:
`Score the draft below against brand voice + format rules. Brand-voice rules in
your system prompt are the SOURCE OF TRUTH (5 years of real post data).

LENGTH CHECK — do this first, mechanically:
  1. Count words in draft.body.
  2. Look up the platform+language length rule in your "Brand intelligence"
     block (e.g. "instagram-fa caption length: target 38.5-75.5 words ...
     p95 = 119; rarely exceed").
  3. If word count > p95 from the brand rule → set verdict = "fail" and
     length_score = 0.00 with the actionable_fix "Cut to <range> words —
     current draft is N words, brand p95 is M".
  4. If word count is between target_max and p95 → length_score = 0.50,
     verdict at most "needs_refine", actionable_fix to bring it into target.
  5. If word count is in target range → length_score = 1.00.
  6. If word count is far below target_min → length_score = 0.50 (under-spec).

Return ONLY this JSON:

{
  "verdict": "pass" | "needs_refine" | "fail",
  "verdict_reason": "<one sentence — call out length explicitly if that's the issue>",
  "word_count": <integer>,
  "length_rule_applied": "<the exact brand length rule you applied, verbatim>",
  "scores": {
    "brand_voice": 0.00,
    "specificity": 0.00,
    "cta_present": 0.00,
    "banned_phrases_clean": 0.00,
    "format_fit": 0.00,
    "length_fit": 0.00
  },
  "actionable_fixes": ["<fix 1>", "..."],
  "handoff_intent": null
}

A draft passes if every score >= 0.70 AND no banned phrase AND word_count <= brand p95.
Length over p95 is an automatic FAIL regardless of other scores.`,

  audit:
`You are running RED-TEAM audit on a draft about to publish on RxApply. This
is the LAST line of defense before high-stakes content (regulator deep-dives,
country-launch posts, anything where a hallucinated fact damages trust)
goes out. Be adversarial. Be specific.

This audit is **KB-only**: the KB block in your system prompt is the ONLY
acceptable source of truth. If a claim isn't supported by the KB block, it
is UNCITED — even if the claim sounds plausible or you "know" it from training
data. Treat training-data knowledge as not present.

THREE-PASS FLOW:

  Pass 1 — Claim extraction.
    Extract every CHECKABLE claim in the draft. A checkable claim is any of:
      • A number (fee, score, year, count, percentage, timeline)
      • A date or range
      • A regulator / institution / exam name
      • A legal / immigration / licensure assertion ("you must…", "to be eligible…")
      • A geographic / jurisdictional claim ("in Ontario…", "for federal NDEB…")
    Skip pure opinion / stylistic / brand-voice statements.

  Pass 2 — Citation lookup.
    For each extracted claim, look in the KB block for a supporting source.
    Mark its status:
      • "cited"        — supported by a specific KB section (quote a fragment)
      • "partial"      — KB has related context but doesn't directly support
                         this exact claim (e.g. KB says "NDEB is required",
                         draft says "NDEB Part 1 in 2026 costs $1,200" — fee
                         not in KB)
      • "uncited"      — no KB support; could be hallucinated
      • "conflicting"  — KB explicitly contradicts the claim
    For cited claims, include the KB fragment you matched against.

  Pass 3 — Verdict.
    Block if ANY claim is "uncited" or "conflicting".
    Pass-with-flags if any claim is "partial" (founder reviews).
    Pass clean if all claims are "cited".

Return ONLY this JSON:

{
  "verdict": "pass" | "pass_with_flags" | "block",
  "summary": "<one sentence — why this verdict>",
  "claims": [
    {
      "claim": "<the exact phrase from the draft, verbatim>",
      "kind": "number | date | regulator | legal | jurisdictional",
      "status": "cited | partial | uncited | conflicting",
      "kb_fragment": "<the exact KB text supporting this claim, or null if uncited>",
      "kb_section_ref": "<short label/title of the KB section, or null>",
      "fix": "<safer phrasing OR 'remove' OR 'add KB entry on X first'>",
      "severity": "high | medium | low"
    }
  ],
  "uncited_count": <int>,
  "conflicting_count": <int>,
  "partial_count": <int>,
  "cited_count": <int>,
  "handoff_intent": null
}

Severity rule:
  • "high"   = numeric / regulatory / legal claim that's uncited or conflicting
  • "medium" = jurisdictional or institutional claim that's uncited
  • "low"    = stylistic claim or "partial" with reasonable adjacency in KB

Block any draft with ≥1 high-severity uncited or conflicting claim. The fix
field for those should suggest either "remove" or "add KB entry on <topic>
first" — do NOT suggest the founder add information that isn't yet in the KB.`,

  adapt:
`Reshape the approved draft into channel-native form for {{recipe.label}}. Produce the fields
listed in params.produce. Return ONLY this JSON:

{
  "fields": {
    /* keys from params.produce — e.g. for email: "subject", "preview", "body" */
  },
  "handoff_intent": null
}`,

  translate:
`Translate the master output into {{lang}} ({{lang}}). Preserve the tone, the CTAs,
the named entities (regulators, institutions). Do NOT add new claims. Use the
PROTECTED TERMS list in your system prompt — those terms must appear EXACTLY
as listed; do NOT translate them, abbreviate, or substitute.

Return ONLY this JSON:

{
  "fields": {
    /* same keys as the input "fields", translated */
  },
  "handoff_intent": null
}`,

  'verify-translation':
`You are Daneshyar performing back-translation QA on the {{lang}} translation
above. The MASTER output is in the language indicated; the TRANSLATED output
is in {{lang}}.

Your task — three passes:

  1. **Back-translation pass.** Mentally back-translate the {{lang}} version
     to the master language. Compare to the master. Flag any meaning drift
     (claims that changed, intensity that shifted, CTAs that softened or
     hardened, regulators / numbers / dates that moved).

  2. **Protected-terms pass.** Every term in the PROTECTED TERMS list (in
     your system prompt) MUST appear in the translation EXACTLY as listed.
     If a protected term was translated, abbreviated, or replaced, flag it.

  3. **KB consistency pass.** Cross-check every claim in the translation
     against the KB block in your system prompt. If the translation introduces
     a claim the master didn't make AND that claim isn't supported by KB,
     flag it.

Return ONLY this JSON:

{
  "passed": true | false,
  "issues": [
    { "kind": "meaning-drift | protected-term | kb-claim",
      "severity": "high | medium | low",
      "master_phrase": "<exact text from master>",
      "translated_phrase": "<exact text from translation>",
      "problem": "<one sentence>",
      "fix": "<safer phrasing>"
    }
  ],
  "protected_terms_check": {
    "n_protected_terms_in_glossary": <int>,
    "n_terms_present_in_translation": <int>,
    "n_terms_violated": <int>
  },
  "overall_confidence": 0.00,
  "handoff_intent": null
}

Pass requires: zero high-severity issues AND no protected-term violations.
A medium-severity meaning drift is OK to flag but does NOT fail the run.`,

  'voice-critic':
`You are Bidar, performing M50 voice-fingerprint check. The brand's
canonical voice is captured in the FINGERPRINT block in your system
prompt — those paragraphs are real published posts the founder marked
as canonical. Score the CANDIDATE draft below for voice match against
that cluster.

You are NOT judging quality, accuracy, or topic. You are judging
**voice match** — does this read like an RxApply post or could it
be from any other Persian dental-education account?

Look for:
  • Opener pattern (bullet-emoji lead vs question vs plain — match the
    cluster's distribution)
  • Sentence rhythm + length (short statements vs long sweeping claims)
  • Punctuation tics (em-dash, dot-on-its-own-line, ellipsis, line-break density)
  • Voice-signature words (recurring phrases the brand uses)
  • Tone register (restrained / authoritative / warm / clinical)
  • What's MISSING — banned phrases, hype words, first-person, clickbait

If the FINGERPRINT block is empty (no exemplars provided), return
verdict="skipped" with reason="no fingerprint data yet".

Return ONLY this JSON:

{
  "verdict": "pass" | "needs_voice_polish" | "block" | "skipped",
  "voice_match_score": 0.00,
  "n_fingerprint_compared": <int>,
  "matches": [
    "<aspect of the candidate that aligns with the cluster, one short bullet>",
    "<...>"
  ],
  "drift_concerns": [
    {
      "aspect": "opener | rhythm | punctuation | signature_words | tone | banned_phrase | other",
      "observed": "<what the candidate did>",
      "expected": "<what the cluster does>",
      "severity": "high | medium | low",
      "fix": "<one short suggestion>"
    }
  ],
  "canonical_examples_referenced": ["<short quote from a fingerprint exemplar that anchors your judgement>"],
  "summary": "<one sentence>",
  "skipped_reason": null,
  "handoff_intent": null
}

Verdict thresholds:
  • pass               — voice_match_score >= 0.80, no high-severity drift
  • needs_voice_polish — score 0.60-0.79 OR exactly one high-severity drift
  • block              — score < 0.60 OR ≥2 high-severity drifts (e.g. used
                          a banned phrase + first-person, or hype + clickbait)
  • skipped            — fingerprint empty

Be DECISIVE about scoring. A vague "pretty close" verdict isn't useful — pick
a number based on actual voice fidelity to the cluster.`,

  'carousel-plan':
`You are Tarrah, the carousel slide planner. Read your SKILL above for
the slot vocabulary and the brand templates. Your job: turn the topic +
research key_facts into a structured slide spec for Afshin to render.

Hard rules (re-stated for safety):
  • Never repeat the caption. The caption (in the ADAPTED block) teases.
    Slides educate using research key_facts.
  • Never write paragraphs. Bullets, key_numbers, short lines.
  • Word caps are real. Title ≤ 5 words. Subtitle ≤ 8. Bullets ≤ 4 each.
  • Persian numerals (۰۱۲۳۴۵۶۷۸۹) on Persian slides; Latin on Latin.
  • Every carousel: cover slide first, cta slide last. 4–8 slides total.
  • Pick block_color by mood (navy=analytical, teal=positive, red=urgent/USA,
    green=Germany, brown=occasion, orange=DEADLINE-ONLY).
  • Pick template from: vertical-workshop-poster, shield-frame-deadline,
    photoreal-hero-with-block, watercolor-occasion (occasion days only).

Return ONLY the JSON described in your SKILL output schema. No prose.`,

  design:
`You are Afshin, the visual director for the RxApply brand.

If the upstream stage produced a CAROUSEL SPEC from Tarrah, your job is
to turn EACH SLIDE in that spec into a render-ready art direction. Treat
the slot values as MANDATORY — render the title text, country pill,
icon, block_color etc. exactly as Tarrah specified. Do not improvise
text content.

If there is no carousel spec (single cover image case), Avang has written
a one-line design_brief in the ADAPTED block below. Turn that into a
single art-directed prompt.

Read the brand profile + brand-intelligence + reference exemplars (in
your system prompt) for visual rules: colors, typography, photography
style, things the brand NEVER shows.

Available image models (May 2026):
  • "openai/gpt-image-2"      — FLAGSHIP. Best multilingual typography
                                  (Persian/Arabic on slides), accepts
                                  reference images, supports Thinking
                                  mode for consistent multi-panel output.
                                  DEFAULT for IG carousel slides + posters.
  • "openai/gpt-image-1"      — Prior gen; fallback when gpt-image-2 not set
  • "recraft/recraft-v3"      — Best for watercolor occasion illustrations + branded vector graphics
  • "ideogram/ideogram-v3"    — Strong text rendering, alternative to gpt-image-2
  • "bfl/flux-pro-1.1"        — Photoreal hero, weak at on-image text
  • "bfl/flux-pro-1.1-ultra"  — Premium photoreal at 4MP

Pick the model per slide:
  - Carousel slide with on-image Persian text → openai/gpt-image-2
  - Watercolor occasion-day illustration      → recraft/recraft-v3
  - Photoreal hero with NO text overlay       → bfl/flux-pro-1.1
  - Single-word legibility focus              → ideogram/ideogram-v3

M64 · Stock photos (Unsplash) — when to use instead of generating:
  Some slides are best served by a REAL photo, not a generated one. If
  the slide concept is a generic, high-realism scene (a doctor at a
  desk, a clinic interior, a student studying, a city skyline), prefer
  a stock photo and overlay your text/brand block on top. Generating
  these from scratch is wasteful and often less convincing.

  Set image_source = "unsplash" in your output and provide a clean
  English search query in unsplash_query. The system will pick the
  top-relevance photo, attribute the photographer per Unsplash terms,
  and store it in media_library. You then design the text overlay on
  top of that photo at render time.

  Use stock photos for: clinical settings, real-world subjects, generic
  professional scenes, cityscapes/landmarks, hands-at-keyboard study.
  DO NOT use stock for: brand-specific layouts, on-image text designs,
  watercolor occasion days, any slide where the visual identity matters
  more than the photo subject.

  When image_source = "unsplash", you don't need recommended_model
  for that slide — just the search query.

Return ONLY this JSON:

{
  "style": "<editorial illustration | minimal vector | photo-real | infographic | mixed-media | …>",
  "composition": "<one sentence — focal point, framing, perspective>",
  "color_palette": ["<hex or named colour>", "<...3 to 6 entries>"],
  "mood": "<one or two adjectives — calm / urgent / hopeful / authoritative / …>",
  "brand_visual_refs": [
    "<a brand element to reference, e.g. 'RxApply teal accent', 'flat-illustration of a dental hygienist'>"
  ],
  "must_avoid": ["<anything the image should NOT contain — text overlays / logos / specific imagery>"],
  "image_source": "generated | unsplash",
  "unsplash_query": "<English search terms ONLY when image_source is 'unsplash'; clean and specific, e.g. 'female dentist clinic modern' — null otherwise>",
  "unsplash_orientation": "landscape | portrait | squarish",
  "recommended_model": "<one of the available model IDs above; ignored when image_source is 'unsplash'>",
  "model_reasoning": "<one sentence — why you picked this model OR why you chose stock>",
  "final_prompt": "<for image_source='generated': the COMPLETE prompt to send to the chosen image model, 60-160 words. For image_source='unsplash': a short note describing the text overlay you'll later compose on top of the stock photo.>",
  "handoff_intent": null
}

The final_prompt should be 60-160 words, vivid and specific (for generated). For unsplash mode, it's a short overlay-design note.`,
};

// ── M68 · Per-agent stage prompt loader ──────────────────────────────
// Reads agents/<agent>/stages/<stage>.md, strips YAML frontmatter,
// returns the prompt body. Cached in-memory keyed by file path; cache
// is invalidated by mtime check on each read (cheap, single fs.statSync).
const _stagePromptCache = new Map();   // path → { mtimeMs, body }

function _loadStagePrompt(agent, stageName) {
  if (!agent || !stageName) return null;
  const filePath = path.resolve(__dirname, '..', 'agents', agent, 'stages', `${stageName}.md`);
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (_) { return null; }   // file doesn't exist → fall through to default

  const cached = _stagePromptCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.body;

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return null; }

  // Strip YAML frontmatter (--- ... ---) at top of file
  let body = raw;
  if (body.startsWith('---')) {
    const closeIdx = body.indexOf('\n---', 3);
    if (closeIdx > 0) body = body.slice(closeIdx + 4).replace(/^\r?\n+/, '');
  }
  body = body.trim();

  _stagePromptCache.set(filePath, { mtimeMs: stat.mtimeMs, body });
  return body || null;
}

// Cache invalidation hook — call from server.js after PUT writes a stage file.
function _invalidateStagePromptCache(agent, stageName) {
  if (!agent || !stageName) { _stagePromptCache.clear(); return; }
  const filePath = path.resolve(__dirname, '..', 'agents', agent, 'stages', `${stageName}.md`);
  _stagePromptCache.delete(filePath);
}

// Tiny mustache-style template renderer (no external dep).
function _renderTemplate(tmpl, ctx) {
  return String(tmpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let v = ctx;
    for (const p of parts) v = v && v[p];
    return v == null ? '' : String(v);
  });
}

// ── Run lifecycle ─────────────────────────────────────────────────────

async function start({
  recipeId, topic, audience, masterLang = 'en', targetLangs = [],
  options = {}, gateStrategy = 'critique', agentOverrides = {},
}) {
  const recipe = getRecipe(recipeId);
  // Validate gate_strategy enum
  if (!['none', 'critique', 'critique+adapt', 'every'].includes(gateStrategy)) {
    throw new Error(`Invalid gate_strategy: ${gateStrategy}`);
  }
  // Validate every override agent has the required capability for its stage.
  for (const [stageName, agent] of Object.entries(agentOverrides || {})) {
    const stage = (recipe.stages || []).find(s => s.name === stageName);
    if (!stage) throw new Error(`Override for unknown stage: ${stageName}`);
    if (stage.capability) {
      capabilities.resolveAgent({
        capability: stage.capability, override: agent,
        recipeDefault: stage.default_agent, stageName,
      });
    }
  }

  const id = await queryReturning(`
    INSERT INTO compose_runs
      (recipe_id, recipe_version, topic, audience, master_lang, target_langs,
        options, gate_strategy, agent_overrides, status, started_at)
    VALUES (
      ${q(recipe.id)}, ${q(String(recipe.version || '1'))},
      ${q(topic)}, ${q(audience)}, ${q(masterLang)},
      ${qArr(targetLangs || [])},
      ${qJson(options)}, ${q(gateStrategy)}, ${qJson(agentOverrides)},
      'queued', NOW()
    ) RETURNING id::text;
  `);

  return { ok: true, id };
}

// Fetch run + ordered stages.
async function getRun(id) {
  if (!id) return null;
  const runJson = await queryValue(`
    SELECT row_to_json(r) FROM (
      SELECT id::text, recipe_id, recipe_version, topic, audience, master_lang, target_langs,
              options, gate_strategy, agent_overrides, status, current_stage, error,
              final_output, total_cost_usd, total_input_tokens, total_output_tokens,
              created_at::text, started_at::text, finished_at::text
        FROM compose_runs WHERE id = ${q(id)}
    ) r;`);
  if (!runJson) return null;
  const run = JSON.parse(runJson);

  const stagesJson = await queryValue(`
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY stage_index ASC, lang NULLS FIRST), '[]'::json)
      FROM (SELECT id::text, run_id::text, stage_index, stage_name, capability, lang,
                    agent, model, input, output, status, error,
                    approval_required, approved_at::text, approved_by, approval_note,
                    input_tokens, output_tokens, cost_usd,
                    handoff_id::text,
                    started_at::text, finished_at::text
              FROM compose_stages WHERE run_id = ${q(id)}) s;`);
  run.stages = JSON.parse(stagesJson || '[]');
  return run;
}

async function listRuns({ limit = 30, recipe = null, status = null } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const conds = [];
  if (recipe) conds.push(`recipe_id = ${q(recipe)}`);
  if (status) conds.push(`status = ${q(status)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(r) ORDER BY created_at DESC), '[]'::json)
      FROM (SELECT id::text, recipe_id, topic, master_lang, target_langs, gate_strategy,
                    status, current_stage, total_cost_usd, created_at::text, finished_at::text
              FROM compose_runs ${where}
            ORDER BY created_at DESC LIMIT ${limit}) r;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

// ── Stage execution ───────────────────────────────────────────────────

async function _markRunRunning(runId, currentStage) {
  await query(`UPDATE compose_runs
                  SET status = 'running', current_stage = ${q(currentStage)}
                WHERE id = ${q(runId)} AND status IN ('queued', 'awaiting_approval', 'running');`);
}

async function _writeStage({
  runId, stageIndex, stageName, capability, lang = null,
  agent, model, input, output, status,
  approvalRequired = false,
  inputTokens = 0, outputTokens = 0, costUsd = 0,
  error = null, handoffId = null,
}) {
  await query(`
    INSERT INTO compose_stages
      (run_id, stage_index, stage_name, capability, lang, agent, model,
        input, output, status, approval_required,
        input_tokens, output_tokens, cost_usd, error, handoff_id,
        started_at, finished_at)
    VALUES (
      ${q(runId)}, ${stageIndex}, ${q(stageName)}, ${q(capability)}, ${q(lang)},
      ${q(agent)}, ${q(model)}, ${qJson(input)}, ${qJson(output)},
      ${q(status)}, ${approvalRequired},
      ${inputTokens}, ${outputTokens}, ${costUsd},
      ${q(error)}, ${q(handoffId)},
      NOW(), CASE WHEN ${q(status)} IN ('done', 'failed', 'gated') THEN NOW() ELSE NULL END
    )
    ON CONFLICT (run_id, stage_index, lang) DO UPDATE
      SET stage_name = EXCLUDED.stage_name,
          capability = EXCLUDED.capability,
          agent = EXCLUDED.agent,
          model = EXCLUDED.model,
          input = EXCLUDED.input,
          output = EXCLUDED.output,
          status = EXCLUDED.status,
          approval_required = EXCLUDED.approval_required,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cost_usd = EXCLUDED.cost_usd,
          error = EXCLUDED.error,
          handoff_id = EXCLUDED.handoff_id,
          finished_at = CASE WHEN EXCLUDED.status IN ('done','failed','gated')
                              THEN NOW() ELSE compose_stages.finished_at END;
  `);
}

async function _rollupCost(runId) {
  await query(`
    UPDATE compose_runs r
       SET total_cost_usd      = COALESCE((SELECT SUM(cost_usd)      FROM compose_stages WHERE run_id = r.id), 0),
           total_input_tokens  = COALESCE((SELECT SUM(input_tokens)  FROM compose_stages WHERE run_id = r.id), 0),
           total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM compose_stages WHERE run_id = r.id), 0)
     WHERE r.id = ${q(runId)};
  `);
}

async function _markFinal(runId, finalOutput) {
  await query(`UPDATE compose_runs
                  SET status = 'done', current_stage = NULL,
                      final_output = ${qJson(finalOutput)}, finished_at = NOW()
                WHERE id = ${q(runId)};`);
}

async function _markFailed(runId, errMsg) {
  await query(`UPDATE compose_runs
                  SET status = 'failed', error = ${q(String(errMsg).slice(0, 500))},
                      finished_at = NOW()
                WHERE id = ${q(runId)};`);
}

async function _markAwaitingApproval(runId, stageName) {
  await query(`UPDATE compose_runs
                  SET status = 'awaiting_approval', current_stage = ${q(stageName)}
                WHERE id = ${q(runId)};`);
}

// M40 · Effort-scaling — complexity tiers from the plan stage.
// Verify ALWAYS runs (per founder's KB-first rule); only research + audit
// are gated by complexity.
const _COMPLEXITY_RANK = { trivial: 1, standard: 2, deep: 3 };
function _runComplexity(run) {
  // Founder override on the run wins
  if (run && run.options && _COMPLEXITY_RANK[run.options.complexity]) {
    return run.options.complexity;
  }
  // Else read from the plan stage's output
  const planRow = (run && run.stages || []).find(s => s.stage_name === 'plan' && s.status === 'done');
  const out = planRow && planRow.output;
  if (out && _COMPLEXITY_RANK[out.complexity]) return out.complexity;
  return 'standard';   // safe default
}

// Should this stage run for this run? Honors:
//   - if_option              : skip when run.options[key] is falsy
//   - if_complexity_at_least : skip when current complexity rank < required rank
function _stageShouldRun(stage, run) {
  if (!stage) return false;
  if (stage.if_option) {
    const val = (run.options || {})[stage.if_option];
    if (!val) return false;
  }
  if (stage.if_complexity_at_least) {
    const required = _COMPLEXITY_RANK[stage.if_complexity_at_least] || 0;
    const current  = _COMPLEXITY_RANK[_runComplexity(run)] || 2;
    if (current < required) return false;
  }
  return true;
}

// Find the next stage that should execute, given current stages already
// in the DB. Returns { stageIndex, stage, lang } or null when done.
function _nextPendingStage({ recipe, run, existingStages }) {
  const masterStages = recipe.stages || [];
  // Phase 1: master-language stages
  for (let i = 0; i < masterStages.length; i++) {
    const stage = masterStages[i];
    const row = existingStages.find(s => s.stage_index === i && s.lang == null);
    if (!row || (row.status !== 'done' && row.status !== 'skipped')) {
      return { stageIndex: i, stage, lang: null, phase: 'master' };
    }
    if (row.status === 'gated') return null; // run is awaiting_approval; caller handles
  }
  // Phase 2: translate per target language (only after master is fully done)
  if (recipe.translate && (run.target_langs || []).length > 0) {
    const baseIndex      = masterStages.length;
    const verifyTrIndex  = masterStages.length + 1;        // M41
    const renderIndex    = masterStages.length + 2;
    const targetLangs    = run.target_langs.filter(l => l !== run.master_lang);

    // Phase 2a: translate(lang) for each target
    for (const lang of targetLangs) {
      const row = existingStages.find(s => s.stage_index === baseIndex && s.lang === lang);
      if (!row || row.status !== 'done') {
        return { stageIndex: baseIndex, stage: { name: 'translate', capability: recipe.translate.capability || 'translate' }, lang, phase: 'translate' };
      }
    }
    // Phase 2b: M41 · verify-translation(lang) for each target — back-translate + glossary check
    for (const lang of targetLangs) {
      const row = existingStages.find(s => s.stage_index === verifyTrIndex && s.lang === lang);
      if (!row || row.status !== 'done') {
        return { stageIndex: verifyTrIndex, stage: { name: 'verify-translation', capability: 'verify-translation' }, lang, phase: 'verify-translation' };
      }
    }
    // Phase 3: re-render per target language
    if (recipe.stages.find(s => s.name === 'render')) {
      const renderStage = recipe.stages.find(s => s.name === 'render');
      for (const lang of targetLangs) {
        const row = existingStages.find(s => s.stage_index === renderIndex && s.lang === lang);
        if (!row || row.status !== 'done') {
          return { stageIndex: renderIndex, stage: renderStage, lang, phase: 'render-target' };
        }
      }
    }
  }
  return null;
}

// Execute one stage: figure out next, run it, write the row, update rollup.
// Returns the run after the action.
async function tick(runId) {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (['done', 'failed', 'cancelled'].includes(run.status)) return run;
  if (run.status === 'awaiting_approval') return run; // caller must call approve()

  const recipe = getRecipe(run.recipe_id);
  const next = _nextPendingStage({ recipe, run, existingStages: run.stages });

  if (!next) {
    // All stages done — assemble final_output from render stages.
    const finalOutput = {};
    const renderStages = run.stages.filter(s => s.stage_name === 'render' && s.status === 'done');
    for (const rs of renderStages) {
      const lang = rs.lang || run.master_lang;
      finalOutput[lang] = rs.output;
    }
    await _markFinal(runId, finalOutput);
    return await getRun(runId);
  }

  const { stageIndex, stage, lang, phase } = next;
  const stageName = stage.name;

  // Skip optional stages whose if_option is falsy. Write a 'skipped' row so
  // the UI can show what was bypassed and the orchestrator advances next tick.
  if (!_stageShouldRun(stage, run)) {
    await _writeStage({
      runId, stageIndex, stageName, capability: stage.capability || null, lang: lang || null,
      agent: null, model: null, input: { skipped_because: stage.if_option || 'optional' },
      output: null, status: 'skipped',
    });
    return await tick(runId);
  }

  await _markRunRunning(runId, stageName);

  // Renderer stages are deterministic JS — no LLM call.
  if (stage.renderer || stageName === 'render') {
    return await _executeRenderer({ runId, run, recipe, stage, stageIndex, lang });
  }

  // LLM-driven stage
  return await _executeLlmStage({ runId, run, recipe, stage, stageIndex, lang, phase });
}

async function _executeLlmStage({ runId, run, recipe, stage, stageIndex, lang, phase }) {
  const stageName = stage.name;
  const capability = stage.capability;
  let agent;
  try {
    agent = capabilities.resolveAgent({
      capability,
      override: (run.agent_overrides || {})[stageName],
      recipeDefault: stage.default_agent,
      stageName,
    });
  } catch (e) {
    await _writeStage({
      runId, stageIndex, stageName, capability, lang: lang || null,
      agent: null, model: null, input: null, output: null,
      status: 'failed', error: e.message,
    });
    await _markFailed(runId, e.message);
    return await getRun(runId);
  }

  // M42 · Cost-aware router. The router only fires when no founder pin is set
  // for this agent + the capability isn't in the NEVER_AUTO_PICK list (verify,
  // verify-translation, image). Falls back to agentModels.resolveModel cleanly.
  let model;
  try {
    const routerPick = await costRouter.pickModelFor({ agent, capability });
    if (routerPick) {
      model = routerPick;
    } else {
      ({ id: model } = agentModels.resolveModel(agent));
    }
  } catch (_) {
    ({ id: model } = agentModels.resolveModel(agent));
  }

  // Build context from prior stages.
  const priorMaster = {};
  for (const s of (run.stages || [])) {
    if (s.lang == null && s.status === 'done' && s.output) {
      priorMaster[s.stage_name] = s.output;
    }
  }
  const masterDraft = priorMaster.adapt || priorMaster.draft || null;

  // The user prompt summarises inputs in plain text — easier to debug than packed JSON.
  const userParts = [];
  userParts.push(`Topic: ${run.topic}`);
  if (run.audience) userParts.push(`Audience: ${run.audience}`);
  userParts.push(`Format: ${recipe.label}`);
  userParts.push(`Master language: ${run.master_lang}`);
  if (lang) userParts.push(`Translate to language: ${lang}`);
  if (priorMaster.plan)     userParts.push(`\n--- PLAN ---\n${JSON.stringify(priorMaster.plan, null, 2)}`);
  if (priorMaster.research) userParts.push(`\n--- RESEARCH ---\n${JSON.stringify(priorMaster.research, null, 2)}`);
  if (priorMaster.draft)    userParts.push(`\n--- DRAFT ---\n${JSON.stringify(priorMaster.draft, null, 2)}`);
  if (priorMaster.critique) userParts.push(`\n--- CRITIQUE ---\n${JSON.stringify(priorMaster.critique, null, 2)}`);
  if (priorMaster.adapt)    userParts.push(`\n--- ADAPTED ---\n${JSON.stringify(priorMaster.adapt, null, 2)}`);
  // M60 · Carousel spec from Tarrah is consumed by the `design` stage so
  // Afshin renders each slide using the structured slot values.
  if (priorMaster['carousel-plan']) userParts.push(`\n--- CAROUSEL SPEC (from Tarrah) ---\n${JSON.stringify(priorMaster['carousel-plan'], null, 2)}`);
  if (stage.params) userParts.push(`\n--- STAGE PARAMS ---\n${JSON.stringify(stage.params, null, 2)}`);
  userParts.push(`\nReturn the JSON for stage "${stageName}" now.`);
  const userPrompt = userParts.join('\n');

  // M41 · Pre-fetch protected-terms block for verify-translation / translate.
  let protectedTermsBlock = null;
  if (['verify-translation', 'translate'].includes(stageName)) {
    try { protectedTermsBlock = await protectedTerms.renderAsPromptBlock(); }
    catch (_) { /* non-fatal — KB may not be reachable; verify still runs without the block */ }
  }

  // M50 · Pre-fetch voice fingerprint for the voice-critic stage.
  // If the founder hasn't uploaded fingerprint data yet (or the cluster
  // for this language is empty), short-circuit the stage as 'skipped' so
  // the run continues and we don't burn tokens on a no-op LLM call.
  let fingerprintBlock = null;
  if (stageName === 'voice-critic') {
    try {
      const cluster = await brandInt.getVoiceFingerprint({
        cluster: 'broadcast',
        language: lang || run.master_lang,
        limit: 8,
      });
      if (!cluster || cluster.length < 3) {
        // Not enough fingerprint data — skip this stage cleanly.
        await _writeStage({
          runId, stageIndex, stageName, capability, lang: lang || null,
          agent, model: null,
          input: { skipped_because: 'fingerprint_empty', cluster_size: cluster ? cluster.length : 0 },
          output: { verdict: 'skipped', skipped_reason: 'fingerprint cluster has fewer than 3 paragraphs for this language; upload more brand-voice exemplars to enable.', voice_match_score: null, drift_concerns: [], summary: 'voice critic skipped' },
          status: 'skipped',
        });
        return await getRun(runId);
      }
      const lines = [`# Voice fingerprint (canonical brand voice · ${cluster.length} exemplars)`];
      for (const c of cluster) {
        lines.push(`\n--- canonical exemplar (${c.language}) ---`);
        lines.push(c.body);
        if (c.why_picked) lines.push(`(why canonical: ${c.why_picked})`);
      }
      fingerprintBlock = lines.join('\n');
    } catch (_) {
      // DB hiccup — also skip rather than emit garbage
      await _writeStage({
        runId, stageIndex, stageName, capability, lang: lang || null,
        agent, model: null,
        input: { skipped_because: 'fingerprint_fetch_error' },
        output: { verdict: 'skipped', skipped_reason: 'fingerprint fetch failed', voice_match_score: null, drift_concerns: [] },
        status: 'skipped',
      });
      return await getRun(runId);
    }
  }

  const systemPrompt = await _buildSystemPrompt({
    agent, stageName, recipe, run, masterDraft, lang, protectedTermsBlock, fingerprintBlock,
  });

  // Open an agent_runs row so this stage execution shows up in the agent's
  // Train tab, the Overview cost rollup, and is rate-able.
  let agentRunId = null;
  const startedAt = Date.now();
  try {
    const lr = await logWriter.recordRunStart({
      agent,
      command: `compose:${recipe.id}:${stageName}${lang ? ':' + lang : ''}`,
      args: [run.topic],
      stdin: null,
    });
    agentRunId = lr.runId;
  } catch (_) { /* non-fatal */ }

  let parsed, usage = {}, modelUsed = model, errMsg = null;
  let retried = false;
  try {
    const r = await llm.chat({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: stage.max_tokens || 2500,
    });
    parsed = _parseJsonOrThrow(r.output, `${agent}/${stageName}`);
    usage = r.usage || {};
    modelUsed = r.model || model;

    // M49 · contract validation + retry-once on failure
    const validation = contracts.validate(stageName, parsed);
    if (!validation.ok) {
      const hint = contracts.renderRetryHint(stageName, validation.errors);
      const retryUserPrompt = `${userPrompt}\n\n--- PREVIOUS ATTEMPT ---\n${JSON.stringify(parsed)}\n\n${hint}`;
      try {
        const r2 = await llm.chat({
          model,
          system: systemPrompt,
          messages: [{ role: 'user', content: retryUserPrompt }],
          maxTokens: stage.max_tokens || 2500,
        });
        const parsed2 = _parseJsonOrThrow(r2.output, `${agent}/${stageName}/retry`);
        const v2 = contracts.validate(stageName, parsed2);
        // Only adopt the retry if it's strictly better. Sum token usage from both attempts.
        if (v2.ok || v2.errors.length < validation.errors.length) {
          parsed = parsed2;
          usage = {
            input_tokens:  (usage.input_tokens  || 0) + ((r2.usage && r2.usage.input_tokens)  || 0),
            output_tokens: (usage.output_tokens || 0) + ((r2.usage && r2.usage.output_tokens) || 0),
          };
          modelUsed = r2.model || modelUsed;
          retried = true;
        }
      } catch (e) {
        // Retry call failed — keep the original parsed; downstream will get
        // partial output but we log the validation issue for the founder.
      }
    }
  } catch (e) {
    errMsg = e.message;
  }

  const inputTokens  = usage.input_tokens  || 0;
  const outputTokens = usage.output_tokens || 0;
  const costUsd = agentModels.calcCost(modelUsed, inputTokens, outputTokens);

  if (errMsg) {
    if (agentRunId) {
      try { await logWriter.recordRunEnd({ runId: agentRunId, agent, status: 'fail', error: errMsg, durationMs: Date.now() - startedAt, costUsd }); } catch (_) {}
    }
    await _writeStage({
      runId, stageIndex, stageName, capability, lang: lang || null,
      agent, model: modelUsed, input: { user_prompt_excerpt: userPrompt.slice(0, 500), agent_run_id: agentRunId },
      output: null, status: 'failed', error: errMsg,
      inputTokens, outputTokens, costUsd,
    });
    await _markFailed(runId, errMsg);
    await _rollupCost(runId);
    return await getRun(runId);
  }

  // Record handoff_intent if any (non-blocking).
  let handoffId = null;
  try {
    const ho = handoffs.parseFromOutput(parsed, agent);
    if (ho) {
      const rec = await handoffs.record({
        fromAgent: agent, toAgent: ho.to_agent,
        reason: ho.reason, suggestedAction: ho.suggested_action,
        payload: { run_id: runId, stage: stageName, ...(ho.payload || {}) },
      });
      if (rec.ok) handoffId = rec.id;
    }
  } catch (_) { /* non-fatal */ }

  // Decide gate
  // M45 · audit verdict=block ALWAYS forces a gate, regardless of gate_strategy.
  // Same for verify when passed=false. Red-team output is a hard stop unless
  // the founder explicitly approves to override.
  // M50 · voice-critic verdict=block also forces a gate.
  let forceGate = false;
  if (stageName === 'audit' && parsed && parsed.verdict === 'block') forceGate = true;
  if (stageName === 'verify' && parsed && parsed.passed === false) forceGate = true;
  if (stageName === 'voice-critic' && parsed && parsed.verdict === 'block') forceGate = true;
  const gateHere = forceGate || _shouldGate(stageName, recipe, run.gate_strategy);
  const finalStatus = gateHere ? 'gated' : 'done';

  // Close the agent_runs row on success.
  if (agentRunId) {
    try {
      await logWriter.recordRunEnd({
        runId: agentRunId,
        agent,
        status: 'success',
        parsedOutput: parsed,
        costUsd,
        durationMs: Date.now() - startedAt,
      });
    } catch (_) { /* non-fatal */ }
  }

  await _writeStage({
    runId, stageIndex, stageName, capability, lang: lang || null,
    agent, model: modelUsed,
    input: { user_prompt_excerpt: userPrompt.slice(0, 1500), agent_run_id: agentRunId },
    output: parsed,
    status: finalStatus, approvalRequired: gateHere,
    inputTokens, outputTokens, costUsd,
    handoffId,
  });
  await _rollupCost(runId);

  // Episodic memory (so the agent remembers this work).
  try {
    agentMemory.write({
      agent, type: 'episodic',
      content: agentMemory.summarizeForEpisodic({
        agent, action: `compose-${stageName}`,
        output: { summary: JSON.stringify(parsed).slice(0, 200) },
        costUsd, topic: run.topic,
      }),
      tags: ['compose-pipeline', stageName, recipe.id],
      importance: 2, source: 'auto',
    });
  } catch (_) { /* non-fatal */ }

  if (gateHere) {
    await _markAwaitingApproval(runId, stageName);
  }
  return await getRun(runId);
}

// Map a renderer name to the agent that "owns" it. Image-cover is Afshin's
// territory; format renderers are Payvand's. Used for compose_stages.agent
// + an agent_runs row so renderers show up in the relevant Train tab.
const _RENDERER_AGENT = {
  'image-cover': 'afshin',
  'email-html':  'payvand',
  'seo-article': 'payvand',
  'telegram':    'payvand',
  'facebook':    'payvand',
  'x-thread':    'payvand',
  'ig':          'payvand',
};

async function _executeRenderer({ runId, run, recipe, stage, stageIndex, lang }) {
  // Use the recipe stage name (e.g. 'image' or 'render') so we don't
  // collapse two distinct stages into one row.
  const stageName = stage.name || (stage.renderer === 'image-cover' ? 'image' : 'render');
  const rendererName = stage.renderer || `${recipe.id}-default`;
  // M35 · Attribute the renderer to its owning agent so the work shows in
  // that agent's Train tab + history. Falls back to null for unmapped
  // renderers, which preserves prior behaviour.
  const renderAgent = _RENDERER_AGENT[rendererName] || null;
  // Determine inputs: master output for master-lang render; translated output for target.
  const stages = run.stages || [];
  let sourceForRender;
  if (lang && lang !== run.master_lang) {
    // target-language: find the matching translate row
    const baseIndex = (recipe.stages || []).length;
    sourceForRender = (stages.find(s => s.stage_index === baseIndex && s.lang === lang) || {}).output;
  } else {
    // master: pick the right upstream output for this renderer.
    const masterDone = stages.filter(s => s.lang == null && s.status === 'done');
    if (rendererName === 'image-cover') {
      // Image renderer prefers Afshin's design output (final_prompt) over
      // Avang's raw brief. Fallback to adapt → draft so old runs (without
      // a design stage) still work.
      const designRow = masterDone.find(s => s.stage_name === 'design');
      const adaptRow  = masterDone.find(s => s.stage_name === 'adapt');
      const draftRow  = masterDone.find(s => s.stage_name === 'draft');
      sourceForRender = (designRow || adaptRow || draftRow || {}).output;
      // M65 · Pipe Tarrah's carousel spec to the renderer when present.
      // The renderer iterates the spec's slides and renders one image per
      // slide using the brand-template scaffold from afshin-router.
      const carouselRow = masterDone.find(s => s.stage_name === 'carousel-plan');
      if (carouselRow && carouselRow.output) {
        sourceForRender = { ...(sourceForRender || {}), _carousel_spec: carouselRow.output };
      }
    } else {
      // Non-image renderers (telegram/email/etc) use adapt > draft.
      const adaptRow = masterDone.find(s => s.stage_name === 'adapt');
      const draftRow = masterDone.find(s => s.stage_name === 'draft');
      sourceForRender = (adaptRow || draftRow || {}).output;
    }
  }

  const startedAt = Date.now();

  // Open an agent_runs row for the owning agent (when one is mapped).
  // Image renderers (afshin) ALSO write their own agent_runs from inside
  // compose-image.js — to avoid double-counting cost we set costUsd=0 here
  // for image stages and let compose-image carry the actual cost.
  let renderRunId = null;
  if (renderAgent) {
    try {
      const lr = await logWriter.recordRunStart({
        agent: renderAgent,
        command: `compose:${recipe.id}:${stageName}${lang ? ':' + lang : ''}:${rendererName}`,
        args: [run.topic],
      });
      renderRunId = lr.runId;
    } catch (_) { /* non-fatal */ }
  }

  let rendered, errMsg = null;
  try {
    const fn = renderers[rendererName] || renderers._default;
    if (!fn) throw new Error(`No renderer "${rendererName}" registered`);
    rendered = await fn({ source: sourceForRender, run, recipe, lang: lang || run.master_lang });
  } catch (e) {
    errMsg = e.message;
  }

  if (errMsg) {
    if (renderRunId) {
      try { await logWriter.recordRunEnd({ runId: renderRunId, agent: renderAgent, status: 'fail', error: errMsg, durationMs: Date.now() - startedAt, costUsd: 0 }); } catch (_) {}
    }
    await _writeStage({
      runId, stageIndex, stageName, capability: null, lang: lang || null,
      agent: renderAgent, model: rendererName,
      input: { renderer: rendererName, source_keys: sourceForRender ? Object.keys(sourceForRender) : [] },
      output: null, status: 'failed', error: errMsg,
    });
    await _markFailed(runId, errMsg);
    return await getRun(runId);
  }

  // Some renderers (image-cover) actually cost money. If the renderer
  // returned a numeric cost_usd, attribute it to the stage row. (Image
  // cost is also recorded against Afshin in compose-image.js's own
  // agent_runs row — we don't double-write here. The compose_stages
  // row carries the canonical cost; the agent_runs row at this layer
  // gets cost=0 for image stages to avoid double-counting in the
  // Overview rollup.)
  const renderCost = (rendered && typeof rendered.cost_usd === 'number') ? rendered.cost_usd : 0;

  if (renderRunId) {
    try {
      await logWriter.recordRunEnd({
        runId: renderRunId,
        agent: renderAgent,
        status: 'success',
        // Pass a tiny structured summary so the Train tab "Recent runs"
        // can show something meaningful (excerpt of the rendered text).
        parsedOutput: rendered ? {
          renderer: rendererName,
          summary: (rendered.subject || rendered.title || rendered.body_plain || rendered.caption || '').toString().slice(0, 200),
          url: rendered.url || null,
        } : null,
        // Render costs are attributed to the renderer's own audit trail,
        // NOT to the format-renderer agent_runs row (which is free work
        // for Payvand, and double-counted otherwise for Afshin).
        costUsd: 0,
        durationMs: Date.now() - startedAt,
      });
    } catch (_) { /* non-fatal */ }
  }

  await _writeStage({
    runId, stageIndex, stageName, capability: null, lang: lang || null,
    agent: renderAgent, model: (rendered && rendered.model) || rendererName,
    input: { renderer: rendererName, agent_run_id: renderRunId },
    output: rendered, status: 'done',
    costUsd: renderCost,
  });
  await _rollupCost(runId);
  return await getRun(runId);
}

// Approve a gated stage and resume.
async function approve(runId, note = null, decidedBy = 'founder') {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== 'awaiting_approval') {
    throw new Error(`Run is not awaiting approval (status=${run.status})`);
  }
  // Find the gated stage and clear its gate.
  const gated = (run.stages || []).find(s => s.status === 'gated' && s.lang == null);
  if (!gated) throw new Error('No gated stage found on run');
  await query(`
    UPDATE compose_stages
       SET status = 'done', approval_required = false,
           approved_at = NOW(), approved_by = ${q(decidedBy)},
           approval_note = ${q(note)}
     WHERE id = ${q(gated.id)};
  `);
  await query(`UPDATE compose_runs SET status = 'running' WHERE id = ${q(runId)};`);
  return await getRun(runId);
}

// M44 · Checkpointed pipeline state — fork a run from stage N.
//
// Creates a NEW compose_runs row with the same recipe + inputs (with optional
// overrides), then COPIES master-phase stages [0 .. stageIndex-1] from the
// source run as already-'done' rows in the new run. The new run is left in
// 'queued' status; the caller triggers tick/runToBlock to continue.
//
// Use cases:
//   • Founder didn't like the adapt output → fork from stage `adapt-1` (so
//     plan/research/draft/critique/verify carry over) → re-run with a different
//     adapt agent or topic tweak. No re-spending on the upstream stages.
//   • A/B-ing the design stage with different brand briefs.
//   • Iterating on a specific stage's prompt without paying for the whole pipeline.
//
// Only master-phase stages are forked. If you want to re-translate, fork from
// the master 'render' index — translate fan-out re-runs in the new run because
// no per-target-lang stages get cloned.
async function forkFromStage(sourceRunId, { stageIndex, options: overrideOptions = null,
                                            agentOverrides: overrideAgents = null,
                                            topic: overrideTopic = null,
                                            audience: overrideAudience = null,
                                            gateStrategy: overrideGate = null } = {}) {
  if (typeof stageIndex !== 'number' || stageIndex < 0) {
    throw new Error('stageIndex must be a non-negative integer (0 = re-run from scratch)');
  }
  const source = await getRun(sourceRunId);
  if (!source) throw new Error('source run not found');
  const recipe = getRecipe(source.recipe_id);
  const masterStages = recipe.stages || [];
  if (stageIndex > masterStages.length) {
    throw new Error(`stageIndex ${stageIndex} exceeds recipe master stages (${masterStages.length})`);
  }

  // 1. Create a new run with merged inputs
  const newId = await queryReturning(`
    INSERT INTO compose_runs
      (recipe_id, recipe_version, topic, audience, master_lang, target_langs,
        options, gate_strategy, agent_overrides, status, started_at)
    VALUES (
      ${q(source.recipe_id)}, ${q(String(source.recipe_version || '1'))},
      ${q(overrideTopic   != null ? overrideTopic   : source.topic)},
      ${q(overrideAudience!= null ? overrideAudience: source.audience)},
      ${q(source.master_lang)},
      ${qArr(source.target_langs || [])},
      ${qJson(overrideOptions != null ? { ...(source.options || {}), ...overrideOptions } : (source.options || {}))},
      ${q(overrideGate || source.gate_strategy || 'none')},
      ${qJson(overrideAgents != null ? { ...(source.agent_overrides || {}), ...overrideAgents } : (source.agent_overrides || {}))},
      'queued', NOW()
    ) RETURNING id::text;`);

  // 2. Clone master-phase stages [0..stageIndex-1] from the source as done
  let totalCost = 0, totalIn = 0, totalOut = 0;
  for (const s of (source.stages || [])) {
    if (s.lang != null) continue;             // skip per-target-lang stages — re-run from scratch
    if (s.stage_index >= stageIndex) continue; // anything from forkPoint onwards is fresh
    if (s.status !== 'done' && s.status !== 'skipped') continue;

    await query(`
      INSERT INTO compose_stages
        (run_id, stage_index, stage_name, capability, lang, agent, model,
          input, output, status, approval_required,
          input_tokens, output_tokens, cost_usd, error, handoff_id,
          started_at, finished_at, created_at)
      VALUES (
        ${q(newId)}, ${s.stage_index}, ${q(s.stage_name)}, ${q(s.capability)},
        NULL, ${q(s.agent)}, ${q(s.model)},
        ${qJson({ ...(s.input || {}), forked_from_run_id: sourceRunId, forked_from_stage_id: s.id })},
        ${qJson(s.output)},
        ${q(s.status)}, FALSE,
        ${s.input_tokens || 0}, ${s.output_tokens || 0}, ${s.cost_usd || 0},
        NULL, NULL,
        NOW(), NOW(), NOW()
      )
      ON CONFLICT (run_id, stage_index, lang) DO NOTHING;
    `);
    totalCost += Number(s.cost_usd) || 0;
    totalIn   += s.input_tokens  || 0;
    totalOut  += s.output_tokens || 0;
  }

  // 3. Roll up cost on the new run so the HUD shows the inherited spend
  await query(`UPDATE compose_runs
                  SET total_cost_usd = ${totalCost},
                      total_input_tokens = ${totalIn},
                      total_output_tokens = ${totalOut}
                WHERE id = ${q(newId)};`);

  return { ok: true, id: newId, source_run_id: sourceRunId, fork_stage_index: stageIndex,
           inherited_cost_usd: totalCost };
}

async function cancel(runId, note = null) {
  await query(`UPDATE compose_runs
                  SET status = 'cancelled', error = ${q(note)}, finished_at = NOW()
                WHERE id = ${q(runId)} AND status NOT IN ('done', 'failed', 'cancelled');`);
  return await getRun(runId);
}

// Drive a run to completion or to the next blocking state. Used by HTTP
// callers that want a "run-to-completion or until-gated" semantics.
async function runToBlock(runId, { maxIterations = 30 } = {}) {
  for (let i = 0; i < maxIterations; i++) {
    const run = await tick(runId);
    if (['done', 'failed', 'cancelled', 'awaiting_approval'].includes(run.status)) return run;
  }
  return await getRun(runId);
}

module.exports = {
  // recipes
  listRecipes, getRecipe,
  // run lifecycle
  start, getRun, listRuns, tick, runToBlock, approve, cancel,
  // M44 · checkpointed state
  forkFromStage,
  // M68 · stage-prompt loader + cache invalidation hook
  _loadStagePrompt, _invalidateStagePromptCache,
  // M72A · pipelines bootstrap (call once on server boot)
  ensurePipelinesLoaded,
};
