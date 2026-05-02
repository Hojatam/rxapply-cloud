// cowork-proxy/compose-stages.js
// =====================================================================
// Per-step Compose orchestration. Replaces the old single compose-ig call
// with a chain of trained agents:
//
//   Pooya    research brief from topic (key facts, angle, audience pain)
//      ↓
//   compose-ig  brief + brand → 3 captions + design plan
//      ↓
//   Kherad   score the trio for brand compliance + voice + CTA + banned phrases
//      ↓
//   (Gate A approval)
//      ↓
//   Afshin   SVG draft using brand visuals  (already wired in afshin-router)
//
// Each stage:
//   • uses its per-agent LLM override (Settings → Per-agent LLM model)
//   • injects the brand profile (Settings → Brand profile)
//   • costs are reported back per stage so total cost is itemised
// =====================================================================

const agentModels = require('./agent-models');
const brandProfile = require('./brand-profile');
const KB = require('./knowledge-base');
const agentMemory = require('./agent-memory');
const handoffs = require('./agent-handoffs');

// ── Agent system prompts ──────────────────────────────────────────────
// Each agent is briefed in first-person by name. The brand block is
// appended at call time (not embedded here) so editing the profile in
// Settings propagates without any code edit.

const POOYA_SYSTEM = `You are Pooya — the Explorer agent for the RxApply brand.
Your job: given a single topic, produce a structured research brief that
downstream agents (compose-ig, afshin) will use to make the actual content.

You research lightly: cite real institutions and named exams, identify the
audience's specific pain point, and suggest a clear angle. You do NOT write
the post itself; that is compose-ig's job.

OUTPUT FORMAT — return ONLY this JSON, nothing else:
{
  "topic": "<echoed topic>",
  "audience_pain_point": "<one sentence — the specific frustration this post addresses>",
  "angle": "<one sentence — the perspective / hook the post should take>",
  "key_facts": [
    "<fact 1 with named institution / number / regulator>",
    "<fact 2>",
    "<...3 to 6 facts>"
  ],
  "regulatory_context": "<one sentence — relevant regulator (NDEB / ADC / GDC / DHA / ZAB / BC / etc.) or 'none' if not regulatory>",
  "hashtag_seeds": ["<topic-specific tag>", "<another>"],
  "source_notes": "<one or two sentences — what kind of sources back the facts (e.g. 'NDEB website + ADC handbook') — never invent URLs>",
  "handoff_intent": null
    /* Optional. If the topic genuinely needs another teammate's specialty BEFORE
       compose-ig writes captions, fill this with:
         { "to_agent": "<dadbeh|shahed|ramin|ravi>",
           "reason": "<why their specialty matters>",
           "suggested_action": "<what they'd do>" }
       Only emit this when truly needed — the founder reviews each handoff. */
}`;

const KHERAD_SYSTEM = `You are Kherad — the quality scorer (G2 gate) for RxApply.
Your job: rigorously score a trio of Instagram captions (en / fa / ar) against
4 rules, return per-language scores, and flag anything that violates the brand.

THE 4 RULES (each scored 0.00 to 1.00):
  1. brand_voice           — matches the voice rules in BRAND CONTEXT below
  2. specificity           — names real regulators / numbers / institutions; not generic
  3. cta_present           — has a soft CTA per the "always include" rules
  4. banned_phrases_clean  — 1.00 if zero bans, 0.00 if any "never include" phrase found

Also score citation_density (informational, not a rule): how many real
institutions are named per 100 words.

OUTPUT FORMAT — return ONLY this JSON, nothing else:
{
  "verdict": "pass" | "needs_refine",
  "verdict_reason": "<one sentence>",
  "languages": {
    "en": { "brand_voice": 0.00, "specificity": 0.00, "cta_present": 0.00, "banned_phrases_clean": 0.00, "citation_density": 0.00, "notes": "<short>" },
    "fa": { ... same shape },
    "ar": { ... same shape }
  },
  "overall_score": 0.00
}

A trio passes if every language has every rule >= 0.70 AND no banned phrase found.

You may include an optional "handoff_intent" field. Use it ONLY when a caption fails
and would benefit from another teammate (e.g. "to_agent": "goyesh", "reason": "FA caption
needs a translator pass"). Founder reviews each handoff. Otherwise omit or set to null.`;

// ── Generic Anthropic call ────────────────────────────────────────────
async function _callAnthropic(model, systemPrompt, userPrompt, maxTokens = 2000) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  const text = ((j.content || []).filter(c => c.type === 'text').map(c => c.text).join('')).trim();
  // Try to extract JSON. Strip ``` fences if any.
  let body = text;
  if (body.startsWith('```')) {
    const lines = body.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    body = lines.join('\n');
  }
  if (!body.startsWith('{')) {
    const i = body.indexOf('{');
    if (i >= 0) body = body.slice(i);
  }
  if (!body.endsWith('}')) {
    const j2 = body.lastIndexOf('}');
    if (j2 > 0) body = body.slice(0, j2 + 1);
  }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { throw new Error(`model returned non-JSON: ${e.message}; first 200 chars: ${text.slice(0, 200)}`); }

  const usage = j.usage || {};
  const cost = agentModels.calcCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
  return {
    parsed,
    model: j.model || model,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cost_usd: cost,
  };
}

// ── Stage runners ─────────────────────────────────────────────────────

async function runPooyaBrief(topic) {
  const { id: model } = agentModels.resolveModel('pooya');
  const brand = brandProfile.renderAsPromptBlock();
  const memory = agentMemory.renderAsBlock('pooya', {
    limit: 6,
    queryKeywords: String(topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5),
  });
  const detectedCountry = KB.detectCountry(topic);
  const kb = KB.renderAsBlock({ country: detectedCountry, query: topic, limit: 6 });
  const sys = [POOYA_SYSTEM, brand, kb, memory].filter(Boolean).join('\n\n');
  const usr = `Topic: ${topic}\n\nProduce the research brief JSON now.`;
  const r = await _callAnthropic(model, sys, usr, 1500);

  // Auto-write episodic memory so Pooya remembers this brief next time.
  try {
    agentMemory.write({
      agent: 'pooya', type: 'episodic',
      content: agentMemory.summarizeForEpisodic({
        agent: 'pooya', action: 'brief-from-topic',
        output: { summary: (r.parsed.angle || '').slice(0, 120) },
        costUsd: r.cost_usd, topic,
      }),
      tags: ['compose-pipeline', 'brief'],
      importance: 2, source: 'auto',
    });
  } catch (_) { /* non-fatal */ }

  // K4 · If Pooya emitted a handoff_intent, record it. The Inbox will surface
  // it for the founder; the compose flow continues without waiting.
  let handoff = null;
  const ho = handoffs.parseFromOutput(r.parsed, 'pooya');
  if (ho) {
    try {
      const rec = handoffs.record({
        fromAgent: 'pooya', toAgent: ho.to_agent,
        reason: ho.reason, suggestedAction: ho.suggested_action,
        payload: { topic, ...(ho.payload || {}) },
      });
      if (rec.ok) handoff = { id: rec.id, to_agent: ho.to_agent, reason: ho.reason };
    } catch (_) { /* non-fatal */ }
  }

  return { brief: r.parsed, model: r.model, input_tokens: r.input_tokens,
            output_tokens: r.output_tokens, cost_usd: r.cost_usd, handoff };
}

async function runKheradScore(languages) {
  const { id: model } = agentModels.resolveModel('kherad');
  const brand = brandProfile.renderAsPromptBlock();
  // Kherad's memory is mostly procedural ("how to score this brand"); pull
  // top semantic + procedural by importance.
  const memory = agentMemory.renderAsBlock('kherad', { limit: 6 });
  // K6 · KB grounding — Kherad cross-checks captions against verified facts.
  const captionText = [languages.en?.caption, languages.fa?.caption, languages.ar?.caption].filter(Boolean).join(' ');
  const detectedCountry = KB.detectCountry(captionText);
  const kb = KB.renderAsBlock({ country: detectedCountry, query: captionText, limit: 6 });
  const sys = [KHERAD_SYSTEM, brand, kb, memory].filter(Boolean).join('\n\n');
  const usr = `Score this trio of Instagram captions per the 4 rules.\n\n` +
              `EN caption:\n${languages.en?.caption || ''}\n\n` +
              `EN hashtags: ${(languages.en?.hashtags || []).join(' ')}\n\n` +
              `FA caption:\n${languages.fa?.caption || ''}\n\n` +
              `FA hashtags: ${(languages.fa?.hashtags || []).join(' ')}\n\n` +
              `AR caption:\n${languages.ar?.caption || ''}\n\n` +
              `AR hashtags: ${(languages.ar?.hashtags || []).join(' ')}\n\n` +
              `Return the scoring JSON now.`;
  const r = await _callAnthropic(model, sys, usr, 1500);

  try {
    agentMemory.write({
      agent: 'kherad', type: 'episodic',
      content: agentMemory.summarizeForEpisodic({
        agent: 'kherad', action: 'score-ig',
        output: { summary: `verdict=${r.parsed.verdict} overall=${r.parsed.overall_score}` },
        costUsd: r.cost_usd,
      }),
      tags: ['compose-pipeline', 'score'],
      importance: 2, source: 'auto',
    });
  } catch (_) { /* non-fatal */ }

  // K4 · handoff intent (Kherad may ask Goyesh to revise FA, etc.)
  let handoff = null;
  const ho = handoffs.parseFromOutput(r.parsed, 'kherad');
  if (ho) {
    try {
      const rec = handoffs.record({
        fromAgent: 'kherad', toAgent: ho.to_agent,
        reason: ho.reason, suggestedAction: ho.suggested_action,
        payload: ho.payload || null,
      });
      if (rec.ok) handoff = { id: rec.id, to_agent: ho.to_agent, reason: ho.reason };
    } catch (_) { /* non-fatal */ }
  }

  return { scores: r.parsed, model: r.model, input_tokens: r.input_tokens,
            output_tokens: r.output_tokens, cost_usd: r.cost_usd, handoff };
}

module.exports = { runPooyaBrief, runKheradScore };
