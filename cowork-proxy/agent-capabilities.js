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
  // M119 · Pooya gains 'kb-dossier' — a cheap-LLM synthesis pass that turns
  // 20 raw KB.recall hits into a structured topic pack { key_facts, must_avoid,
  // named_sources_used, regulatory_context, kb_entry_ids_used }. Replaces the
  // legacy 'research' role for the IG-v2 pipeline.
  pooya:     ['plan', 'research', 'kb-dossier'],
  paya:      ['plan'],

  // KB-grounded fact verification + multilingual back-translation QA (M41).
  // 'verify' runs in master phase (post-critique). 'verify-translation' runs
  // in target-lang phase (post-translate, pre-render-target) and cross-checks
  // each translation against the master + the KB-derived protected-terms glossary.
  // M119 · Adds 'verify-kb' — KB-only structured per-claim fact check used by
  // the IG-v2 pipeline. Premium model only (NEVER_AUTO_PICK in cost router).
  daneshyar: ['verify', 'verify-translation', 'research', 'verify-kb'],

  // Drafting (long-form, master voice)
  // M119 · Sepehr gains 'post-plan' — a cheap-LLM, channel-ready combined
  // draft+adapt+structure step for IG-v2 ({caption, hashtags, emojis_used,
  // slides[]}). Voice/format rules baked into the stage prompt.
  sepehr:    ['draft', 'post-plan'],

  // Critique / scoring — kherad is SOLE owner (M98 dedup).
  // Bidar previously declared 'critique' as backup; removed because
  // first-match-wins meant we never used Bidar for critique anyway.
  // Bidar now focuses on his specialty: judge + voice-critic.
  kherad:    ['critique'],
  bidar:     ['judge', 'voice-critic'],   // M43 · pairwise eval judge · M50 · voice fingerprint critic

  // Adversarial audit (escalation when critique flags red)
  // M98 · davari is SOLE owner (audit removed from bidar — was first-match
  // ambiguity). Bidar's strengths are pairwise judging + voice-fingerprint
  // critique, not red-team adversarial audit.
  davari:    ['audit'],

  // Translation
  goyesh:    ['translate'],

  // Channel-native adaptation (subject lines, length, hashtags, CTA placement)
  avang:     ['adapt'],

  // M60 · Tarrah (طرّاح) — carousel slide planner. Owns the
  // 'carousel-plan' capability: turns research+caption into a structured
  // slot-spec JSON that Afshin renders. Tarrah does not draw; Afshin draws.
  tarrah:    ['carousel-plan'],

  // M84 · Moallem (معلم, "teacher") — meta-trainer. Watches the team's
  // recent runs, identifies failure patterns, and produces TRAINING
  // PROPOSALS for the founder to approve. Never auto-applies changes.
  // Runs weekly on a cron OR on-demand from the dashboard.
  moallem:   ['train'],

  // M47 · DM triage + reply drafting
  bineh:     ['triage'],         // Inbound-DM intent classification
  mehrban:   ['reply-draft'],    // Drafts a reply for hot/qualifying DMs

  // Afshin owns visual direction. The 'design' capability is a real LLM
  // stage where Afshin reads the brand profile + topic + Avang's brief,
  // then returns an art-directed prompt with style/composition/palette/
  // mood/brand-visual refs. The 'image' capability is bookkeeping for
  // the renderer that hands his prompt to gpt-image-1.
  // M119 · 'design-v2' restores Afshin's creative authority for IG-v2:
  // chooses one of 8 named templates per slide, generates 1-3 Unsplash
  // candidate queries when a real photo helps, composes the FULL gpt-image-2
  // prompt with text/font/size/color codes/logo placement/pattern. Premium model.
  afshin:    ['design', 'design-v2', 'image'],

  // Channel-shaped final formatting (HTML email, Telegram-HTML, X tweet
  // split, Gmail payload, etc.). Render stages don't call an LLM but we
  // attribute them to Payvand so they show up in his Train tab and the
  // founder can rate format quality over time.
  // M103 · 'canva-render' is compose Mode B — instead of producing a
  // gpt-image-2 PNG, autofill a Canva brand template per slide and
  // return editable design URLs. Owned by Payvand because it's still
  // a render-stage in spirit (no new LLM call beyond Tarrah's plan).
  payvand:   ['render', 'canva-render'],
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
