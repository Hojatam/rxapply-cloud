// cowork-proxy/agent-models.js
// =====================================================================
// Per-agent LLM model selection.  [cloud build · M16]
//
// Multi-provider registry. Each model declares its provider so the
// dispatcher in `llm.js` knows whether to call Anthropic or OpenAI.
//
// Resolution order for any LLM call:
//   1. dashboard_settings.agent_models[<agent_name>]   (founder override)
//   2. ANTHROPIC_MODEL / OPENAI_MODEL env var          (per-provider override)
//   3. DEFAULT_MODEL constant                          (hardcoded fallback)
//
// Roster (May 2026, flagship-only — founder explicitly excluded older /
// weaker models):
//   • claude-opus-4-7      Anthropic flagship          $15 in / $75 out
//   • claude-sonnet-4-6    Anthropic balanced flagship $3  in / $15 out
//   • gpt-5.5              OpenAI flagship             $5  in / $30 out
//   • gpt-5.4              OpenAI balanced flagship    $2.50 in / $15 out
//   • o3                   OpenAI reasoning specialist $variable
// =====================================================================

const { queryValue, query, q } = require('./db');

// Each entry includes `provider` so llm.js can dispatch correctly.
// Pricing is USD per token (= $X per 1M / 1_000_000).
const MODEL_REGISTRY = {
  // ── Anthropic ───────────────────────────────────────────────────
  'claude-opus-4-7': {
    label: 'Claude Opus 4.7',
    provider: 'anthropic',
    tier: 'flagship',
    inputPerToken:  0.000015,
    outputPerToken: 0.000075,
    contextWindow: 200_000,
    notes: 'Top-tier reasoning + agentic. Best for the hardest tasks (Pooya / Sepehr / Kherad / Bidar / Davari).',
  },
  'claude-sonnet-4-6': {
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'balanced',
    inputPerToken:  0.000003,
    outputPerToken: 0.000015,
    contextWindow: 200_000,
    notes: 'New Anthropic default — near-Opus quality at 5× lower cost. Great for translation, structured output, scoring.',
  },

  // ── OpenAI ──────────────────────────────────────────────────────
  'gpt-5.5': {
    label: 'GPT-5.5',
    provider: 'openai',
    tier: 'flagship',
    inputPerToken:  0.000005,
    outputPerToken: 0.000030,
    contextWindow: 400_000,
    notes: 'OpenAI top flagship (Apr 2026). Long-horizon agentic work; alternative voice to Opus 4.7.',
  },
  'gpt-5.4': {
    label: 'GPT-5.4',
    provider: 'openai',
    tier: 'balanced',
    inputPerToken:  0.0000025,
    outputPerToken: 0.000015,
    contextWindow: 400_000,
    notes: 'Cost-efficient OpenAI flagship. Good for high-volume transformations (Avang fan-outs).',
  },
  'o3': {
    label: 'o3 (reasoning)',
    provider: 'openai',
    tier: 'reasoning',
    inputPerToken:  0.000010,
    outputPerToken: 0.000040,
    contextWindow: 200_000,
    notes: 'OpenAI reasoning specialist. Strong for adversarial review (Bidar / Davari) and hard analysis.',
  },
};

// Default landing zone when no override is set. Sonnet 4.6 is the
// near-Opus default that won't break the bank on volume.
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// In-memory cache of the per-agent overrides. Loaded on boot via
// refresh(); refreshed after every setOverride. Keeps resolveModel()
// at zero extra DB load on the hot path.
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
  if (_overridesCache) return _overridesCache;
  refresh().catch(() => {});
  return {};
}

function _norm(name) { return String(name || '').toLowerCase().trim(); }

function listModels() {
  return Object.entries(MODEL_REGISTRY).map(([id, m]) => ({ id, ...m }));
}

// Resolve which model to use for a given agent.
//
// The resolved model's `provider` field tells the dispatcher (llm.js)
// whether to call Anthropic or OpenAI. If the founder previously set
// an override pointing at a model we just dropped (M16a), we silently
// fall back to DEFAULT_MODEL — never throw, because this runs on the
// LLM hot path and a thrown error would 500 the chat endpoint.
function resolveModel(agentName) {
  const overrides = getOverrides();
  const overrideKey = overrides[_norm(agentName)];

  // If an override exists and is still in the registry, use it.
  if (overrideKey && MODEL_REGISTRY[overrideKey]) {
    return { id: overrideKey, info: MODEL_REGISTRY[overrideKey] };
  }

  // Per-provider env-var defaults — useful for "use the latest model
  // everywhere without per-agent overrides".
  const envAnthropic = process.env.ANTHROPIC_MODEL;
  const envOpenAI    = process.env.OPENAI_MODEL;
  if (envAnthropic && MODEL_REGISTRY[envAnthropic]) return { id: envAnthropic, info: MODEL_REGISTRY[envAnthropic] };
  if (envOpenAI    && MODEL_REGISTRY[envOpenAI])    return { id: envOpenAI,    info: MODEL_REGISTRY[envOpenAI] };

  // Hardcoded default.
  return { id: DEFAULT_MODEL, info: MODEL_REGISTRY[DEFAULT_MODEL] };
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

// Get the provider for a model id. Used by the dispatcher.
function providerFor(modelId) {
  const info = MODEL_REGISTRY[modelId];
  return info ? info.provider : 'anthropic';   // safe default
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
  providerFor,
};
