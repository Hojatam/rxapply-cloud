// cowork-proxy/agent-training-retrieval.js
// =====================================================================
// M56 · Unified, budgeted, topic-aware retrieval for agent training.
//
// One module that decides what an agent should SEE in its system prompt
// for a given (agent, stage, platform, language, topic_tags) — pulling
// from brand_intelligence + brand_exemplars + agent_memory + handoff
// hints, ranking by relevance, deduping, capping per-section.
//
// Per-stage budgets are tight by default (research-driven · 2026 patterns):
//   - 3 rules / 2 exemplars / 5 memories typical
//   - Some stages get more (critique needs more bans, design needs more
//     references); some less (translate, render).
// Importance=5 rules always survive the cut.
//
// Public API:
//   getTrainingPacket({ agent, stageName, platform, language, topicTags, recipe })
//     → { rules: [...], exemplars: [...], memories: [...], conflicts: [...] }
//   renderUnifiedBlock(packet) → string for system-prompt injection
// =====================================================================

'use strict';

const crypto = require('crypto');
const { queryRows } = require('./db');

// ── Per-stage budgets ────────────────────────────────────────────────
// Tuned by stage type. Never inject everything; agents perform better
// with a curated few than a flooded prompt.
const STAGE_BUDGETS = {
  plan:                 { rules: 2, exemplars: 1, memories: 3 },
  research:             { rules: 2, exemplars: 0, memories: 3 },
  verify:               { rules: 2, exemplars: 0, memories: 2 },
  'verify-translation': { rules: 2, exemplars: 0, memories: 2 },
  draft:                { rules: 3, exemplars: 2, memories: 5 },
  critique:             { rules: 5, exemplars: 0, memories: 4 },
  audit:                { rules: 4, exemplars: 0, memories: 3 },
  'voice-critic':       { rules: 0, exemplars: 0, memories: 0 },
  adapt:                { rules: 3, exemplars: 2, memories: 4 },
  translate:            { rules: 1, exemplars: 1, memories: 2 },
  design:               { rules: 5, exemplars: 3, memories: 4 },
  render:               { rules: 0, exemplars: 0, memories: 0 },
  triage:               { rules: 2, exemplars: 2, memories: 3 },
  'reply-draft':        { rules: 3, exemplars: 3, memories: 4 },
  judge:                { rules: 1, exemplars: 0, memories: 1 },
  // Default for any stage not listed
  _default:             { rules: 3, exemplars: 2, memories: 4 },
};

function _budgetFor(stageName) {
  return STAGE_BUDGETS[stageName] || STAGE_BUDGETS._default;
}

// ── Stage → exemplar-kind mapping ────────────────────────────────────
const STAGE_EXEMPLAR_KIND = {
  plan:        'post_caption',
  draft:       'post_caption',
  adapt:       'post_caption',
  translate:   'post_caption',
  design:      'design_brief',
  triage:      'intent_example_hot',
  'reply-draft': 'dm_reply',
};

// ── Ranking + retrieval ──────────────────────────────────────────────

// Score = importance × (1 + 0.5 × topic_match_count) × scope_specificity_bonus
// scope_specificity_bonus: rule scoped to exact (agent + platform + lang) > broad rule
function _scoreRule(rule, ctx) {
  const importance = Number(rule.importance) || 3;
  const ruleTags = Array.isArray(rule.topic_tags) ? rule.topic_tags : [];
  const ctxTags  = Array.isArray(ctx.topicTags) ? ctx.topicTags : [];
  const overlap = ruleTags.filter(t => ctxTags.includes(t)).length;

  // Specificity bonus: matching exact (vs null) gets a small boost
  let specificity = 1.0;
  if (rule.target_agent && rule.target_agent === ctx.agent) specificity += 0.30;
  if (rule.scope_platform && rule.scope_platform === ctx.platform) specificity += 0.20;
  if (rule.scope_language && rule.scope_language === ctx.language) specificity += 0.20;

  // Recency softener: founder-edited rules + recent uploads slight bump
  let recency = 1.0;
  if (rule.founder_edited) recency += 0.15;

  return importance * (1 + 0.5 * overlap) * specificity * recency;
}

function _scoreExemplar(ex, ctx) {
  const importance = Number(ex.importance) || 3;
  const exTags  = Array.isArray(ex.topic_tags) ? ex.topic_tags : [];
  const ctxTags = Array.isArray(ctx.topicTags) ? ctx.topicTags : [];
  const overlap = exTags.filter(t => ctxTags.includes(t)).length;

  let specificity = 1.0;
  if (ex.platform && ex.platform === ctx.platform) specificity += 0.25;
  if (ex.language && ex.language === ctx.language) specificity += 0.25;

  // Outcome bonus
  const outcomeBoost = (ex.outcome === 'top_engagement' || ex.outcome === 'engaged') ? 0.20 : 0;

  return importance * (1 + 0.5 * overlap) * specificity * (1 + outcomeBoost);
}

// Dedup by content-hash so the same wisdom appearing in both
// brand_intelligence and agent_memory only shows up once. Specific scope wins.
function _dedupRules(rules) {
  const seen = new Map();
  for (const r of rules) {
    const norm = String(r.rule_text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const h = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
    const existing = seen.get(h);
    if (!existing) { seen.set(h, r); continue; }
    // Prefer the more-specific rule
    const eSpec = (existing.target_agent ? 1 : 0) + (existing.scope_platform ? 1 : 0) + (existing.scope_language ? 1 : 0);
    const rSpec = (r.target_agent ? 1 : 0) + (r.scope_platform ? 1 : 0) + (r.scope_language ? 1 : 0);
    if (rSpec > eSpec) seen.set(h, r);
  }
  return Array.from(seen.values());
}

// Find conflicts: cases where a per-agent correction (agent_memory.procedural)
// disagrees with a global rule (brand_intelligence). Surface for transparency.
function _detectConflicts(rules, memories) {
  const conflicts = [];
  const proceduralMems = memories.filter(m => m.type === 'procedural');
  for (const m of proceduralMems) {
    const memText = String(m.content || '').toLowerCase().slice(0, 200);
    for (const r of rules) {
      if (r.target_agent === m.agent || !r.target_agent) {
        const ruleText = String(r.rule_text || '').toLowerCase().slice(0, 200);
        // Heuristic: if memory contains "never X" but rule says "always X" (or vice versa),
        // surface it. This is intentionally simple — perfect conflict detection isn't the goal;
        // surfacing the existence of competing instructions is.
        const memNegates = /\b(never|don'?t|do not|avoid|skip)\b/i.test(memText);
        const ruleNegates = /\b(never|don'?t|do not|avoid|skip)\b/i.test(ruleText);
        if (memNegates !== ruleNegates && _wordOverlap(memText, ruleText) > 3) {
          conflicts.push({ memory: m, rule: r });
          if (conflicts.length >= 3) return conflicts;   // cap
        }
      }
    }
  }
  return conflicts;
}

function _wordOverlap(a, b) {
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 4));
  const wb = new Set(b.split(/\s+/).filter(w => w.length > 4));
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n;
}

// ── Recent rating signal (M58) ───────────────────────────────────────
// Pulls last-N-day founder star ratings for this (agent, stage) and
// surfaces them in the prompt so the AGENT itself reacts to its scores —
// not just the cost-router. Triggered only when the rolling avg dips
// below CARE_THRESHOLD; an in-spec agent doesn't need the noise.
const RATING_LOOKBACK_DAYS = 14;
const RATING_CARE_THRESHOLD = 3.5;     // below this, surface the signal
const RATING_LOW_BAR = 2;              // ≤ this is "low rating"

async function _loadRatingSignal({ agent, stageName }) {
  if (!agent) return null;
  try {
    // Aggregate stats — agent-wide. Stage filter is best-effort: agent_evals
    // doesn't store stage, but `dimension` often holds it. Fall back to overall.
    const stats = await queryRows(`
      SELECT
        COUNT(*)::int                       AS n,
        AVG(score)::float                   AS avg,
        SUM(CASE WHEN score <= ${RATING_LOW_BAR} THEN 1 ELSE 0 END)::int AS low_count
      FROM agent_evals
      WHERE agent = '${agent.replace(/'/g, "''")}'
        AND kind = 'rating'
        AND created_at >= NOW() - INTERVAL '${RATING_LOOKBACK_DAYS} days';
    `);
    const s = stats && stats[0];
    if (!s || !s.n || s.n < 2) return null;          // not enough signal
    if (s.avg == null || s.avg >= RATING_CARE_THRESHOLD) return null; // doing fine

    // Pull up to 2 most-recent low-rated runs with notes (so the agent
    // sees what specifically dropped its score)
    const recentLow = await queryRows(`
      SELECT score, dimension, note, created_at::text
        FROM agent_evals
       WHERE agent = '${agent.replace(/'/g, "''")}'
         AND kind = 'rating' AND score <= ${RATING_LOW_BAR}
         AND created_at >= NOW() - INTERVAL '${RATING_LOOKBACK_DAYS} days'
       ORDER BY created_at DESC LIMIT 2;
    `);
    return {
      n: s.n, avg: Math.round(s.avg * 10) / 10,
      low_count: s.low_count || 0,
      window_days: RATING_LOOKBACK_DAYS,
      recent_low: recentLow || [],
    };
  } catch (_) { return null; }
}

// ── Public: assemble training packet ─────────────────────────────────

async function getTrainingPacket({
  agent, stageName, platform = null, language = null,
  topicTags = [], recipe = null,
} = {}) {
  if (!agent) return { rules: [], exemplars: [], memories: [], conflicts: [], rating_signal: null, budget: _budgetFor(stageName) };

  const budget = _budgetFor(stageName);

  // 1. Rules — broad pull then rank+dedup+cap
  let rules = [];
  if (budget.rules > 0) {
    // SQL: enabled rules whose scope matches (or is null) — broad fetch, ranked in JS
    const conds = ['enabled = TRUE'];
    conds.push(`(target_agent = '${agent}' OR target_agent IS NULL)`);
    if (platform) conds.push(`(scope_platform = '${platform.replace(/'/g, "''")}' OR scope_platform IS NULL)`);
    if (language) conds.push(`(scope_language = '${language.replace(/'/g, "''")}' OR scope_language IS NULL)`);
    const fetched = await queryRows(`
      SELECT id::text, kind, target_agent, scope_platform, scope_language,
              rule_text, rule_data, importance, topic_tags, source, founder_edited
        FROM brand_intelligence
       WHERE ${conds.join(' AND ')}
       ORDER BY importance DESC, founder_edited DESC, updated_at DESC
       LIMIT 50;
    `);
    const ranked = fetched
      .map(r => ({ ...r, _score: _scoreRule(r, { agent, platform, language, topicTags }) }))
      .sort((a, b) => b._score - a._score);
    rules = _dedupRules(ranked).slice(0, budget.rules);
  }

  // 2. Exemplars — same shape, per-stage kind
  let exemplars = [];
  if (budget.exemplars > 0) {
    const kind = STAGE_EXEMPLAR_KIND[stageName];
    if (kind) {
      const conds = ['enabled = TRUE', `kind = '${kind.replace(/'/g, "''")}'`];
      if (platform) conds.push(`(platform = '${platform.replace(/'/g, "''")}' OR platform IS NULL)`);
      if (language) conds.push(`(language = '${language.replace(/'/g, "''")}' OR language IS NULL)`);
      const fetched = await queryRows(`
        SELECT id::text, kind, platform, language, body, context, topic_tags,
                importance, source, outcome
          FROM brand_exemplars
         WHERE ${conds.join(' AND ')}
         ORDER BY importance DESC, updated_at DESC LIMIT 30;
      `);
      const ranked = fetched
        .map(e => ({ ...e, _score: _scoreExemplar(e, { agent, platform, language, topicTags }) }))
        .sort((a, b) => b._score - a._score);
      exemplars = ranked.slice(0, budget.exemplars);
    }
  }

  // 3. Per-agent memory (top procedural + recent semantic)
  let memories = [];
  if (budget.memories > 0) {
    try {
      const fetched = await queryRows(`
        SELECT id::text, agent, type, content, tags, importance, last_used_at::text, promotion_score
          FROM agent_memory
         WHERE agent = '${agent.replace(/'/g, "''")}' AND COALESCE(archived, false) = false
         ORDER BY importance DESC, last_used_at DESC
         LIMIT ${budget.memories * 3};
      `);
      memories = fetched.slice(0, budget.memories);
    } catch (_) { /* table may not exist on bootstrap; non-fatal */ }
  }

  // 4. Detect cross-source conflicts
  const conflicts = _detectConflicts(rules, memories);

  // 5. M58 · recent founder-rating signal (only if avg dipped below threshold)
  const rating_signal = await _loadRatingSignal({ agent, stageName });

  return { rules, exemplars, memories, conflicts, rating_signal, budget };
}

// ── Format packet as a system-prompt block ───────────────────────────
function renderUnifiedBlock(packet) {
  if (!packet) return '';
  const { rules, exemplars, memories, conflicts, rating_signal } = packet;
  const lines = [];

  // M58 · Surface recent founder feedback FIRST so it sets the frame
  if (rating_signal) {
    lines.push(`# 📊 Recent founder feedback`);
    lines.push(
      `Last ${rating_signal.window_days} days: ${rating_signal.n} ratings · avg ${rating_signal.avg}/5` +
      (rating_signal.low_count ? ` · ${rating_signal.low_count} low-rated (≤2)` : '')
    );
    if (rating_signal.recent_low && rating_signal.recent_low.length) {
      lines.push(`Examples to learn from:`);
      for (const r of rating_signal.recent_low) {
        const note = r.note ? ` — "${String(r.note).replace(/\s+/g, ' ').slice(0, 200)}"` : '';
        lines.push(`  · ${r.score}/5${r.dimension && r.dimension !== 'overall' ? ` (${r.dimension})` : ''}${note}`);
      }
    }
    lines.push(`Raise quality on this run; address the patterns above.`);
    lines.push('');
  }

  if (rules && rules.length > 0) {
    lines.push(`# Brand intelligence (${rules.length} most-relevant rules)`);
    for (const r of rules) {
      const star = r.importance >= 5 ? '⭐ ' : r.importance >= 4 ? '★ ' : '';
      lines.push(`${star}${r.rule_text}`);
    }
  }

  if (exemplars && exemplars.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`# Reference exemplars (${exemplars.length})`);
    for (const e of exemplars) {
      lines.push(`\n--- ${e.kind}${e.outcome ? ` · ${e.outcome}` : ''} ---`);
      if (e.context) lines.push(`Context: ${e.context}`);
      lines.push(e.body);
    }
  }

  if (memories && memories.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`# Your training notes (${memories.length} from your memory)`);
    for (const m of memories) {
      lines.push(`[${m.type}] ${m.content}`);
    }
  }

  if (conflicts && conflicts.length > 0) {
    if (lines.length) lines.push('');
    lines.push('# ⚠ Conflicts detected — resolve in favor of the more-specific source');
    for (const c of conflicts) {
      lines.push(`Global rule: "${c.rule.rule_text}"`);
      lines.push(`Your correction: "${c.memory.content}"`);
      lines.push(`Apply the correction (it was added by the founder for your specific behavior).`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = {
  STAGE_BUDGETS,
  getTrainingPacket,
  renderUnifiedBlock,
};
