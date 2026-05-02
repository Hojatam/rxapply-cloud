// cowork-proxy/openai-chat.js
// =====================================================================
// OpenAI chat-completions wrapper · mirrors anthropic-chat.js so the
// dispatcher in `llm.js` can treat both providers uniformly.
//
// Public API:
//   isConfigured() → bool
//   chat({ model, system, messages, maxTokens })
//     → { output, model, usage }     (one-shot, non-streaming)
//   streamChat({ model, system, messages, maxTokens, onText, onUsage,
//                onError, onDone })
//     → streams text deltas via onText, then onDone({ fullText, usage })
//
// OpenAI's request shape differs from Anthropic's:
//   - `system` is an entry in messages (role: 'system'), not a top-level field
//   - Streaming uses SSE with `data: {…json…}\n\n` events
//   - `usage` is reported on the final chunk via stream_options
//
// Cost calc and per-agent model resolution stay in agent-models.js.
// =====================================================================

const OPENAI_KEY = () => process.env.OPENAI_API_KEY || '';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS, 10) || 4096;

function isConfigured() { return !!OPENAI_KEY(); }

// Convert {system, messages: [{role: 'user'|'assistant', content}]} into
// OpenAI's flat messages array (system as first entry).
function _packMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of (messages || [])) {
    if (!m || !m.role || m.content == null) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// One-shot non-streaming call. Used by `runLLM` in server.js for
// /run-agent and /run-agents-parallel — same shape as Anthropic's
// `runClaude` so the dispatcher can swap providers without callers
// noticing.
async function chat({ model, system, messages, maxTokens }) {
  if (!isConfigured()) {
    throw new Error('OPENAI_API_KEY not set');
  }
  const body = {
    model,
    max_completion_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: _packMessages({ system, messages }),
  };
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${OPENAI_KEY()}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    const err = new Error(`OpenAI ${r.status}: ${errText.slice(0, 400)}`);
    err.code = r.status;
    throw err;
  }
  const j = await r.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return {
    output: text,
    model,
    usage: j.usage ? {
      input_tokens:  j.usage.prompt_tokens || 0,
      output_tokens: j.usage.completion_tokens || 0,
    } : null,
  };
}

// Streaming chat. Same callback contract as anthropic-chat.streamChat
// so the chat endpoint in server.js can dispatch by provider without
// duplicating the SSE parsing.
async function streamChat({ model, system, messages, maxTokens,
                            onText, onUsage, onError, onDone }) {
  if (!isConfigured()) { onError(new Error('OPENAI_API_KEY not set')); return; }

  let fullText = '', usage = null;
  try {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${OPENAI_KEY()}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens || DEFAULT_MAX_TOKENS,
        messages: _packMessages({ system, messages }),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      onError(new Error(`OpenAI ${r.status}: ${errText.slice(0, 500)}`));
      return;
    }

    // Parse SSE stream. Each event: `data: {…json…}\n\n`. The very last
    // event before [DONE] carries the `usage` field when stream_options
    // include_usage: true.
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const json = dataLine.slice(6).trim();
        if (!json || json === '[DONE]') continue;
        try {
          const evt = JSON.parse(json);
          // Text deltas live in choices[0].delta.content
          const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
          if (delta && typeof delta.content === 'string') {
            fullText += delta.content;
            onText(delta.content);
          }
          // Final chunk carries usage when include_usage is set.
          if (evt.usage) {
            usage = {
              input_tokens:  evt.usage.prompt_tokens || 0,
              output_tokens: evt.usage.completion_tokens || 0,
            };
          }
        } catch (_) { /* ignore parse errors on partial events */ }
      }
    }
  } catch (e) {
    onError(e); return;
  }

  if (usage) onUsage(usage);
  onDone({ fullText, usage, model });
}

module.exports = { isConfigured, chat, streamChat };
