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

const RECIPES_DIR = path.resolve(__dirname, '..', 'compose-recipes');

// ── Recipe loading ────────────────────────────────────────────────────
let _recipeCache = null;
function _loadRecipes() {
  if (_recipeCache) return _recipeCache;
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
  _recipeCache = out;
  return out;
}
function getRecipe(id) {
  const r = _loadRecipes()[id];
  if (!r) throw new Error(`Unknown recipe: ${id}`);
  return r;
}
function listRecipes() {
  return Object.values(_loadRecipes()).map(r => ({
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
function _buildSystemPrompt({ agent, stageName, recipe, run, masterDraft, lang }) {
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

  // Stage-specific instruction template (per-recipe override beats default).
  const tmpl = (recipe.stage_prompts && recipe.stage_prompts[stageName])
            || _DEFAULT_STAGE_PROMPTS[stageName];
  if (tmpl) {
    blocks.push(`# This stage: ${stageName}\n${_renderTemplate(tmpl, { run, recipe, masterDraft, lang })}`);
  }

  // Brand profile (always included — every output has to match the brand).
  const brand = brandProfile.renderAsPromptBlock();
  if (brand) blocks.push(brand);

  // KB grounding for research / verify / draft / critique stages
  if (['research', 'verify', 'draft', 'critique'].includes(stageName)) {
    try {
      const country = KB.detectCountry(run.topic);
      const kb = KB.renderAsBlock({ country, query: run.topic, limit: 6 });
      if (kb) blocks.push(kb);
    } catch (_) { /* non-fatal */ }
  }

  // Per-agent memory (top procedural + relevant semantic).
  try {
    const mem = agentMemory.renderAsBlock(agent, {
      limit: 6,
      queryKeywords: String(run.topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5),
    });
    if (mem) blocks.push(mem);
  } catch (_) { /* non-fatal */ }

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
  "handoff_intent": null
}`,

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
Format: {{recipe.label}}. Length target: {{recipe.length_target_words}} words (or as appropriate
for the format). Master language: {{run.master_lang}}. Do NOT translate; downstream stages
handle that.

Return ONLY this JSON:

{
  "title": "<the headline / subject / hook line>",
  "body": "<the full draft body in the master language>",
  "tone_notes": "<one sentence — how the voice carries>",
  "handoff_intent": null
}`,

  critique:
`Score the draft below against brand voice + format rules. Return ONLY this JSON:

{
  "verdict": "pass" | "needs_refine" | "fail",
  "verdict_reason": "<one sentence>",
  "scores": {
    "brand_voice": 0.00,
    "specificity": 0.00,
    "cta_present": 0.00,
    "banned_phrases_clean": 0.00,
    "format_fit": 0.00
  },
  "actionable_fixes": ["<fix 1>", "..."],
  "handoff_intent": null
}

A draft passes if every score >= 0.70 AND no banned phrase. Otherwise verdict is "needs_refine"
or "fail" depending on severity.`,

  audit:
`Adversarial review. Find what the critique missed — risks, factual errors, regulatory exposure,
voice inconsistencies. Return ONLY this JSON:

{
  "verdict": "pass" | "block",
  "issues": [{ "severity": "high" | "medium" | "low", "issue": "...", "fix": "..." }],
  "summary": "<one sentence>",
  "handoff_intent": null
}`,

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
`Translate the master output into {{lang_label}} ({{lang_code}}). Preserve the tone, the CTAs,
the named entities (regulators, institutions). Do NOT add new claims. Return ONLY this JSON:

{
  "fields": {
    /* same keys as the input "fields", translated */
  },
  "handoff_intent": null
}`,

  design:
`You are Afshin, the visual director for the RxApply brand. Avang has
written a one-line design_brief for this post (in the ADAPTED block
below). Your job: turn that brief into a fully art-directed prompt
that gpt-image-1 will use to render the cover.

Read the brand profile (in your system prompt) for visual rules:
brand colours, typography hints, photography style, things the brand
NEVER shows. Reference real brand visuals when they fit.

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
  "final_prompt": "<the COMPLETE prompt to send to the image model. Synthesise everything above into a clear, vivid paragraph. No model-specific syntax — just plain art-direction language.>",
  "handoff_intent": null
}

The final_prompt should be 60-160 words, vivid and specific.`,
};

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

// Should this stage run for this run? Honors `if_option` (skip when the
// run.options[key] is falsy). Used to gate optional stages like cover-image.
function _stageShouldRun(stage, run) {
  if (!stage) return false;
  if (stage.if_option) {
    const val = (run.options || {})[stage.if_option];
    if (!val) return false;
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
    const baseIndex = masterStages.length;
    for (const lang of run.target_langs) {
      if (lang === run.master_lang) continue;
      const row = existingStages.find(s => s.stage_index === baseIndex && s.lang === lang);
      if (!row || row.status !== 'done') {
        return { stageIndex: baseIndex, stage: { name: 'translate', capability: recipe.translate.capability || 'translate' }, lang, phase: 'translate' };
      }
    }
    // Phase 3: re-render per target language
    if (recipe.stages.find(s => s.name === 'render')) {
      const renderStage = recipe.stages.find(s => s.name === 'render');
      const renderIndex = baseIndex + 1;
      for (const lang of run.target_langs) {
        if (lang === run.master_lang) continue;
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

  const { id: model } = agentModels.resolveModel(agent);

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
  if (stage.params) userParts.push(`\n--- STAGE PARAMS ---\n${JSON.stringify(stage.params, null, 2)}`);
  userParts.push(`\nReturn the JSON for stage "${stageName}" now.`);
  const userPrompt = userParts.join('\n');

  const systemPrompt = _buildSystemPrompt({
    agent, stageName, recipe, run, masterDraft, lang,
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
  const gateHere = _shouldGate(stageName, recipe, run.gate_strategy);
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
};
