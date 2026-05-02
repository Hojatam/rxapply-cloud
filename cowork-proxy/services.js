// cowork-proxy/services.js
// =====================================================================
// Service Health probes (cloud build · M18).
//
// Replaces the legacy F3 docker-shell-out (which started/stopped local
// supabase / n8n / mailhog containers — useless on Railway). Now it's
// a panel of read-only health checks the founder can glance at to know
// the live deploy is healthy.
//
// Probes:
//   1. database     — pg pool ping, returns latency in ms.
//   2. storage      — round-trips a tiny object through R2 (or local
//                     fallback). Reports backend in use.
//   3. anthropic    — fast 5-token call to claude-haiku to confirm
//                     ANTHROPIC_API_KEY is valid + the API is reachable.
//                     Costs <$0.0001 per probe.
//   4. openai       — 5-token call to gpt-5.4 (cheaper than 5.5 for
//                     pings). Skipped if OPENAI_API_KEY is not set.
//   5. process      — Node memory + uptime. Always green; cosmetic.
//
// Each probe is bounded by a 5-second timeout so a stalled provider
// doesn't make the whole panel hang. Probes run concurrently.
//
// Public API:
//   probeAll() → { generated_at, services: { name: { ok, ... } } }
//   probe(name) → single probe result
//
// The legacy `action()` (start/stop/restart) is GONE. The /services/:name/:action
// route in server.js now returns 410 Gone with an explanatory message.
// =====================================================================

const db = require('./db');
const storage = require('./storage');

const PROBE_TIMEOUT_MS = 5_000;

function _withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)),
  ]);
}

// ── 1. Database ─────────────────────────────────────────────────────
async function probeDatabase() {
  const t0 = Date.now();
  try {
    const r = await _withTimeout(db.ping(), 'db.ping');
    if (!r.ok) throw new Error(r.error || 'ping failed');
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message.slice(0, 200) };
  }
}

// ── 2. Storage ──────────────────────────────────────────────────────
async function probeStorage() {
  const t0 = Date.now();
  const probeKey = `_health/probe-${Date.now()}`;
  try {
    await _withTimeout(
      storage.put({ key: probeKey, body: Buffer.from('ok'), contentType: 'text/plain' }),
      'storage.put');
    const got = await _withTimeout(storage.get(probeKey), 'storage.get');
    storage.remove(probeKey).catch(() => {});  // fire-and-forget cleanup
    const verified = got.body.toString('utf-8') === 'ok';
    return { ok: verified, latency_ms: Date.now() - t0, backend: storage.BACKEND };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, backend: storage.BACKEND, error: e.message.slice(0, 200) };
  }
}

// ── 3. Anthropic ────────────────────────────────────────────────────
async function probeAnthropic() {
  const t0 = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, latency_ms: 0, error: 'ANTHROPIC_API_KEY not set' };
  try {
    const r = await _withTimeout(
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',     // cheap probe; matches default
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }),
      'anthropic.fetch');
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, latency_ms: Date.now() - t0, status: r.status, error: t.slice(0, 200) };
    }
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message.slice(0, 200) };
  }
}

// ── 4. OpenAI ───────────────────────────────────────────────────────
async function probeOpenAI() {
  const t0 = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: null, latency_ms: 0, note: 'OPENAI_API_KEY not set (skipped)' };
  try {
    const r = await _withTimeout(
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-5.4',
          max_completion_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }),
      'openai.fetch');
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, latency_ms: Date.now() - t0, status: r.status, error: t.slice(0, 200) };
    }
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message.slice(0, 200) };
  }
}

// ── 5. Node process ─────────────────────────────────────────────────
function probeProcess() {
  const m = process.memoryUsage();
  return {
    ok: true,
    uptime_sec:   Math.round(process.uptime()),
    memory_rss_mb:    Math.round(m.rss / 1024 / 1024),
    memory_heap_mb:   Math.round(m.heapUsed / 1024 / 1024),
    node_version: process.version,
    pid: process.pid,
  };
}

// ── Public API ──────────────────────────────────────────────────────
async function probeAll() {
  const [database, storageR, anthropic, openai] = await Promise.all([
    probeDatabase(), probeStorage(), probeAnthropic(), probeOpenAI(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    services: {
      database,
      storage: storageR,
      anthropic,
      openai,
      process: probeProcess(),
    },
  };
}

async function probe(name) {
  switch (name) {
    case 'database':  return await probeDatabase();
    case 'storage':   return await probeStorage();
    case 'anthropic': return await probeAnthropic();
    case 'openai':    return await probeOpenAI();
    case 'process':   return probeProcess();
    default: return { ok: false, error: `unknown service: ${name}` };
  }
}

module.exports = { probeAll, probe };
