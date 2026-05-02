// cowork-proxy/agent-capabilities.js
// =====================================================================
// M25 · Capability registry for the Compose orchestrator.
//
// Recipes ask for a CAPABILITY at each stage (e.g. "critique"). The
// orchestrator looks here to find the agent that owns that capability.
// This decouples recipes from named agents — adding a new agent that
// can critique just requires adding 'critique' to its capabilities;
// no recipe edits.
//
// Resolution order at run time (in compose-orchestrator.js):
//   1. agent_overrides[stage_name]   (per-run UI override)
//   2. CAPABILITY_REGISTRY → first match
//   3. throw (fail loudly per Q5)
//
// Single source of truth — keep in sync with each agent's SKILL.md
// `capabilities:` block.
// =====================================================================

const CAPABILITY_REGISTRY = {
  // Plan / strategy / outline
  pooya:     ['plan', 'research'],
  paya:      ['plan'],

  // Research / fact-grounding
  daneshyar: ['research'],   // KB-grounded; verifies facts against the KB

  // Drafting (long-form, master voice)
  sepehr:    ['draft'],

  // Critique / scoring
  kherad:    ['critique'],
  bidar:     ['critique', 'audit'],

  // Adversarial audit (escalation when critique flags red)
  davari:    ['audit'],

  // Translation
  goyesh:    ['translate'],

  // Channel-native adaptation (subject lines, length, hashtags, CTA placement)
  avang:     ['adapt'],

  // Visual / image generation. The image-cover renderer doesn't actually
  // call an LLM agent (it calls OpenAI gpt-image-1 directly), but we
  // register Afshin here so handoff_intent + future agent-mediated visual
  // briefs route through Afshin properly.
  afshin:    ['image'],
};

// Inverse index: capability → ordered agent list.
// First entry wins by default; recipes can pin to a specific agent
// by setting `default_agent` on the stage.
const _byCapability = {};
for (const [agent, caps] of Object.entries(CAPABILITY_REGISTRY)) {
  for (const c of caps) {
    if (!_byCapability[c]) _byCapability[c] = [];
    _byCapability[c].push(agent);
  }
}

const ALL_CAPABILITIES = Object.keys(_byCapability);

function agentsFor(capability) {
  return (_byCapability[capability] || []).slice();
}

function capabilitiesFor(agent) {
  return (CAPABILITY_REGISTRY[String(agent || '').toLowerCase()] || []).slice();
}

function hasCapability(agent, capability) {
  return capabilitiesFor(agent).includes(capability);
}

// Pick the agent for a stage: explicit override > recipe default > capability lookup.
// Throws (per Q5: fail loudly) if nothing resolves.
function resolveAgent({ capability, override, recipeDefault, stageName }) {
  if (override) {
    if (!CAPABILITY_REGISTRY[override]) {
      throw new Error(`Override agent "${override}" is not registered. Stage: ${stageName}`);
    }
    if (capability && !hasCapability(override, capability)) {
      throw new Error(`Override agent "${override}" lacks capability "${capability}". Stage: ${stageName}`);
    }
    return override;
  }
  if (recipeDefault) {
    if (!CAPABILITY_REGISTRY[recipeDefault]) {
      throw new Error(`Recipe default agent "${recipeDefault}" is not registered. Stage: ${stageName}`);
    }
    return recipeDefault;
  }
  if (!capability) {
    throw new Error(`Stage "${stageName}" has neither override, recipe default, nor capability — cannot resolve.`);
  }
  const candidates = agentsFor(capability);
  if (candidates.length === 0) {
    throw new Error(`No agent registered for capability "${capability}". Stage: ${stageName}. Update agent-capabilities.js.`);
  }
  return candidates[0];
}

module.exports = {
  CAPABILITY_REGISTRY,
  ALL_CAPABILITIES,
  agentsFor,
  capabilitiesFor,
  hasCapability,
  resolveAgent,
};
