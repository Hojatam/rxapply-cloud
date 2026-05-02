// cowork-proxy/agent-models.js
// =====================================================================
// Per-agent Anthropic model selection.
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
// =====================================================================

const { spawnSync } = require('child_process');

const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';

// Anthropic model registry (verified live against /v1/models on 2026-05-01).
// Pricing is USD per token (= $X per 1M / 1_000_000).
const MODEL_REGISTRY = {
  'claude-opus-4-7': {
    label: 'Claude Opus 4.7',
    tier: 'flagship',
    inputPerToken:  0.000015,   // $15/M
    outputPerToken: 0.000075,   // $75/M
    contextWindow: 200000,
    notes: 'Top-tier reasoning. 5× cost of Sonnet. Use for the hardest tasks (Pooya briefs, Sepehr masters, Kherad scoring, Bidar / Davari audit).',
  },
  'claude-opus-4-6': {
    label: 'Claude Opus 4.6',
    tier: 'flagship',
    inputPerToken:  0.000015,
    outputPerToken: 0.000075,
    contextWindow: 200000,
    notes: 'Previous Opus generation. Same price as 4.7; pick 4.7 unless you specifically need stable 4.6 behaviour.',
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
    inputPerToken:  0.000003,   // $3/M
    outputPerToken: 0.000015,   // $15/M
    contextWindow: 200000,
    notes: 'Default. Best price-to-quality across most agent work.',
  },
  'claude-haiku-4-5-20251001': {
    label: 'Claude Haiku 4.5',
    tier: 'fast',
    inputPerToken:  0.000001,   // $1/M
    outputPerToken: 0.000005,   // $5/M
    contextWindow: 200000,
    notes: 'Cheap and fast. Good for high-volume, structured outputs (Mehrban DM replies, Bineh scoring, Rahbar enrolment, Zirak journaling).',
  },
};

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// ── DB I/O ────────────────────────────────────────────────────────────
// Pass a Buffer for input — guards against the Windows cp1252 stdin
// corruption we hit in the compose-ig path. Agent names are ASCII so
// this is just defensive consistency with the rest of the codebase.
function _psql(sql) {
  const r = spawnSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: Buffer.from(sql, 'utf-8') });
  if (r.status !== 0) {
    const err = (r.stderr || Buffer.alloc(0)).toString('utf-8');
    throw new Error(`psql (${r.status}): ${err.slice(0, 300)}`);
  }
  return (r.stdout || Buffer.alloc(0)).toString('utf-8').trim();
}

// In-memory cache of the overrides map. Read once on startup; refresh
// after every PATCH. Keeps per-call resolution at zero extra DB load.
let _overridesCache = null;
function _loadOverrides() {
  try {
    const raw = _psql(`SELECT agent_models FROM dashboard_settings WHERE id = 1;`);
    _overridesCache = raw ? JSON.parse(raw) : {};
  } catch (_) {
    _overridesCache = {};
  }
  return _overridesCache;
}
function getOverrides() {
  return _overridesCache || _loadOverrides();
}
function _refreshOverrides() {
  _overridesCache = null;
  return _loadOverrides();
}

// Normalize an agent name (lowercase, strip funny chars) for lookup.
function _norm(name) {
  return String(name || '').toLowerCase().trim();
}

// ── Public API ────────────────────────────────────────────────────────

// Return list of model entries for the registry UI.
function listModels() {
  return Object.entries(MODEL_REGISTRY).map(([id, m]) => ({
    id, ...m,
  }));
}

// Resolve which Anthropic model to use for a given agent invocation.
// Returns { id, info } where info is the registry entry (with pricing).
function resolveModel(agentName) {
  const overrides = getOverrides();
  const candidate = overrides[_norm(agentName)] ||
                    process.env.ANTHROPIC_MODEL ||
                    DEFAULT_MODEL;
  // If the candidate isn't in the registry (typo, retired model), fall back
  // safely to default — but keep the candidate id so the API call still
  // tries it (Anthropic may have new models we haven't catalogued yet).
  const info = MODEL_REGISTRY[candidate] || MODEL_REGISTRY[DEFAULT_MODEL];
  return { id: candidate, info };
}

// Set or clear an override. Pass modelKey=null to remove.
function setOverride(agentName, modelKey) {
  const a = _norm(agentName);
  if (!a) return { ok: false, error: 'agent name required' };
  if (modelKey && !MODEL_REGISTRY[modelKey]) {
    return { ok: false, error: `unknown model: ${modelKey}` };
  }
  const cur = getOverrides();
  if (modelKey) cur[a] = modelKey;
  else delete cur[a];
  try {
    _psql(`UPDATE dashboard_settings SET agent_models = '${JSON.stringify(cur).replace(/'/g, "''")}'::jsonb, updated_at = NOW() WHERE id = 1;`);
    _refreshOverrides();
    return { ok: true, agent: a, model: modelKey || null };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

// Cost calculator — uses the actual model's rates rather than hardcoded.
// Returns USD as a number, rounded to 6 decimals.
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
  calcCost,
};
