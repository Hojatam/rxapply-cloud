// cowork-proxy/cost-aware-router.js
// =====================================================================
// M42 · Cost-aware model router.
//
// Picks the cheapest model that meets a per-capability quality bar.
// Reads rolling 7-day quality (from agent_evals) and cost (from agent_runs)
// to do the math. Has hard FLOORS that prevent silent quality regressions
// on capabilities where judgment matters.
//
// Founder rule (per M40 + M41 conversation):
//   "We can use cheaper models just for ordinary and easy jobs."
//
// So:
//   • verify, verify-translation, audit, critique, design, draft  → high-quality floor
//   • plan, research, adapt, translate, render                     → cheap models OK
//
// The router runs ONLY when no founder pin is set for that agent.
// If the founder pinned a model via the per-agent picker, that wins always.
//
// Public API:
//   pickModelFor({ agent, capability }) → modelId | null
//   reasonFor({ agent, capability })    → debug info (latest pick + why)
//   refresh()                           → invalidate cache (call after rating bursts)
// =====================================================================

'use strict';

const { queryRows, queryValue } = require('./db');
const agentModels = require('./agent-models');

// ── Floors per capability ────────────────────────────────────────────
// FLOOR semantics:
//   null              → no floor; router can pick the cheapest registered model
//   "model-id"        → router can pick any model whose tier is >= this model's tier
//   "NEVER_AUTO_PICK" → router never picks; use the agent's pin or DEFAULT_MODEL
const FLOORS = {
  // Quality-critical — never auto-downgrade
  'verify':              'NEVER_AUTO_PICK',
  'verify-translation':  'NEVER_AUTO_PICK',
  // M119 · IG-v2 KB-only fact check is the single most important gate
  // before image generation. Always founder-pinned model.
  'verify-kb':           'NEVER_AUTO_PICK',

  // Judgment-heavy — Sonnet 4.6 minimum
  'audit':               'claude-sonnet-4-6',
  'critique':            'claude-sonnet-4-6',
  'design':              'claude-sonnet-4-6',
  // M119 · IG-v2 design has equal stakes to the legacy 'design' — same floor
  'design-v2':           'claude-sonnet-4-6',

  // Voice-heavy — Sonnet 4.6 floor (founder can pin Opus per agent)
  'draft':               'claude-sonnet-4-6',

  // Structured / mechanical — cheaper models OK
  'plan':                null,
  'research':            null,
  'adapt':               null,
  'translate':           null,
  'render':              null,   // (renderers are deterministic; no LLM call here)
  // M119 · IG-v2 cheap stages — synthesis + structuring tasks where the
  // founder's two approval gates catch any quality drift downstream.
  'kb-dossier':          null,
  'post-plan':           null,
  // M123 · IG-v2 brand-voice tone check on English content; cheap-LLM is fine.
  'brand-voice':         null,
  // M123 · IG-v2 flagship translation. Native-quality translation across
  // languages (Persian / Arabic / German / etc) is too important to auto-
  // downgrade. Founder-pinned model only — we expect claude-opus-4-7 here.
  'translate-post':      'NEVER_AUTO_PICK',

  // M128 · Hojat single-shot composer. Does the work of post-plan +
  // verify-kb + brand-voice + translate-post + design-v2 in ONE call,
  // so it inherits the strictest floor of those (translate-post +
  // verify-kb are both NEVER_AUTO_PICK premium). Pinned to flagship.
  'full-post':           'NEVER_AUTO_PICK',

  // Image generation has its own multi-provider router (compose-image.js)
  'image':               'NEVER_AUTO_PICK',
};

// Rough tier ordering (cheapest → most expensive) for known models.
// Used to enforce "tier >= floor" comparisons.
const TIER_ORDER = [
  'haiku-4-5',
  'gpt-5.4',
  'claude-sonnet-4-6',
  'gpt-5.5',
  'o3',
  'claude-opus-4-7',
];
function _tierIndex(modelId) {
  // Best-effort: substring match on the registry id
  for (let i = 0; i < TIER_ORDER.length; i++) {
    if (modelId && modelId.toLowerCase().includes(TIER_ORDER[i])) return i;
  }
  return -1;   // unknown → treat as low tier
}

// ── Quality + cost rolling stats ─────────────────────────────────────
const QUALITY_BAR = 4.0;            // out of 5; required to keep a cheaper model
const WINDOW_DAYS = 7;
const MIN_RUNS_FOR_SIGNAL = 5;      // need at least this many runs to trust the signal
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

let _cache = { data: null, until: 0 };

async function _loadStats({ refresh = false } = {}) {
  if (!refresh && _cache.data && Date.now() < _cache.until) return _cache.data;

  const sql = `
    SELECT
      r.agent,
      COALESCE((r.input_payload->>'command')::text, '')   AS command,
      r.output_payload->>'model'                          AS model_from_output,
      AVG(NULLIF(e.score, 0))::float                      AS avg_quality,
      COUNT(e.id)                                          AS n_ratings,
      COUNT(r.id)                                          AS n_runs,
      AVG(r.cost_usd_actual)::float                        AS avg_cost
    FROM agent_runs r
    LEFT JOIN agent_evals e
      ON e.run_id = r.id AND e.kind = 'rating'
    WHERE r.started_at > NOW() - INTERVAL '${WINDOW_DAYS} days'
      AND r.status = 'success'
      AND r.agent IS NOT NULL
    GROUP BY r.agent, command, model_from_output;
  `;

  let rows = [];
  try { rows = await queryRows(sql) || []; } catch (_) { /* schema may differ; non-fatal */ }

  // Index by (agent, capability) — capability inferred from command prefix.
  // commands look like 'compose:<recipe>:<stage>' — we extract <stage> as capability.
  const byKey = {};
  for (const r of rows) {
    const cmd = r.command || '';
    const m = cmd.match(/^compose:[^:]+:([^:]+)/);
    const cap = m ? m[1] : null;
    if (!cap) continue;
    if (!r.model_from_output) continue;
    const key = `${r.agent}|${cap}|${r.model_from_output}`;
    byKey[key] = {
      agent: r.agent,
      capability: cap,
      model: r.model_from_output,
      avg_quality: r.avg_quality,
      avg_cost: r.avg_cost,
      n_runs: parseInt(r.n_runs, 10) || 0,
      n_ratings: parseInt(r.n_ratings, 10) || 0,
    };
  }

  _cache.data = byKey;
  _cache.until = Date.now() + CACHE_TTL_MS;
  return byKey;
}

// ── Pick model for an (agent, capability) ────────────────────────────
async function pickModelFor({ agent, capability }) {
  if (!agent || !capability) return null;
  const floor = FLOORS[capability];
  if (floor === 'NEVER_AUTO_PICK') return null;   // caller falls back to pin / default

  // Founder pin always wins — if pinned, return it untouched.
  const overrides = agentModels.getOverrides() || {};
  const pinned = overrides[String(agent).toLowerCase()];
  if (pinned) return pinned;

  const stats = await _loadStats();
  const registry = agentModels.MODEL_REGISTRY;

  // Candidate models: (a) all registered models in tier >= floor
  //                   (b) of the same provider as the agent's natural provider, if any
  const floorIdx = floor ? _tierIndex(floor) : -1;
  const candidates = Object.keys(registry).filter(id => {
    if (floor && _tierIndex(id) < floorIdx) return false;
    return true;
  });

  // Score: cheapest model whose rolling avg_quality (for this agent+capability) >= QUALITY_BAR
  // For models with insufficient signal (< MIN_RUNS_FOR_SIGNAL), assume they meet the bar
  // — this keeps the system from getting stuck on whichever model was used first.
  let best = null;
  let bestCost = Infinity;
  for (const modelId of candidates) {
    const s = stats[`${agent}|${capability}|${modelId}`];
    const enough = s && s.n_runs >= MIN_RUNS_FOR_SIGNAL && s.n_ratings >= 1;
    const meetsBar = !enough || (s.avg_quality == null) || s.avg_quality >= QUALITY_BAR;
    if (!meetsBar) continue;
    const info = registry[modelId];
    // Use registry's per-token cost as the proxy when avg_cost unavailable
    const costProxy = info && (info.inputPerToken + info.outputPerToken) || 1;
    if (costProxy < bestCost) {
      bestCost = costProxy;
      best = modelId;
    }
  }

  return best;
}

// ── Diagnostic: explain why a model would be picked right now ────────
async function reasonFor({ agent, capability }) {
  const floor = FLOORS[capability];
  if (floor === 'NEVER_AUTO_PICK') {
    return { agent, capability, picked: null, reason: 'capability is NEVER_AUTO_PICK; uses agent pin or default' };
  }
  const overrides = agentModels.getOverrides() || {};
  const pinned = overrides[String(agent).toLowerCase()];
  if (pinned) {
    return { agent, capability, picked: pinned, reason: 'founder pinned this model on the agent' };
  }
  const stats = await _loadStats();
  const registry = agentModels.MODEL_REGISTRY;
  const floorIdx = floor ? _tierIndex(floor) : -1;
  const evaluated = Object.keys(registry).filter(id => !floor || _tierIndex(id) >= floorIdx).map(id => {
    const s = stats[`${agent}|${capability}|${id}`];
    const info = registry[id];
    return {
      model_id: id,
      cost_proxy: (info && (info.inputPerToken + info.outputPerToken)) || null,
      avg_quality: s && s.avg_quality,
      n_runs: s ? s.n_runs : 0,
      n_ratings: s ? s.n_ratings : 0,
      meets_bar: !s || s.n_runs < MIN_RUNS_FOR_SIGNAL || s.avg_quality == null || s.avg_quality >= QUALITY_BAR,
    };
  }).sort((a, b) => (a.cost_proxy || 0) - (b.cost_proxy || 0));
  const pick = evaluated.find(e => e.meets_bar);
  return {
    agent, capability,
    floor,
    quality_bar: QUALITY_BAR,
    window_days: WINDOW_DAYS,
    candidates: evaluated,
    picked: pick ? pick.model_id : null,
    reason: pick ? 'cheapest candidate meeting quality bar' : 'no candidate meets quality bar; falling back',
  };
}

function refresh() {
  _cache = { data: null, until: 0 };
}

module.exports = {
  pickModelFor,
  reasonFor,
  refresh,
  FLOORS,
  QUALITY_BAR,
  WINDOW_DAYS,
};
