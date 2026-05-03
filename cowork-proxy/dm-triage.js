// cowork-proxy/dm-triage.js
// =====================================================================
// M47 · Inbound DM triage + draft reply.
//
// Stage 1 (always): Bineh classifies the DM into one of:
//   curious | qualifying | hot | off-topic | complaint
//
// Stage 2 (auto, only on hot|qualifying): Mehrban drafts a reply in the
// detected source language. Founder reviews + approves before sending.
// =====================================================================

'use strict';

const { query, queryRows, queryValue, queryReturning, q, qJson } = require('./db');
const llm           = require('./llm');
const agentModels   = require('./agent-models');
const capabilities  = require('./agent-capabilities');
const brandProfile  = require('./brand-profile');
const KB            = require('./knowledge-base');
const logWriter     = require('./log-writer');

// ── Triage prompts ───────────────────────────────────────────────────

const TRIAGE_SYSTEM = `You are Bineh, the engagement-scorer for RxApply. You receive ONE inbound DM
and classify the sender's intent into exactly ONE of these buckets:

  • curious     — generic interest, asking broad questions ('is UK worth it?')
  • qualifying  — sender is comparing options, exploring fit, asking specifics
  • hot         — sender shows commitment signals: has a regulator number,
                  mentions exam dates, asks 'how do I sign up' / 'what's next',
                  wants pricing / logistics
  • off-topic   — not about dental migration; spam; unrelated
  • complaint   — sender is upset, raising an issue with our brand or product

Use the KB block in your system prompt for context — if the message mentions
NDEB / ORE / GDC / specific exams the KB knows about, that strengthens the
qualifying / hot classification. If KB doesn't know about it, treat as
curious / off-topic depending on intent.

Return ONLY this JSON:

{
  "status": "curious" | "qualifying" | "hot" | "off-topic" | "complaint",
  "confidence": 0.00,
  "reasoning": "<one sentence — what tipped you to this bucket>",
  "signals": ["<short bullet>", "..."],
  "language": "<detected ISO 639-1 code: en | fa | ar | ...>"
}

Be DECISIVE. confidence < 0.5 only when the message is too short / ambiguous to read.`;

const REPLY_DRAFT_SYSTEM = `You are Mehrban, the DM-reply drafter for RxApply. You receive a DM that's
been triaged as 'hot' or 'qualifying'. Draft a friendly, on-brand reply in the
SAME LANGUAGE as the DM.

Reply rules:
  • Match the DM's language (FA → FA, AR → AR, EN → EN). Do not switch.
  • One paragraph, 2-4 sentences. Long replies feel pushy.
  • Open with acknowledgment / warmth. Not 'Hello' — match the brand's tone.
  • Address the SPECIFIC question or signal in the DM. Don't generic-script.
  • Use ONLY information from the KB block in your system prompt. If the DM
    asks something not in the KB, say 'great question — let me get back to you
    with the specifics' and flag it for founder follow-up.
  • End with one soft next step: a question to clarify intent, or a 'happy to
    walk you through it' invitation. NEVER push a sale.
  • If the DM mentions regulators by name, reference them by full name.
  • Required disclaimer at the end (in source language): 'This is not legal
    advice; verify with the relevant regulator.'

Return ONLY this JSON:

{
  "draft": "<the reply text>",
  "language": "<echoed source language>",
  "kb_citations": ["<KB section/topic referenced, or empty []>"],
  "follow_up_needed": <bool>,
  "follow_up_reason": "<one sentence if follow_up_needed, else null>"
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

function _detectLang(text) {
  const s = String(text || '');
  if (/[پچژکگی]/.test(s)) return 'fa';
  if (/[؀-ۿ]/.test(s)) return 'ar';
  return 'en';
}

// ── Public API ───────────────────────────────────────────────────────

async function ingest({ source, sourceUser, sourceMessageId = null, body, language = null,
                        receivedAt = null, metadata = {} }) {
  if (!source || !body) throw new Error('source + body required');
  const lang = language || _detectLang(body);
  const id = await queryReturning(`
    INSERT INTO dm_inbox (source, source_user, source_message_id, language, body, received_at, metadata)
    VALUES (${q(source)}, ${q(sourceUser)}, ${q(sourceMessageId)}, ${q(lang)}, ${q(body)},
            ${receivedAt ? q(receivedAt) : 'NOW()'}, ${qJson(metadata || {})})
    ON CONFLICT (source, source_message_id) DO NOTHING
    RETURNING id::text;`);
  return { ok: true, id, language: lang };
}

async function triage(id, { autoDraftReply = true } = {}) {
  const rows = await queryRows(`
    SELECT id::text, source, source_user, language, body
      FROM dm_inbox WHERE id = ${q(id)} LIMIT 1;`);
  const dm = rows[0];
  if (!dm) throw new Error('DM not found');

  // Resolve agent + model for triage
  const agent = capabilities.resolveAgent({
    capability: 'triage', override: null, recipeDefault: null, stageName: 'triage',
  });
  const { id: model } = agentModels.resolveModel(agent);

  // Build system prompt: triage instructions + brand + KB (best-effort country detect)
  const blocks = [TRIAGE_SYSTEM];
  const brand = brandProfile.renderAsPromptBlock();
  if (brand) blocks.push(brand);
  try {
    const country = KB.detectCountry(dm.body);
    const kb = KB.renderAsBlock({ country, query: dm.body, limit: 6 });
    if (kb) blocks.push(kb);
  } catch (_) {}

  const userPrompt = [
    `Source: ${dm.source}`,
    dm.source_user ? `From: ${dm.source_user}` : '',
    `Detected language: ${dm.language}`,
    '',
    '--- DM ---',
    dm.body,
    '',
    'Return the triage JSON now.',
  ].filter(Boolean).join('\n');

  // Open agent_runs row
  const t0 = Date.now();
  let agentRunId = null;
  try {
    const lr = await logWriter.recordRunStart({
      agent, command: `dm-triage:${dm.source}`, args: [String(dm.body || '').slice(0, 100)],
    });
    agentRunId = lr.runId;
  } catch (_) {}

  let parsed, errMsg = null;
  let inputTokens = 0, outputTokens = 0;
  try {
    const r = await llm.chat({
      model, system: blocks.join('\n\n'),
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 500,
    });
    parsed = JSON.parse(_stripJsonFences(r.output));
    inputTokens  = (r.usage && r.usage.input_tokens) || 0;
    outputTokens = (r.usage && r.usage.output_tokens) || 0;
  } catch (e) { errMsg = e.message; }

  const costUsd = agentModels.calcCost(model, inputTokens, outputTokens);
  if (errMsg) {
    if (agentRunId) {
      try { await logWriter.recordRunEnd({ runId: agentRunId, agent, status: 'fail', error: errMsg, durationMs: Date.now() - t0, costUsd }); } catch (_) {}
    }
    throw new Error(`triage failed: ${errMsg}`);
  }
  if (agentRunId) {
    try { await logWriter.recordRunEnd({ runId: agentRunId, agent, status: 'success', parsedOutput: parsed, costUsd, durationMs: Date.now() - t0 }); } catch (_) {}
  }

  // Persist triage
  await query(`
    UPDATE dm_inbox
       SET triage_status = ${q(parsed.status)},
           triage_confidence = ${Number(parsed.confidence) || 0},
           triage_reasoning = ${q(parsed.reasoning)},
           triage_at = NOW(),
           triage_agent = ${q(agent)},
           triage_model = ${q(model)},
           triage_cost_usd = ${costUsd}
     WHERE id = ${q(id)};`);

  // Auto-draft reply for hot + qualifying
  let draft = null;
  if (autoDraftReply && (parsed.status === 'hot' || parsed.status === 'qualifying')) {
    try { draft = await draftReply(id); } catch (e) { /* non-fatal */ }
  }

  return { ok: true, dm_id: id, triage: parsed, cost_usd: costUsd, draft };
}

async function draftReply(id) {
  const rows = await queryRows(`
    SELECT id::text, source, source_user, language, body, triage_status
      FROM dm_inbox WHERE id = ${q(id)} LIMIT 1;`);
  const dm = rows[0];
  if (!dm) throw new Error('DM not found');

  const agent = capabilities.resolveAgent({
    capability: 'reply-draft', override: null, recipeDefault: null, stageName: 'reply-draft',
  });
  const { id: model } = agentModels.resolveModel(agent);

  const blocks = [REPLY_DRAFT_SYSTEM];
  const brand = brandProfile.renderAsPromptBlock();
  if (brand) blocks.push(brand);
  try {
    const country = KB.detectCountry(dm.body);
    const kb = KB.renderAsBlock({ country, query: dm.body, limit: 8 });
    if (kb) blocks.push(kb);
  } catch (_) {}

  const userPrompt = [
    `Source: ${dm.source}`,
    `Source language: ${dm.language}`,
    `Triaged as: ${dm.triage_status}`,
    '',
    '--- DM ---', dm.body,
    '',
    `Draft a reply in ${dm.language}. Return the JSON.`,
  ].join('\n');

  const t0 = Date.now();
  let agentRunId = null;
  try { const lr = await logWriter.recordRunStart({ agent, command: `dm-reply:${dm.source}`, args: [String(dm.body || '').slice(0, 100)] }); agentRunId = lr.runId; } catch (_) {}

  let parsed, errMsg = null, inputTokens = 0, outputTokens = 0;
  try {
    const r = await llm.chat({ model, system: blocks.join('\n\n'),
      messages: [{ role: 'user', content: userPrompt }], maxTokens: 800 });
    parsed = JSON.parse(_stripJsonFences(r.output));
    inputTokens = (r.usage && r.usage.input_tokens) || 0;
    outputTokens = (r.usage && r.usage.output_tokens) || 0;
  } catch (e) { errMsg = e.message; }

  const costUsd = agentModels.calcCost(model, inputTokens, outputTokens);
  if (errMsg) {
    if (agentRunId) { try { await logWriter.recordRunEnd({ runId: agentRunId, agent, status: 'fail', error: errMsg, durationMs: Date.now() - t0, costUsd }); } catch (_) {} }
    throw new Error(`reply-draft failed: ${errMsg}`);
  }
  if (agentRunId) { try { await logWriter.recordRunEnd({ runId: agentRunId, agent, status: 'success', parsedOutput: parsed, costUsd, durationMs: Date.now() - t0 }); } catch (_) {} }

  await query(`
    UPDATE dm_inbox
       SET draft_reply = ${q(parsed.draft)},
           draft_reply_at = NOW(),
           draft_reply_agent = ${q(agent)},
           draft_reply_model = ${q(model)}
     WHERE id = ${q(id)};`);
  return { ok: true, dm_id: id, draft: parsed, cost_usd: costUsd };
}

async function setFounderAction(id, { action, note = null }) {
  const valid = ['replied', 'archived', 'ignored', 'flagged'];
  if (!valid.includes(action)) throw new Error(`action must be one of: ${valid.join(', ')}`);
  await query(`
    UPDATE dm_inbox
       SET founder_action = ${q(action)}, founder_action_at = NOW(), founder_note = ${q(note)}
     WHERE id = ${q(id)};`);
  return { ok: true };
}

async function listInbox({ status = null, untriaged = false, source = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const conds = [];
  if (status)  conds.push(`triage_status = ${q(status)}`);
  if (untriaged) conds.push(`triage_status IS NULL`);
  if (source)  conds.push(`source = ${q(source)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return await queryRows(`
    SELECT id::text, source, source_user, language, body, received_at::text,
            triage_status, triage_confidence, triage_reasoning, triage_at::text,
            triage_agent, triage_model, triage_cost_usd,
            draft_reply, draft_reply_at::text, draft_reply_agent,
            founder_action, founder_action_at::text, founder_note
      FROM dm_inbox ${where}
      ORDER BY received_at DESC LIMIT ${limit};`);
}

async function counts() {
  const rows = await queryRows(`
    SELECT triage_status, COUNT(*)::int AS n
      FROM dm_inbox
     WHERE founder_action IS NULL
     GROUP BY triage_status;`);
  const out = { untriaged: 0, curious: 0, qualifying: 0, hot: 0, 'off-topic': 0, complaint: 0 };
  for (const r of rows) {
    if (r.triage_status == null) out.untriaged = r.n;
    else out[r.triage_status] = r.n;
  }
  return out;
}

module.exports = {
  ingest, triage, draftReply, setFounderAction, listInbox, counts,
};
