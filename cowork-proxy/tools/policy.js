// cowork-proxy/tools/policy.js
// =====================================================================
// P5 · Dynamic per-call policy evaluation.
//
// When (agent, tool) is in mode='policy', the runtime calls evaluate()
// to decide auto vs ask for THIS specific call. The decision is cached
// for an hour on (tool, op, arg-shape-hash) so repeated similar calls
// don't re-spend on Haiku evaluation.
//
// Evaluator: claude-haiku-3 — ~$0.0002 per call. Returns a tight JSON
// blob the runtime understands. If the API is unreachable or returns
// garbage, we default to 'ask' (fail safe).
// =====================================================================

const crypto = require('crypto');
const { psql, q } = require('./db');

const CACHE_TTL_MIN = 60;
const HAIKU_MODEL = 'claude-haiku-3-5-20251022';   // adjust to current haiku snapshot

// ── Cache helpers ──────────────────────────────────────────────────
function _cacheKey(agent, toolSlug, op, args) {
  // Hash the *shape* of args (keys + types), not values, so the same
  // kind of call benefits from cache regardless of payload.
  const shape = _argShape(args);
  const raw = `${agent}|${toolSlug}|${op}|${shape}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
function _argShape(args) {
  if (args == null) return 'null';
  if (typeof args !== 'object') return typeof args;
  if (Array.isArray(args)) return `[${args.length}]`;
  const keys = Object.keys(args).sort();
  return `{${keys.map(k => `${k}:${typeof args[k]}`).join(',')}}`;
}

async function _cacheGet(key) {
  try {
    const out = await psql(`SELECT row_to_json(c) FROM (
      SELECT decision, reason FROM tool_policy_cache
      WHERE cache_key = ${q(key)} AND expires_at > now()
    ) c;`);
    if (!out) return null;
    return JSON.parse(out);
  } catch (_) { return null; }
}
async function _cachePut(key, decision, reason) {
  try {
    await psql(`
      INSERT INTO tool_policy_cache (cache_key, decision, reason, expires_at)
      VALUES (${q(key)}, ${q(decision)}, ${q(reason || null)}, now() + interval '${CACHE_TTL_MIN} minutes')
      ON CONFLICT (cache_key) DO UPDATE SET
        hits = tool_policy_cache.hits + 1,
        decision = EXCLUDED.decision,
        reason = EXCLUDED.reason,
        expires_at = EXCLUDED.expires_at;
    `);
  } catch (_) { /* cache is best-effort */ }
}

// ── Haiku call ─────────────────────────────────────────────────────
async function _ask({ policyText, agent, tool, op, args, taskContext }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const opSpec = (tool.ops || []).find(o => o.name === op) || {};
  const sys = `You are a strict permission gate. Given a tool call about to happen, decide whether the founder's standing policy auto-approves it or whether it should pause for explicit human approval.

Output ONLY a single line of JSON: {"decision":"auto"|"ask","reason":"<≤80 chars>","confidence":0.0-1.0}
- decision="auto": low risk, clearly within policy.
- decision="ask": touches public surface (post / DM / comment), unclear, expensive, or any doubt.

Default to "ask" if the policy is ambiguous.`;

  const user = `POLICY:
${(policyText || tool.default_policy || '').slice(0, 1500)}

CALL:
agent=${agent}
tool=${tool.slug} (${tool.name})
op=${op} (${opSpec.write ? 'write' : 'read'})
op_description=${(opSpec.description || '').slice(0, 200)}
args_shape=${_argShape(args)}
task=${(taskContext || '').slice(0, 200)}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 100,
      temperature: 0,
      system: sys,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Haiku ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content && j.content[0] && j.content[0].text) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in Haiku response');
  const parsed = JSON.parse(m[0]);
  if (!['auto', 'ask'].includes(parsed.decision)) {
    parsed.decision = 'ask';
  }
  return parsed;
}

// ── Public ─────────────────────────────────────────────────────────
async function evaluate({ agent, tool, op, args, policyText, taskContext }) {
  // Trivial fast path: no policy text → fall back to op write/read default.
  if (!policyText && !tool.default_policy) {
    const opSpec = (tool.ops || []).find(o => o.name === op);
    const isWrite = opSpec ? !!opSpec.write : true;
    return { decision: isWrite ? 'ask' : 'auto', reason: 'no policy text', confidence: 0.5 };
  }

  // Cache lookup
  const key = _cacheKey(agent, tool.slug, op, args);
  const cached = await _cacheGet(key);
  if (cached) {
    return { decision: cached.decision, reason: cached.reason, confidence: 0.95, cached: true };
  }

  // Haiku call
  try {
    const r = await _ask({ policyText, agent, tool, op, args, taskContext });
    await _cachePut(key, r.decision, r.reason);
    return r;
  } catch (e) {
    // Fail-safe: ask.
    return { decision: 'ask', reason: 'evaluator_error: ' + (e.message || '').slice(0, 60), confidence: 0.3 };
  }
}

module.exports = { evaluate };
