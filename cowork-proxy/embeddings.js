// cowork-proxy/embeddings.js
// =====================================================================
// M106 · Embedding client for the Knowledge Base.
//
// Surface (every method returns { ok, ... } — never throws):
//   hasKey()                       → bool (OPENAI_API_KEY)
//   modelId()                      → 'text-embedding-3-small' (configurable)
//   dim()                          → 1536
//   embed(text)                    → { ok, vector, tokens, cost_usd }
//   embedBatch([text, text, ...])  → { ok, vectors, tokens, cost_usd }
//   toPgVectorLiteral(arr)         → "'[0.1,0.2,...]'" SQL literal
//
// Why text-embedding-3-small:
//   · 1536 dims · $0.00002 per 1k tokens (~$0.003 to embed 1000 KB rows)
//   · Strong multilingual quality (we have Persian + English)
//   · Same provider as OPENAI_API_KEY you already have set
//
// Override via env: EMBEDDING_MODEL_ID (defaults to 'text-embedding-3-small')
// =====================================================================

'use strict';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DIM = 1536;
const PRICE_PER_1K_TOKENS = 0.00002;   // text-embedding-3-small (May 2026)

const ENDPOINT = 'https://api.openai.com/v1/embeddings';
const MAX_TOKENS_PER_INPUT = 8000;     // model hard limit is 8191; we leave slack

function hasKey() { return !!process.env.OPENAI_API_KEY; }
function modelId() { return process.env.EMBEDDING_MODEL_ID || DEFAULT_MODEL; }
function dim() { return DIM; }

// Approximate token count from char length (cheap heuristic — exact tokenisation
// is not necessary for our slack-aware truncation).
function _approxTokens(text) { return Math.ceil((text || '').length / 4); }

function _truncate(text) {
  if (_approxTokens(text) <= MAX_TOKENS_PER_INPUT) return text;
  // Cut to ~MAX_TOKENS_PER_INPUT * 4 chars
  return String(text).slice(0, MAX_TOKENS_PER_INPUT * 4);
}

async function _request(inputs) {
  if (!hasKey()) return { ok: false, code: 'NO_KEY', error: 'OPENAI_API_KEY not set' };
  if (!Array.isArray(inputs) || !inputs.length) return { ok: false, code: 'BAD_INPUT', error: 'inputs[] required' };

  const body = JSON.stringify({
    model: modelId(),
    input: inputs.map(_truncate),
    encoding_format: 'float',
  });

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body,
    });
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: e.message };
  }

  let json = null; try { json = await r.json(); } catch (_) {}
  if (!r.ok) {
    const msg = (json && json.error && json.error.message) || r.statusText;
    return { ok: false, code: `HTTP_${r.status}`, error: msg, body: json };
  }

  const vectors = (json.data || []).map(d => d.embedding);
  const tokens  = (json.usage && json.usage.total_tokens) || 0;
  const cost    = (tokens / 1000) * PRICE_PER_1K_TOKENS;
  return { ok: true, vectors, tokens, cost_usd: cost, model: json.model || modelId() };
}

async function embed(text) {
  if (!text || !text.trim()) return { ok: false, code: 'BAD_INPUT', error: 'empty text' };
  const r = await _request([text]);
  if (!r.ok) return r;
  return { ok: true, vector: r.vectors[0], tokens: r.tokens, cost_usd: r.cost_usd, model: r.model };
}

async function embedBatch(texts) {
  if (!Array.isArray(texts) || !texts.length) return { ok: false, code: 'BAD_INPUT', error: 'texts[] required' };
  // OpenAI accepts up to 2048 inputs per request, but we keep batches small
  // so a single bad input doesn't blow up an entire 100-row backfill.
  const BATCH = 50;
  const allVectors = [];
  let totalTokens = 0;
  let totalCost = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const r = await _request(slice);
    if (!r.ok) return { ...r, partial_vectors: allVectors };   // pass partial so caller can persist what worked
    allVectors.push(...r.vectors);
    totalTokens += r.tokens;
    totalCost   += r.cost_usd;
  }
  return { ok: true, vectors: allVectors, tokens: totalTokens, cost_usd: totalCost, model: modelId() };
}

// Render a JS number array as a pgvector SQL literal.
// e.g. [0.1, 0.2] → "'[0.1,0.2]'::vector"
// Numbers are clamped to 6 sig figs to keep the string compact.
function toPgVectorLiteral(arr) {
  if (!Array.isArray(arr) || !arr.length) return 'NULL';
  const inner = arr.map(n => Number(n).toPrecision(6).replace(/0+e/, 'e').replace(/\.?0+$/, '')).join(',');
  return `'[${inner}]'::vector`;
}

// Build the text we embed for a KB row. Title + content carry most of the
// meaning; tags + structured facts add specificity. We deliberately do NOT
// include country/topic/subtopic because those are filter dimensions, not
// content — including them would homogenise vectors per-bucket.
function buildEmbedText({ title, content, facts, tags }) {
  const parts = [];
  if (title)   parts.push(title);
  if (content) parts.push(content);
  if (facts && typeof facts === 'object') {
    const ftxt = Object.entries(facts).map(([k,v]) => `${k}: ${v}`).join('; ');
    if (ftxt) parts.push(ftxt);
  }
  if (Array.isArray(tags) && tags.length) parts.push('tags: ' + tags.join(', '));
  return parts.join('\n').trim();
}

module.exports = {
  hasKey, modelId, dim,
  embed, embedBatch,
  toPgVectorLiteral, buildEmbedText,
  PRICE_PER_1K_TOKENS,
};
