// cowork-proxy/moallem-trainer.js
// =====================================================================
// M84 · Moallem (معلم) — team trainer agent.
//
// Watches the last 30 days of agent runs + ratings + refine attempts +
// critique fails, identifies repeating failure patterns, and produces
// training proposals. Founder reviews each proposal in the Trainer tab
// of the Agents section; approved proposals get applied as either a
// brand_intelligence rule or an agent_memory entry.
//
// Public surface:
//   listProposals({ status, agent, limit })  → array of rows
//   detectPatterns({ daysBack })             → calls Moallem LLM, writes
//                                              proposals to the table
//   approveProposal(id, { note })            → applies proposed_change
//                                              to the right destination
//   rejectProposal(id, { note })             → marks rejected, signature
//                                              dedup-blocks for 30 days
//   evaluateEffectiveness(id)                → re-measure 14d after apply
// =====================================================================

'use strict';

const crypto = require('crypto');
const { query, queryRows, queryValue, queryReturning, q, qJson } = require('./db');
const llm = require('./llm');
const agentMemory = require('./agent-memory');
const brandInt = require('./brand-intelligence');

// ── Helpers ───────────────────────────────────────────────────────────

function _signatureFor(targetAgent, patternSummary) {
  return crypto.createHash('sha1')
    .update(`${targetAgent}|${patternSummary.toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

// Has this exact pattern been rejected by founder in the last 30 days?
async function _isRecentlyRejected(signature) {
  const out = await queryValue(`
    SELECT 1 FROM training_proposals
     WHERE signature = ${q(signature)}
       AND founder_decision = 'rejected'
       AND decided_at >= NOW() - INTERVAL '30 days'
     LIMIT 1;`);
  return !!out;
}

// ── Reads ─────────────────────────────────────────────────────────────

async function listProposals({ status = 'pending', agent = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const conds = [];
  if (status) conds.push(`founder_decision = ${q(status)}`);
  if (agent)  conds.push(`target_agent = ${q(agent)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return await queryRows(`
    SELECT id::text, target_agent, pattern_summary, root_cause_hypothesis,
            evidence_run_ids, evidence_metric, proposed_action, proposed_change,
            confidence, founder_decision, decision_note,
            detected_at::text, decided_at::text, applied_at::text, applied_to,
            effectiveness_check_at::text, effectiveness_outcome, effectiveness_metric,
            signature
      FROM training_proposals ${where}
     ORDER BY detected_at DESC LIMIT ${lim};`);
}

async function getProposal(id) {
  const rows = await queryRows(`
    SELECT id::text, target_agent, pattern_summary, root_cause_hypothesis,
            evidence_run_ids, evidence_metric, proposed_action, proposed_change,
            confidence, founder_decision, decision_note,
            detected_at::text, decided_at::text, applied_at::text, applied_to,
            effectiveness_check_at::text, effectiveness_outcome, effectiveness_metric,
            signature
      FROM training_proposals WHERE id = ${q(id)} LIMIT 1;`);
  return rows[0] || null;
}

// ── Pattern detection ─────────────────────────────────────────────────

async function _gatherTeamData(daysBack = 30) {
  // Per-agent ratings rollup
  const ratingRollup = await queryRows(`
    SELECT agent,
           COUNT(*) FILTER (WHERE kind = 'rating')               AS n_ratings,
           AVG(score) FILTER (WHERE kind = 'rating')::float      AS avg_rating,
           COUNT(*) FILTER (WHERE kind = 'rating' AND score <= 2) AS low_count,
           COUNT(*) FILTER (WHERE kind = 'correction')           AS n_corrections
      FROM agent_evals
     WHERE created_at >= NOW() - INTERVAL '${daysBack} days'
     GROUP BY agent
     ORDER BY low_count DESC, n_ratings DESC;`);

  // Refine attempts in compose_runs (last N days)
  const refineRollup = await queryRows(`
    SELECT recipe_id,
           jsonb_array_length(refine_attempts) AS n_refines,
           refine_status,
           refine_attempts,
           id::text AS run_id
      FROM compose_runs
     WHERE created_at >= NOW() - INTERVAL '${daysBack} days'
       AND jsonb_array_length(COALESCE(refine_attempts, '[]'::jsonb)) > 0
     ORDER BY created_at DESC LIMIT 50;`);

  // Recent low-rated runs with notes (richer signal)
  const lowRated = await queryRows(`
    SELECT id::text, agent, score, dimension, note, run_id::text, created_at::text
      FROM agent_evals
     WHERE kind = 'rating' AND score <= 2
       AND created_at >= NOW() - INTERVAL '${daysBack} days'
     ORDER BY created_at DESC LIMIT 30;`);

  // Recent founder corrections
  const corrections = await queryRows(`
    SELECT id::text, agent, corrected_output, note, tags, run_id::text, created_at::text
      FROM agent_evals
     WHERE kind = 'correction'
       AND created_at >= NOW() - INTERVAL '${daysBack} days'
     ORDER BY created_at DESC LIMIT 30;`);

  // Already-rejected pattern signatures (so Moallem doesn't re-propose)
  const rejectedSigs = await queryRows(`
    SELECT signature FROM training_proposals
     WHERE founder_decision = 'rejected' AND signature IS NOT NULL
       AND decided_at >= NOW() - INTERVAL '30 days';`);

  return {
    rating_rollup: ratingRollup,
    refine_rollup: refineRollup,
    low_rated_runs: lowRated,
    corrections,
    rejected_signatures: rejectedSigs.map(r => r.signature),
  };
}

async function detectPatterns({ daysBack = 30 } = {}) {
  const data = await _gatherTeamData(daysBack);

  // Compose Moallem's user prompt
  const userPrompt = [
    `You are Moallem (معلم), the team trainer. Analyze the data below`,
    `and produce TRAINING_PROPOSAL JSON entries per your SKILL output schema.`,
    ``,
    `--- TEAM PERFORMANCE DATA (last ${daysBack} days) ---`,
    ``,
    `Per-agent rating rollup:`,
    JSON.stringify(data.rating_rollup, null, 2),
    ``,
    `Recent refine events (M69):`,
    JSON.stringify(data.refine_rollup, null, 2),
    ``,
    `Recent low-rated runs (founder rated ≤ 2):`,
    JSON.stringify(data.low_rated_runs, null, 2),
    ``,
    `Recent founder corrections:`,
    JSON.stringify(data.corrections, null, 2),
    ``,
    `Pattern signatures rejected in last 30 days (do NOT re-propose):`,
    JSON.stringify(data.rejected_signatures),
    ``,
    `Return JSON per your SKILL schema. proposals: [...]`,
  ].join('\n');

  // Load Moallem's SKILL + train.md as the system prompt
  let systemPrompt = '';
  try {
    const fs = require('fs');
    const path = require('path');
    const skill = fs.readFileSync(path.resolve(__dirname, '..', 'agents', 'moallem', 'SKILL.md'), 'utf8');
    const stagePrompt = fs.readFileSync(path.resolve(__dirname, '..', 'agents', 'moallem', 'stages', 'train.md'), 'utf8');
    systemPrompt = `# moallem's base brief\n${skill}\n\n# This stage: train\n${stagePrompt}`;
  } catch (e) {
    return { ok: false, error: 'failed to load Moallem prompt: ' + e.message };
  }

  // Run the LLM
  let parsed;
  try {
    const r = await llm.chat({
      model: process.env.MOALLEM_MODEL || 'claude-sonnet-4-5',
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 4000,
    });
    let body = String(r.output || '').trim();
    if (body.startsWith('```')) {
      const lines = body.split('\n');
      if (lines[0].startsWith('```')) lines.shift();
      if (lines[lines.length - 1].startsWith('```')) lines.pop();
      body = lines.join('\n');
    }
    parsed = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: 'Moallem LLM call failed: ' + e.message };
  }

  // Insert each proposal into training_proposals (skip duplicates by signature)
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  const inserted = [];
  for (const p of proposals) {
    const targetAgent = p.target_agent || 'unknown';
    const summary = p.pattern_summary || '(no summary)';
    const sig = _signatureFor(targetAgent, summary);
    if (await _isRecentlyRejected(sig)) {
      console.log(`[M84] skipping recently-rejected pattern: ${sig}`);
      continue;
    }
    try {
      const id = await queryReturning(`
        INSERT INTO training_proposals
          (target_agent, pattern_summary, root_cause_hypothesis,
            evidence_run_ids, evidence_metric, proposed_action, proposed_change,
            confidence, signature)
        VALUES (
          ${q(targetAgent)},
          ${q(summary)},
          ${q(p.root_cause_hypothesis || null)},
          ${p.evidence_run_ids && p.evidence_run_ids.length ? `ARRAY[${p.evidence_run_ids.map(x => q(x)).join(',')}]::uuid[]` : 'NULL'},
          ${qJson(p.evidence_metric || null)},
          ${q(p.proposed_action || 'add_procedural_memory')},
          ${qJson(p.proposed_change || {})},
          ${parseFloat(p.confidence) || 0.0},
          ${q(sig)}
        ) RETURNING id::text;`);
      inserted.push({ id, target_agent: targetAgent, pattern_summary: summary, confidence: p.confidence });
    } catch (e) {
      console.warn(`[M84] insert failed for "${summary.slice(0, 60)}":`, e.message);
    }
  }

  return {
    ok: true,
    n_examined: parsed.n_patterns_examined || 0,
    n_proposed: inserted.length,
    inserted,
    cost_usd: 0,        // billable to moallem agent_run row separately if we open one
  };
}

// ── Approve / Reject / Apply ──────────────────────────────────────────

async function approveProposal(id, { note = null, decidedBy = 'founder' } = {}) {
  const p = await getProposal(id);
  if (!p) return { ok: false, error: 'proposal not found' };
  if (p.founder_decision !== 'pending') return { ok: false, error: `already ${p.founder_decision}` };

  // Apply the proposed_change based on proposed_action
  let appliedTo = null;
  try {
    const change = typeof p.proposed_change === 'string' ? JSON.parse(p.proposed_change) : p.proposed_change;
    switch (p.proposed_action) {
      case 'add_brand_intelligence_rule': {
        const created = await brandInt.createIntelligence({
          kind: change.kind || 'voice_rule',
          target_agent: change.target_agent || p.target_agent,
          scope_platform: change.scope_platform || null,
          scope_language: change.scope_language || null,
          topic_tags: change.topic_tags || [],
          rule_text: change.rule_text,
          rule_data: change.rule_data || null,
          importance: change.importance || 5,
          source: 'moallem:M84',
          source_ref: id,
          founder_edited: true,
          founder_note: note || `approved Moallem proposal ${id.slice(0, 8)}`,
        });
        appliedTo = `brand_intelligence:${created.id}`;
        break;
      }
      case 'raise_rule_importance': {
        if (!change.rule_id) throw new Error('raise_rule_importance requires proposed_change.rule_id');
        await brandInt.updateIntelligence(change.rule_id, { importance: change.new_importance || 5, founder_edited: true });
        appliedTo = `brand_intelligence:${change.rule_id}`;
        break;
      }
      case 'add_procedural_memory': {
        const r = await agentMemory.write({
          agent: change.target_agent || p.target_agent,
          type: 'procedural',
          content: change.content || change.rule_text || p.pattern_summary,
          tags: ['moallem-suggested', ...(change.tags || [])],
          importance: change.importance || 4,
          source: 'moallem:M84',
        });
        appliedTo = r.ok ? `agent_memory:${r.id}` : null;
        break;
      }
      case 'update_skill_md':
      case 'update_stage_file': {
        // These require manual edits; we just mark applied so the founder
        // can track that the suggestion was acted on. The diff is in
        // proposed_change.suggested_text.
        appliedTo = `manual:${p.proposed_action}`;
        break;
      }
      default:
        throw new Error(`unknown proposed_action: ${p.proposed_action}`);
    }
  } catch (e) {
    return { ok: false, error: 'apply failed: ' + e.message };
  }

  await query(`
    UPDATE training_proposals
       SET founder_decision = 'approved',
           decision_note = ${q(note)},
           decided_at = NOW(),
           applied_at = NOW(),
           applied_to = ${q(appliedTo)}
     WHERE id = ${q(id)};`);

  return { ok: true, id, applied_to: appliedTo };
}

async function rejectProposal(id, { note = null } = {}) {
  const p = await getProposal(id);
  if (!p) return { ok: false, error: 'proposal not found' };
  if (p.founder_decision !== 'pending') return { ok: false, error: `already ${p.founder_decision}` };

  await query(`
    UPDATE training_proposals
       SET founder_decision = 'rejected',
           decision_note = ${q(note)},
           decided_at = NOW()
     WHERE id = ${q(id)};`);
  return { ok: true, id };
}

module.exports = {
  listProposals,
  getProposal,
  detectPatterns,
  approveProposal,
  rejectProposal,
};
