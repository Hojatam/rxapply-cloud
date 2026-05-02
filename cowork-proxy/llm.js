// cowork-proxy/llm.js
// =====================================================================
// Provider-agnostic LLM facade.
//
// Callers ask for `model: 'claude-opus-4-7'` or `model: 'gpt-5.5'` and
// the dispatcher figures out which provider's module to use. Both
// providers expose the same shape:
//
//   chat({ model, system, messages, maxTokens })
//     → { output, model, usage }
//
//   streamChat({ model, system, messages, maxTokens, onText, onUsage,
//                onError, onDone })
//
// `usage` is normalised to { input_tokens, output_tokens } for both
// providers, so cost calc in agent-models.calcCost() works uniformly.
//
// This is the single point of provider-routing — server.js, the chat
// route, and any future agent runner all go through here.
// =====================================================================

const agentModels = require('./agent-models');

let _anthropic = null;
let _openai    = null;

// Lazy-load so a missing OpenAI key doesn't crash the proxy on boot —
// it only matters when an OpenAI model is actually selected.
function _getProvider(provider) {
  if (provider === 'openai') {
    if (!_openai) _openai = require('./openai-chat');
    return _openai;
  }
  // default: anthropic
  if (!_anthropic) _anthropic = require('./anthropic-chat');
  return _anthropic;
}

// One-shot chat — returns { output, model, usage }.
async function chat({ model, system, messages, maxTokens }) {
  const provider = agentModels.providerFor(model);
  const mod = _getProvider(provider);
  if (!mod.chat) {
    // anthropic-chat doesn't (yet) export a one-shot `chat()` — only
    // `streamChat`. Adapt by collecting the stream synchronously.
    return await _streamCollectAnthropic({ model, system, messages, maxTokens });
  }
  return await mod.chat({ model, system, messages, maxTokens });
}

// Streaming chat — same signature on both providers.
async function streamChat(opts) {
  const provider = agentModels.providerFor(opts.model);
  const mod = _getProvider(provider);

  // anthropic-chat.streamChat takes a different argument shape (legacy):
  // it expects { agent, userMessage, chatId } and builds the system
  // prompt itself. We don't want that for the new provider-agnostic
  // path. Anyone using the legacy path keeps calling
  // anthropic-chat.streamChat directly; this `llm.streamChat` is for
  // generic prompt → text usage.
  if (provider === 'openai') {
    return await mod.streamChat(opts);
  }

  // Anthropic generic streaming path (matches OpenAI's signature).
  return await _streamAnthropicGeneric(opts);
}

// Generic Anthropic streamer — same callback contract as openai-chat.
// Used when llm.streamChat() is called for an Anthropic model. The
// existing anthropic-chat.streamChat is for the agent-chat UX (it
// builds memory + brand + KB blocks itself); this one is bare-metal.
async function _streamAnthropicGeneric({ model, system, messages, maxTokens,
                                          onText, onUsage, onError, onDone }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { onError(new Error('ANTHROPIC_API_KEY not set')); return; }
  let fullText = '', usage = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 4096,
        system: system || undefined,
        messages: (messages || []).filter(m => m.role === 'user' || m.role === 'assistant'),
        stream: true,
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      onError(new Error(`Anthropic ${r.status}: ${errText.slice(0, 400)}`));
      return;
    }
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
        if (!json) continue;
        try {
          const evt = JSON.parse(json);
          if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
            fullText += evt.delta.text;
            onText(evt.delta.text);
          } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
            usage = {
              input_tokens:  evt.message.usage.input_tokens,
              output_tokens: evt.message.usage.output_tokens || 0,
            };
          } else if (evt.type === 'message_delta' && evt.usage) {
            usage = { ...(usage || {}), output_tokens: evt.usage.output_tokens };
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    onError(e); return;
  }
  if (usage) onUsage(usage);
  onDone({ fullText, usage, model });
}

// One-shot Anthropic via the streaming path (Anthropic doesn't expose
// a non-streaming endpoint that returns the same usage shape on the
// SDK we're already using).
async function _streamCollectAnthropic({ model, system, messages, maxTokens }) {
  return await new Promise((resolve, reject) => {
    let fullText = '', usage = null;
    _streamAnthropicGeneric({
      model, system, messages, maxTokens,
      onText: (t) => { fullText += t; },
      onUsage: (u) => { usage = u; },
      onError: (e) => reject(e),
      onDone:  ()  => resolve({ output: fullText, model, usage }),
    });
  });
}

module.exports = { chat, streamChat };
