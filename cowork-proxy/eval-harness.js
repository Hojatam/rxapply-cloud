// cowork-proxy/eval-harness.js
// =====================================================================
// M43 · Country-cohort eval harness with pairwise judge.
//
// The harness lets the founder, before each country launch (UK → USA →
// DE → AU → CA → UAE → SA) confirm that a new recipe / model change /
// brand-profile update doesn't regress quality vs. an approved baseline.
//
// Three things this module does:
//
//   1. CRUD on `eval_golden_prompts` — the founder's curated test set
//      per country. Each prompt points at a baseline compose_runs row
//      (the canonical reference output for that prompt).
//
//   2. runCandidate(promptId, runOverrides) — runs the prompt through the
//      current Compose pipeline as a candidate, returns the new compose
//      run id.
//
//   3. judgePairwise(promptId, candidateRunId) — invokes the 'judge'
//      capability (Bidar by default) to compare candidate vs. baseline
//      across 3 axes: on-brand voice, factual accuracy, format fit.
//      Records the verdict in `eval_pairwise_runs`.
//
// The judge is the same LLM facade the rest of the orchestrator uses.
// No external research; KB block + brand profile auto-injected.
// =====================================================================

'use strict';

const { query, queryRows, queryValue, queryReturning, q, qJson, qArr } = require('./db');
const llm           = require('./llm');
const agentModels   = require('./agent-models');
const capabilities  = require('./agent-capabilities');
const brandProfile  = require('./brand-profile');
const KB            = require('./knowledge-base');
const composeOrchestrator = require('./compose-orchestrator');
const logWriter     = require('./log-writer');

// ── Golden prompts CRUD ──────────────────────────────────────────────

async function listGoldenPrompts({ country = null, recipeId = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const conds = ['archived = false'];
  if (country)  conds.push(`country = ${q(country)}`);
  if (recipeId) conds.push(`recipe_id = ${q(recipeId)}`);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY created_at DESC), '[]'::json)
      FROM (SELECT id::text, country, recipe_id, topic, audience, master_lang, target_langs,
                    options, baseline_run_id::text, notes, created_at::text
              FROM eval_golden_prompts
             WHERE ${conds.join(' AND ')}
             ORDER BY created_at DESC LIMIT ${limit}) p;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch { return []; }
}

async function createGoldenPrompt({
  country = null, recipeId, topic, audience = null,
  masterLang = 'en', targetLangs = [], options = {},
  baselineRunId = null, notes = null,
}) {
  if (!recipeId || !topic) throw new Error('recipeId + topic required');
  const id = await queryReturning(`
    INSERT INTO eval_golden_prompts
      (country, recipe_id, topic, audience, master_lang, target_langs,
        options, baseline_run_id, notes)
    VALUES (
      ${q(country)}, ${q(recipeId)}, ${q(topic)}, ${q(audience)},
      ${q(masterLang)}, ${qArr(targetLangs || [])},
      ${qJson(options || {})}, ${q(baselineRunId)}, ${q(notes)}
    ) RETURNING id::text;`);
  return { ok: true, id };
}

async function updateGoldenPrompt(id, fields) {
  if (!id) throw new Error('id required');
  const allowed = ['country', 'recipe_id', 'topic', 'audience', 'master_lang',
                    'baseline_run_id', 'notes', 'archived'];
  const sets = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'baseline_run_id' || k === 'archived' || k === 'master_lang' || k === 'recipe_id'
        || k === 'country' || k === 'topic' || k === 'audience' || k === 'notes') {
      sets.push(`${k} = ${k === 'archived' ? (v ? 'TRUE' : 'FALSE') : q(v)}`);
    }
  }
  if (fields.options) sets.push(`options = ${qJson(fields.options)}`);
  if (Array.isArray(fields.target_langs)) sets.push(`target_langs = ${qArr(fields.target_langs)}`);
  if (sets.length === 0) return { ok: false, error: 'no allowed fields supplied' };
  sets.push('updated_at = NOW()');
  await query(`UPDATE eval_golden_prompts SET ${sets.join(', ')} WHERE id = ${q(id)};`);
  return { ok: true };
}

async function archiveGoldenPrompt(id) {
  return updateGoldenPrompt(id, { archived: true });
}

async function getGoldenPrompt(id) {
  if (!id) return null;
  const sql = `
    SELECT row_to_json(p) FROM (
      SELECT id::text, country, recipe_id, topic, audience, master_lang, target_langs,
              options, baseline_run_id::text, notes, archived,
              created_at::text, updated_at::text
        FROM eval_golden_prompts WHERE id = ${q(id)}
    ) p;`;
  try { return JSON.parse((await queryValue(sql)) || 'null'); } catch { return null; }
}

// ── Run candidate against a prompt ───────────────────────────────────

async function runCandidate(promptId, runOverrides = {}) {
  const p = await getGoldenPrompt(promptId);
  if (!p) throw new Error('prompt not found');
  const r = await composeOrchestrator.start({
    recipeId:    p.recipe_id,
    topic:       p.topic,
    audience:    p.audience,
    masterLang:  p.master_lang,
    targetLangs: p.target_langs || [],
    options:     { ...(p.options || {}), ...(runOverrides.options || {}) },
    gateStrategy: runOverrides.gateStrategy || 'none',     // evals run end-to-end
    agentOverrides: runOverrides.agentOverrides || {},
  });
  return { ok: true, candidate_run_id: r.id, prompt_id: promptId };
}

// ── Pairwise judge ───────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are Bidar, the pairwise judge for the RxApply eval harness.
You are given two compose-run outputs (CANDIDATE and BASELINE) for the SAME
prompt. Decide which is better on three axes: on-brand voice, factual
accuracy (KB-grounded), and format fit. Return your verdict.

Important:
- Be DECISIVE. Pick a winner per axis. Use 'tie' only when both are
  genuinely indistinguishable.
- Cite specific text fragments when you call out a problem.
- For factual accuracy, use the KB block in your system prompt as the
  ground truth. If a claim isn't in the KB, treat it as "unverified" and
  count it against whichever side made it.
- For on-brand voice, use the brand profile in your system prompt.

Return ONLY this JSON:

{
  "winner_overall":  "candidate" | "baseline" | "tie",
  "winner_on_brand": "candidate" | "baseline" | "tie",
  "winner_accuracy": "candidate" | "baseline" | "tie",
  "winner_format":   "candidate" | "baseline" | "tie",
  "reasoning": {
    "on_brand": "<one or two sentences citing specific text>",
    "accuracy": "<one or two sentences citing specific claims>",
    "format":   "<one or two sentences>"
  },
  "candidate_strengths": ["<one short bullet>", "..."],
  "candidate_weaknesses": ["..."],
  "baseline_strengths":  ["..."],
  "baseline_weaknesses": ["..."],
  "notable_regression": "<one sentence if candidate is worse than baseline in a meaningful way; else null>",
  "confidence": 0.00
}`;

function _stripJsonFences(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    const lines = s.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    s = lines.join('\n');
  }
  if (!s.startsWith('{')) {
    const i = s.indexOf('{');
    if (i >= 0) s = s.slice(i);
  }
  return s;
}

function _summariseRunForJudge(run) {
  // Build a compact textual summary the judge can compare. We include the
  // master-language render output (final artifact) + the critique stage
  // verdict if present.
  const masterLang = run.master_lang;
  const renderStage = (run.stages || []).find(s => s.stage_name === 'render' && (s.lang || masterLang) === masterLang);
  const critiqueStage = (run.stages || []).find(s => s.stage_name === 'critique' && s.lang == null);
  const verifyStage = (run.stages || []).find(s => s.stage_name === 'verify' && s.lang == null);
  return {
    run_id: run.id,
    recipe: run.recipe_id,
    final_output: renderStage && renderStage.output ? renderStage.output : null,
    critique: critiqueStage && critiqueStage.output ? {
      verdict: critiqueStage.output.verdict,
      reason: critiqueStage.output.verdict_reason,
      scores: critiqueStage.output.scores,
    } : null,
    verify: verifyStage && verifyStage.output ? {
      passed: verifyStage.output.passed,
      issues_count: Array.isArray(verifyStage.output.issues) ? verifyStage.output.issues.length : 0,
    } : null,
    total_cost_usd: run.total_cost_usd,
  };
}

async function judgePairwise(promptId, candidateRunId, { judgeAgent = 'bidar' } = {}) {
  const prompt = await getGoldenPrompt(promptId);
  if (!prompt) throw new Error('prompt not found');
  if (!prompt.baseline_run_id) throw new Error('prompt has no baseline_run_id; set one first');

  const candidate = await composeOrchestrator.getRun(candidateRunId);
  const baseline  = await composeOrchestrator.getRun(prompt.baseline_run_id);
  if (!candidate) throw new Error('candidate run not found');
  if (!baseline)  throw new Error('baseline run not found');

  // Resolve judge agent + model
  const agent = capabilities.resolveAgent({
    capability: 'judge', override: judgeAgent, recipeDefault: null, stageName: 'judge',
  });
  const { id: model } = agentModels.resolveModel(agent);

  // Open an agent_runs row for the judge
  const t0 = Date.now();
  let agentRunId = null;
  try {
    const lr = await logWriter.recordRunStart({
      agent, command: `eval:judge:${prompt.recipe_id}:${prompt.country || 'multi'}`,
      args: [prompt.topic],
    });
    agentRunId = lr.runId;
  } catch (_) { /* non-fatal */ }

  // System prompt: judge instructions + brand + KB
  const blocks = [JUDGE_SYSTEM];
  const brand = brandProfile.renderAsPromptBlock();
  if (brand) blocks.push(brand);
  try {
    const country = prompt.country || KB.detectCountry(prompt.topic);
    const kb = KB.renderAsBlock({ country, query: prompt.topic, limit: 8 });
    if (kb) blocks.push(kb);
  } catch (_) { /* non-fatal */ }

  const userPrompt = [
    `Country: ${prompt.country || 'multi'}`,
    `Recipe: ${prompt.recipe_id}`,
    `Topic: ${prompt.topic}`,
    prompt.audience ? `Audience: ${prompt.audience}` : '',
    `Master language: ${prompt.master_lang}`,
    '',
    '--- CANDIDATE (the new run) ---',
    JSON.stringify(_summariseRunForJudge(candidate), null, 2),
    '',
    '--- BASELINE (the approved reference) ---',
    JSON.stringify(_summariseRunForJudge(baseline), null, 2),
    '',
    'Return your JSON verdict now.',
  ].filter(Boolean).join('\n');

  let parsed, errMsg = null;
  let inputTokens = 0, outputTokens = 0;
  try {
    const r = await llm.chat({
      model,
      system: blocks.join('\n\n'),
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2200,
    });
    parsed = JSON.parse(_stripJsonFences(r.output));
    inputTokens  = (r.usage && r.usage.input_tokens) || 0;
    outputTokens = (r.usage && r.usage.output_tokens) || 0;
  } catch (e) {
    errMsg = e.message;
  }

  const costUsd = agentModels.calcCost(model, inputTokens, outputTokens);

  if (errMsg) {
    if (agentRunId) {
      try { await logWriter.recordRunEnd({ runId: agentRunId, agent, status: 'fail', error: errMsg, durationMs: Date.now() - t0, costUsd }); } catch (_) {}
    }
    throw new Error(`judge call failed: ${errMsg}`);
  }

  if (agentRunId) {
    try {
      await logWriter.recordRunEnd({
        runId: agentRunId, agent, status: 'success',
        parsedOutput: parsed, costUsd, durationMs: Date.now() - t0,
      });
    } catch (_) {}
  }

  // Persist the eval run
  const evalRunId = await queryReturning(`
    INSERT INTO eval_pairwise_runs
      (golden_prompt_id, candidate_run_id, baseline_run_id, judge_agent, judge_model,
        judge_output, winner, on_brand_winner, accuracy_winner, format_fit_winner,
        cost_usd, duration_ms)
    VALUES (
      ${q(promptId)}, ${q(candidateRunId)}, ${q(prompt.baseline_run_id)},
      ${q(agent)}, ${q(model)},
      ${qJson(parsed)},
      ${q(parsed.winner_overall)},
      ${q(parsed.winner_on_brand)},
      ${q(parsed.winner_accuracy)},
      ${q(parsed.winner_format)},
      ${costUsd}, ${Date.now() - t0}
    ) RETURNING id::text;`);

  return {
    ok: true, eval_run_id: evalRunId, prompt_id: promptId,
    candidate_run_id: candidateRunId, baseline_run_id: prompt.baseline_run_id,
    verdict: parsed, judge_agent: agent, judge_model: model, cost_usd: costUsd,
  };
}

// ── Listings ─────────────────────────────────────────────────────────

async function listEvalRuns({ promptId = null, country = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const conds = [];
  if (promptId) conds.push(`golden_prompt_id = ${q(promptId)}`);
  let join = '';
  if (country) {
    join = 'JOIN eval_golden_prompts gp ON gp.id = e.golden_prompt_id';
    conds.push(`gp.country = ${q(country)}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(r) ORDER BY created_at DESC), '[]'::json)
      FROM (SELECT e.id::text, e.golden_prompt_id::text, e.candidate_run_id::text,
                    e.baseline_run_id::text, e.winner, e.on_brand_winner,
                    e.accuracy_winner, e.format_fit_winner, e.judge_agent,
                    e.judge_model, e.cost_usd, e.duration_ms, e.created_at::text
              FROM eval_pairwise_runs e ${join}
             ${where}
             ORDER BY e.created_at DESC LIMIT ${limit}) r;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch { return []; }
}

async function scoreboard({ country = null } = {}) {
  // Win-rate per country/recipe — for the dashboard summary
  const where = country ? `WHERE gp.country = ${q(country)}` : '';
  const sql = `
    SELECT
      gp.country,
      gp.recipe_id,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE elv.winner = 'candidate') AS wins,
      COUNT(*) FILTER (WHERE elv.winner = 'baseline')  AS losses,
      COUNT(*) FILTER (WHERE elv.winner = 'tie')       AS ties
    FROM eval_golden_prompts gp
    LEFT JOIN eval_latest_verdict elv ON elv.golden_prompt_id = gp.id
    ${where}
    GROUP BY gp.country, gp.recipe_id
    ORDER BY gp.country NULLS LAST, gp.recipe_id;
  `;
  try { return await queryRows(sql); } catch { return []; }
}

module.exports = {
  // golden prompts
  listGoldenPrompts, createGoldenPrompt, updateGoldenPrompt, archiveGoldenPrompt, getGoldenPrompt,
  // running + judging
  runCandidate, judgePairwise,
  // analytics
  listEvalRuns, scoreboard,
};
