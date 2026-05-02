// cowork-proxy/anthropic-chat.js
// =====================================================================
// F5 · Agent chat — Anthropic API wrapper with streaming + persistence.
//
// Flow:
//   1. Dashboard POSTs /agent/:name/chat {message, chat_id?}.
//   2. Server reads SKILL.md, recent agent_runs, prior messages from
//      agent_chats (if chat_id), and constructs the request.
//   3. Calls Anthropic API with stream=true.
//   4. Streams text chunks to the dashboard as SSE.
//   5. On completion, appends user message + assistant response to
//      agent_chats.messages, updates total_tokens + total_cost.
//
// Cost model (Sonnet 4.5 prices as of Apr 2026):
//   Input  : $3 per 1M tokens  → $0.000003 per token
//   Output : $15 per 1M tokens → $0.000015 per token
// (User can override via env vars; cost is logged best-effort.)
// =====================================================================

const fs = require('fs');
const path = require('path');
const agentModels = require('./agent-models');
const agentMemory = require('./agent-memory');
const brandProfile = require('./brand-profile');
const KB = require('./knowledge-base');
const handoffs = require('./agent-handoffs');
const llm = require('./llm');     // M16 · provider-agnostic dispatcher
const { query, queryValue, queryReturning, q: _q, qJson: _qjson } = require('./db');

// Read at call time so a later .env change picks up after a proxy restart
// without leaving stale captured values around. Consistent with afshin-router.js.
const ANTHROPIC_KEY    = () => process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 4096;

const AGENTS_DIR   = path.resolve(__dirname, '..', 'agents');

function isConfigured() { return !!ANTHROPIC_KEY(); }

// ── Context assembly ─────────────────────────────────────────────────
function readSkill(agent) {
  const p = path.join(AGENTS_DIR, agent, 'SKILL.md');
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return null; }
}

async function recentRuns(agent, limit = 10) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY started_at DESC), '[]'::json)
    FROM (SELECT id::text AS id, started_at::text, status, duration_ms, output_payload
          FROM agent_runs WHERE agent = ${_q(agent)} ORDER BY started_at DESC LIMIT ${limit|0}) s;`;
  try { return JSON.parse(await queryValue(sql)); } catch (_) { return []; }
}

// ── Chat persistence ─────────────────────────────────────────────────
async function getChat(chatId) {
  if (!chatId) return null;
  const sql = `
    SELECT row_to_json(c) FROM (
      SELECT id::text, agent, title, started_at::text, last_msg_at::text,
             messages, total_tokens, total_cost
      FROM agent_chats WHERE id = ${_q(chatId)}
    ) c;`;
  try {
    const out = await queryValue(sql);
    return out ? JSON.parse(out) : null;
  } catch (_) { return null; }
}

async function listChats(agent, limit = 20) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY last_msg_at DESC), '[]'::json)
    FROM (SELECT id::text, title, started_at::text, last_msg_at::text,
                 jsonb_array_length(messages) AS msg_count, total_tokens, total_cost
          FROM agent_chats WHERE agent = ${_q(agent)} AND archived = false
          ORDER BY last_msg_at DESC LIMIT ${limit|0}) s;`;
  try { return JSON.parse(await queryValue(sql)); } catch (_) { return []; }
}

async function createChat(agent, title) {
  const sql = `
    INSERT INTO agent_chats (agent, title, messages, total_tokens, total_cost)
    VALUES (${_q(agent)}, ${_q(title)}, '[]'::jsonb, 0, 0)
    RETURNING id::text;`;
  try { return await queryReturning(sql); } catch (e) { throw new Error('createChat failed: ' + e.message); }
}

async function appendMessages(chatId, agent, newMessages, addedTokens, addedCostUsd) {
  const sql = `
    UPDATE agent_chats SET
      messages = messages || ${_qjson(newMessages)},
      last_msg_at = NOW(),
      total_tokens = total_tokens + ${addedTokens|0},
      total_cost   = total_cost   + ${Number.isFinite(addedCostUsd) ? addedCostUsd : 0}
    WHERE id = ${_q(chatId)};`;
  try { await query(sql); } catch (e) { /* best effort */ console.warn('[anthropic-chat] appendMessages failed:', e.message); }
}

// ── Streaming the call ───────────────────────────────────────────────
/**
 * streamChat({ agent, userMessage, chatId, onText, onUsage, onError, onDone })
 *
 *   onText(token: string)           — called for each delta_text event
 *   onUsage(usage)                  — called once with { input_tokens, output_tokens }
 *   onError(err)                    — called on any failure
 *   onDone(meta)                    — called on stream end with { fullText, chatId }
 *
 * Builds the system prompt from SKILL.md + recent runs, sends prior chat messages,
 * then streams the assistant response. On clean completion, persists messages.
 */
async function streamChat({ agent, userMessage, chatId = null, onText, onUsage, onError, onDone }) {
  if (!isConfigured()) { onError(new Error('ANTHROPIC_API_KEY not set in .env')); return; }
  if (!agent || !userMessage) { onError(new Error('agent + message required')); return; }

  // Build context. Run the four async pulls concurrently — they don't
  // depend on each other.
  const skill = readSkill(agent) || `(no SKILL.md found for ${agent})`;
  const queryKeywords = String(userMessage || '').split(/\s+/)
    .filter(w => w.length >= 4).slice(0, 8);
  const detectedCountry = KB.detectCountry(userMessage);
  const [runs, memoryBlock, kbBlock] = await Promise.all([
    recentRuns(agent, 10),
    agentMemory.renderAsBlock(agent, { limit: 8, queryKeywords }),
    KB.renderAsBlock({ country: detectedCountry, query: userMessage, limit: 6 }),
  ]);
  const runsCompact = runs.slice(0, 10).map(r => ({
    id: r.id, started_at: r.started_at, status: r.status, duration_ms: r.duration_ms,
    output: r.output_payload && (typeof r.output_payload === 'object'
      ? JSON.stringify(r.output_payload).slice(0, 300) : String(r.output_payload).slice(0, 300)),
  }));
  // brand-profile.renderAsPromptBlock stays sync (cache-backed).
  const brandBlock = brandProfile.renderAsPromptBlock();

  const systemPrompt = [
    `You are ${agent}, an agent in the RxApply local test stack.`,
    `Your skill spec follows. Adopt the tone and constraints described.`,
    `---`,
    skill,
    `---`,
    brandBlock,
    kbBlock || '(knowledge base has no entries yet for this query)',
    memoryBlock || '(no prior memory yet — this is a clean slate)',
    `---`,
    `Recent invocations of ${agent} (newest first), for context only — do not invent runs:`,
    JSON.stringify(runsCompact, null, 2),
    `---`,
    `When asked about your own work, refer to the runs and your MEMORY above. Be honest about limits.`,
    `Memory rules of thumb: prefer FACTS over guesses; apply RULES & CORRECTIONS strictly; reference RECENT INTERACTIONS naturally where relevant.`,
    `Local test phase: NO autonomous external action. Output is for review by the founder.`,
  ].filter(Boolean).join('\n\n');

  // Prior messages (if continuing a chat).
  let chat = chatId ? await getChat(chatId) : null;
  if (chatId && !chat) { onError(new Error('chat_id not found')); return; }

  const priorMsgs = chat ? (Array.isArray(chat.messages) ? chat.messages : []) : [];
  const apiMessages = [
    ...priorMsgs.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  // Resolve which model to use for THIS agent. Per-agent overrides take
  // priority. The dispatcher (llm.js) routes to Anthropic or OpenAI
  // based on the resolved model's `provider` field — both providers
  // give us the same { fullText, usage } shape via streaming.
  const { id: chatModel, info: chatModelInfo } = agentModels.resolveModel(agent);

  let fullText = '', usage = null, streamErrored = false;
  await llm.streamChat({
    model: chatModel,
    system: systemPrompt,
    messages: apiMessages,
    maxTokens: ANTHROPIC_MAX_TOKENS,
    onText:  (t) => { fullText += t; onText(t); },
    onUsage: (u) => { usage = u; },
    onError: (e) => { streamErrored = true; onError(e); },
    onDone:  ({ usage: finalUsage }) => { if (finalUsage) usage = finalUsage; },
  });
  if (streamErrored) return;

  if (usage) onUsage(usage);

  // Persist. Use the resolved model's actual rates for cost (Opus is 5×
  // Sonnet, etc — using a hardcoded rate would silently underbill Opus).
  const inputTokens  = (usage && usage.input_tokens)  || 0;
  const outputTokens = (usage && usage.output_tokens) || 0;
  const costUsd = agentModels.calcCost(chatModel, inputTokens, outputTokens);

  let resolvedChatId = chatId;
  try {
    if (!resolvedChatId) {
      const title = userMessage.slice(0, 80);
      resolvedChatId = await createChat(agent, title);
    }
    await appendMessages(resolvedChatId, agent,
      [
        { role: 'user',      content: userMessage,   ts: new Date().toISOString() },
        { role: 'assistant', content: fullText,      ts: new Date().toISOString(), tokens: outputTokens },
      ],
      inputTokens + outputTokens, costUsd);
  } catch (e) {
    console.warn('[anthropic-chat] persistence failed:', e.message);
  }

  // K4 · Detect a handoff request in the chat reply. Format the agent should
  // use: a JSON snippet anywhere in the response like
  //   ```handoff
  //   { "to_agent": "dadbeh", "reason": "this is regulatory" }
  //   ```
  // We parse fenced code blocks with language "handoff" or "handoff-json".
  try {
    const fenceMatch = /```(?:handoff(?:-json)?)\s*\n([\s\S]*?)\n```/i.exec(fullText);
    if (fenceMatch) {
      let ho = null;
      try { ho = JSON.parse(fenceMatch[1]); } catch (_) {}
      const parsed = ho && handoffs.parseFromOutput({ handoff_intent: ho }, agent);
      if (parsed) {
        await handoffs.record({
          fromAgent: agent, toAgent: parsed.to_agent,
          reason: parsed.reason, suggestedAction: parsed.suggested_action,
          payload: parsed.payload, sourceChatId: resolvedChatId,
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  // K2 · Auto-write an episodic memory. Short. Cheap. Skipped on errors.
  // The agent will see this on the NEXT chat as part of its memory block.
  try {
    const episodic = agentMemory.summarizeForEpisodic({
      agent, action: 'chat',
      output: { summary: fullText.slice(0, 200) },
      durationMs: null, costUsd,
      topic: userMessage.slice(0, 80),
    });
    await agentMemory.write({
      agent, type: 'episodic', content: episodic,
      tags: ['chat'], importance: 2, source: 'auto',
    });
  } catch (_) { /* non-fatal */ }

  onDone({ fullText, chatId: resolvedChatId, usage, costUsd, model: chatModel });
}

module.exports = { isConfigured, streamChat, listChats, getChat };
