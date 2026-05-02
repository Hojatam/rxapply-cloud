// cowork-proxy/agent-models.js
// =====================================================================
// Per-agent Anthropic model selection.  [cloud build]
//
// Resolution order for any Anthropic call:
//   1. dashboard_settings.agent_models[<agent_name>]   (founder override)
//   2. ANTHROPIC_MODEL env var                          (global override)
//   3. DEFAULT_MODEL constant                            (hardcoded fallback)
//
// MODEL_REGISTRY is the source of truth for available models +
// per-token pricing. Cost calculations (compose-ig, afshin draft, F5 chat)
// look up rates from here so per-agent cost stays accurate when the model
// changes.
//
// Sync vs async: `resolveModel()` and `getOverrides()` stay sync because
// they're called many times per second on hot paths. The cache is loaded
// once on boot via `refresh()` (await) and refreshed after each PATCH.
// =====================================================================

const { queryValue, query, q } = require('./db');

// Anthropic model registry (verified live against /v1/models on 2026-05-01).
// Pricing is USD per token (= $X per 1M / 1_000_000).
const MODEL_REGISTRY = {
  'claude-opus-4-7': {
    label: 'Claude Opus 4.7',
    tier: 'flagship',
    inputPerToken:  0.000015,
    outputPerToken: 0.000075,
    contextWindow: 200000,
    notes: 'Top-tier reasoning. 5× cost of Sonnet. Use for the hardest tasks.',
  },
  'claude-opus-4-6': {
    label: 'Claude Opus 4.6',
    tier: 'flagship',
    inputPerToken:  0.000015,
    outputPerToken: 0.000075,
    contextWindow: 200000,
    notes: 'Previous Opus generation. Pick 4.7 unless you need stable 4.6 behaviour.',
  },
  'claude-sonnet-4-6': {
    label: 'Claude Sonnet 4.6',
    tier: 'balanced',
    inputPerToken:  0.000003,
    outputPerToken: 0.000015,
    contextWindow: 200000,
    notes: 'Latest Sonnet. Same price as 4.5; usually a quality bump for free.',
  },
  'claude-sonnet-4-5-20250929': {
    label: 'Claude Sonnet 4.5',
    tier: 'balanced',
    inputPerToken:  0.000003,
    outputPerToken: 0.000015,
    contextWindow: 200000,
    notes: 'Default. Best price-to-quality across most agent work.',
  },
  'claude-haiku-4-5-20251001': {
    label: 'Claude Haiku 4.5',
    tier: 'fast',
    inputPerToken:  0.000001,
    outputPerToken: 0.000005,
    contextWindow: 200000,
    notes: 'Cheap and fast. Good for high-volume, structured outputs.',
  },
};

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// In-memory cache of the overrides map. Loaded on boot via refresh();
// refreshed after every setOverride. Keeps per-call resolution at zero
// extra DB load.
let _overridesCache = null;

async function refresh() {
  try {
    const raw = await queryValue(`SELECT agent_models FROM dashboard_settings WHERE id = 1;`);
    _overridesCache = raw ? JSON.parse(raw) : {};
  } catch (_) {
    _overridesCache = {};
  }
  return _overridesCache;
}

function getOverrides() {
  // Sync caller; if cache hasn't been populated yet (boot race), kick off
  // a background refresh and return {} for now (= no overrides → use the
  // global default model). This matches the legacy behaviour exactly.
  if (_overridesCache) return _overridesCache;
  refresh().catch(() => {});
  return {};
}

function _norm(name) { return String(name || '').toLowerCase().trim(); }

function listModels() {
  return Object.entries(MODEL_REGISTRY).map(([id, m]) => ({ id, ...m }));
}

function resolveModel(agentName) {
  const overrides = getOverrides();
  const candidate = overrides[_norm(agentName)] ||
                    process.env.ANTHROPIC_MODEL ||
                    DEFAULT_MODEL;
  const info = MODEL_REGISTRY[candidate] || MODEL_REGISTRY[DEFAULT_MODEL];
  return { id: candidate, info };
}

async function setOverride(agentName, modelKey) {
  const a = _norm(agentName);
  if (!a) return { ok: false, error: 'agent name required' };
  if (modelKey && !MODEL_REGISTRY[modelKey]) {
    return { ok: false, error: `unknown model: ${modelKey}` };
  }
  const cur = getOverrides();
  if (modelKey) cur[a] = modelKey;
  else delete cur[a];
  try {
    await query(`UPDATE dashboard_settings
                    SET agent_models = ${q(JSON.stringify(cur))}::jsonb,
                        updated_at = NOW()
                  WHERE id = 1;`);
    await refresh();
    return { ok: true, agent: a, model: modelKey || null };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

function calcCost(modelId, inputTokens, outputTokens) {
  const info = MODEL_REGISTRY[modelId] || MODEL_REGISTRY[DEFAULT_MODEL];
  const c = (inputTokens || 0) * info.inputPerToken
          + (outputTokens || 0) * info.outputPerToken;
  return Math.round(c * 1e6) / 1e6;
}

module.exports = {
  MODEL_REGISTRY,
  DEFAULT_MODEL,
  listModels,
  resolveModel,
  setOverride,
  getOverrides,
  refresh,
  calcCost,
};
