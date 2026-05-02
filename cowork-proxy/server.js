// cowork-proxy / server.js
// Bridge between n8n / dashboard / chat → Claude Code, agent helpers, and SKILL.md edits.
//
// Endpoints:
//   GET  /health                    → liveness probe
//   POST /run-agent                 → {agent, prompt, model?} → runs `claude --print`
//   POST /run-agents-parallel       → {agents:[…]} → Promise.allSettled fan-out
//   POST /run-helper                → {agent, command, args?} → runs python agents/<agent>/<agent>.py
//   GET  /prompts/:agent            → returns SKILL.md as text
//   PUT  /prompts/:agent            → {markdown} → overwrites SKILL.md
//   GET  /agents                    → lists agent folders we know about
//
// Started by: `node server.js` (or `npm start`)
// Default port: 7777 (override with PORT env var)

// Load .env from the project root (one level up from cowork-proxy/).
// override:true ensures the .env values WIN over any inherited shell env.
// Without override, an empty ANTHROPIC_API_KEY in the shell leaks into the
// proxy and silently breaks every Anthropic call.
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env'),
  override: true,
});

const express = require('express');
const { spawn } = require('child_process');     // spawnSync gone in cloud build (no docker-shell-outs)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');                          // T0 · pg client (cloud build)
const storage = require('./storage');                // T0 · object storage (R2 / local fallback)
const logWriter = require('./log-writer');           // F2 · L2 logs
const auth = require('./auth');                       // F7 · session auth
const promptVersions = require('./prompt-versions');  // F7 · SKILL.md history
const services = require('./services');               // F3 · service control
const n8nCtl = require('./n8n-control');               // F4 · n8n workflow control
const anthropicChat = require('./anthropic-chat');     // F5 · agent chat
const cost = require('./cost');                        // F9 · cost telemetry + cap
const afshin   = require('./afshin-router');            // F8 · design pipeline
const pipelineRunner = require('./pipeline-runner');  // F6 · visual pipeline editor
const agentModels = require('./agent-models');         // per-agent LLM overrides
const brandProfile = require('./brand-profile');       // central brand spec
const composeStages = require('./compose-stages');     // Pooya brief + Kherad score
const permissions = require('./permissions');          // K1 · approval matrix + Inbox queue
const renderers = require('./output-renderers');       // K1 · narrative output formatters
const agentMemory = require('./agent-memory');         // K2 · per-agent persistent memory
const agentEvals = require('./agent-evals');           // K3 · ratings + corrections + examples
const handoffs = require('./agent-handoffs');          // K4 · agent-to-agent handoff requests
const KB = require('./knowledge-base');                // K6 · knowledge base
const daneshyar = require('./daneshyar-router');       // K6 · Daneshyar parse/verify/find-more
const toolsRouter   = require('./tools/router');       // T1 · tools framework REST surface
const toolsRegistry = require('./tools/registry');     // T1 · static tool catalog
const toolsRuntime  = require('./tools/runtime');      // T1 · executes per-call gating + cost
const migrate       = require('./migrate');            // T0 · migration runner (used by /setup + boot)

const app = express();

// Behind Railway's reverse proxy: req.ip should reflect the client, not
// the proxy. One hop is enough — Railway terminates TLS in front of us.
// Also enables rate-limit IP fingerprinting to work correctly.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(express.json({ limit: '30mb' }));  // 30mb so base64-encoded uploads (≈22mb files) fit
// Accept text/markdown and text/plain as raw bytes; we decode UTF-8 explicitly in the handler.
// (express.text default charset can mis-decode multibyte UTF-8 like em-dashes / Farsi / Arabic.)
app.use(express.raw({ limit: '5mb', type: ['text/markdown', 'text/plain'] }));

// ── CORS for dashboard.html opened via file:// or http://localhost ───────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const MODE = process.env.PROXY_MODE || 'cowork';
const LOG = path.join(__dirname, 'proxy.log');
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

// Allow-list of safe agent names to prevent path traversal in /run-helper and /prompts/:agent
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* ignore log-write failures */ }
}

// ── helpers ─────────────────────────────────────────────────────────────────
// Map shorthand model aliases (legacy `claude` CLI accepts these) to real
// Anthropic model IDs. Anything else is passed through unchanged.
const MODEL_ALIASES = {
  sonnet:  'claude-sonnet-4-5-20250929',
  opus:    'claude-opus-4-7',
  haiku:   'claude-haiku-4-5-20251001',
};

// runClaude — drop-in replacement for the old `claude --print` subprocess.
// Direct Anthropic API call. Same input/output shape so existing callers
// (/run-agent, /run-agents-parallel) work without changes.
//
// Returns: { output, model, usage } on success
// Rejects:  { code, error } on failure (error string for legacy compatibility)
async function runClaude({ prompt, model = 'sonnet' }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Promise.reject({ code: -1, error: 'ANTHROPIC_API_KEY not set' });
  }
  const resolvedModel = MODEL_ALIASES[model] || model;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 4096,
        messages: [{ role: 'user', content: String(prompt || '') }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return Promise.reject({ code: r.status, error: `Anthropic ${r.status}: ${errText.slice(0, 400)}` });
    }
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    return { output: text, model: resolvedModel, usage: j.usage || null };
  } catch (e) {
    return Promise.reject({ code: -1, error: (e && e.message) || String(e) });
  }
}

// Spawn `python agents/<agent>/<agent>.py <command> [args...]`. Captures stdout/stderr.
function runHelper({ agent, command = 'help', args = [], stdin = null, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    if (!AGENT_NAME_RE.test(agent)) {
      return reject({ code: -1, error: `invalid agent name: ${agent}` });
    }
    const helperPath = path.join(AGENTS_DIR, agent, `${agent}.py`);
    if (!fs.existsSync(helperPath)) {
      return reject({ code: -1, error: `helper not found: ${helperPath}` });
    }
    if (!Array.isArray(args)) args = [];
    const argv = [helperPath, command, ...args.map(String)];
    // Force UTF-8 stdio on Windows — without this, Python defaults to cp1252
    // and crashes when an agent prints non-ASCII (≥, →, Farsi, Arabic, em-dashes).
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    // cwd = agent's own folder so relative file references (e.g. ravi-email.md)
    // resolve correctly. Without this, Python opens files relative to the
    // proxy's cwd (cowork-proxy/) and fails with FileNotFoundError.
    const cwd = path.join(AGENTS_DIR, agent);
    const child = spawn(PYTHON_BIN, argv, { shell: false, env, cwd });
    let out = '', err = '';
    if (stdin != null) {
      child.stdin.write(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    let timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject({ code: -1, error: `helper timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString('utf-8'); });
    child.stderr.on('data', d => { err += d.toString('utf-8'); });
    child.on('error', e => { clearTimeout(timer); reject({ code: -1, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ output: out, stderr: err, exitCode: code });
      else reject({ code, error: err || `helper exited with code ${code}`, output: out });
    });
  });
}

// ── First-run state ─────────────────────────────────────────────────────────
// Cached so the middleware below stays sync (Express requires it). Refreshed
// on boot and after the wizard finishes. Default behaviour: if the column
// is missing or unreadable, treat as DONE so we never block the dashboard
// on a transient DB hiccup.

let _firstRunCache = { done: true, stamp: 0 };
const FIRST_RUN_TTL_MS = 30_000;

async function _refreshFirstRun() {
  try {
    const raw = await db.queryValue(`SELECT first_run_done FROM dashboard_settings WHERE id = 1;`);
    _firstRunCache = { done: raw === 'true', stamp: Date.now() };
  } catch (_) {
    // Column might not exist yet (very early in a fresh deploy, before
    // migrations run). Default to "done" so /setup doesn't loop on itself.
    _firstRunCache = { done: true, stamp: Date.now() };
  }
}

function _isFirstRunDone() {
  if (Date.now() - _firstRunCache.stamp > FIRST_RUN_TTL_MS) {
    _refreshFirstRun().catch(() => {});
  }
  return _firstRunCache.done;
}

// Routes that are reachable BEFORE the wizard finishes. Anything else
// gets redirected to /setup. Order matters; the most-specific prefixes
// come first.
const SETUP_ALLOWLIST = new Set([
  '/health', '/config.js',
  '/setup', '/setup/',
  '/static',                 // sprite + drawflow vendor
  '/storage',                // local-fallback object reads
  '/auth/status', '/auth/set-password', '/auth/login', '/auth/logout',
]);

function _isSetupAllowed(url) {
  if (url === '/' || url === '/dashboard') return false;       // → redirect
  for (const prefix of SETUP_ALLOWLIST) {
    if (url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?')) {
      return true;
    }
  }
  // The setup wizard's own API surface lives under /setup/*.
  return url.startsWith('/setup/');
}

// First-run middleware. Mounted before all other routes.
function firstRunGate(req, res, next) {
  if (_isFirstRunDone()) return next();
  if (_isSetupAllowed(req.path)) return next();
  // For HTML navigations, redirect. For API calls, return 503 so the
  // dashboard can show a "setup not finished" banner.
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml) {
    res.redirect(302, '/setup');
  } else {
    res.status(503).json({ ok: false, error: 'setup_required', wizard_url: '/setup' });
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

// First-run gate. Redirects non-allowlisted requests to /setup until the
// wizard finishes. Mount BEFORE any handler that should be gated.
app.use(firstRunGate);

// CSRF gate. Skips GET/HEAD/OPTIONS, dev-mode (AUTH_DISABLED), and the
// bootstrap window before the founder password is set. State-changing
// requests (POST/PATCH/DELETE) must include X-CSRF-Token matching the
// session's CSRF token (returned at login time).
app.use(auth.csrfMiddleware);

// ── /setup · wizard surface ──────────────────────────────────────────
// The full wizard UI ships in Track 2 as part of dashboard.html. For
// now /setup serves a one-page placeholder that lets the founder finish
// the boot sequence enough to use the dashboard. The /setup/api/*
// routes are the JSON layer the wizard talks to.

app.get('/setup', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'setup.html'));
});

// /setup/api/* — JSON layer the wizard UI talks to.
app.get('/setup/api/state', async (_req, res) => {
  try {
    const raw = await db.queryValue(`SELECT row_to_json(s) FROM (
      SELECT first_run_done, setup_progress, founder_email, totp_secret IS NOT NULL AS totp_set
      FROM dashboard_settings WHERE id = 1
    ) s;`);
    res.json({ ok: true, state: raw ? JSON.parse(raw) : { first_run_done: false } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/setup/api/progress', async (req, res) => {
  try {
    await db.query(`UPDATE dashboard_settings
                       SET setup_progress = ${db.q(JSON.stringify(req.body || {}))}::jsonb,
                           updated_at = NOW()
                     WHERE id = 1;`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/setup/api/finish', async (_req, res) => {
  try {
    await db.query(`UPDATE dashboard_settings
                       SET first_run_done = true, updated_at = NOW()
                     WHERE id = 1;`);
    await _refreshFirstRun();
    log('setup.finish');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Validate an Anthropic API key by making a 5-token call. Used by the
// wizard's "Test key" button before the founder commits to it.
app.post('/setup/api/test-anthropic', async (req, res) => {
  const { api_key } = req.body || {};
  if (!api_key || typeof api_key !== 'string') return res.status(400).json({ ok: false, error: 'api_key required' });
  if (!/^sk-ant-/.test(api_key)) return res.status(400).json({ ok: false, error: 'looks malformed (expected sk-ant-…)' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(400).json({ ok: false, error: `Anthropic ${r.status}: ${errText.slice(0, 200)}` });
    }
    const j = await r.json();
    res.json({ ok: true, usage: j.usage || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DB status — applied + pending migrations.
app.get('/setup/api/db-status', async (_req, res) => {
  try {
    const s = await migrate.status();
    res.json({ ok: true, applied: s.applied.length, pending: s.pending.length, total: s.total, pending_list: s.pending });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Apply pending migrations (idempotent).
app.post('/setup/api/migrate', async (_req, res) => {
  try {
    const r = await migrate.apply({ log: () => {} });
    res.json({ ok: !r.failed, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sprite upload (5×5 team sprite) — saved to storage at static/team/team.jpg.
// Auto-detects extension from upload; everything is normalised to JPEG via
// the front-end (PNG is fine too — just larger). 5MB cap.
app.post('/setup/api/sprite-upload', async (req, res) => {
  const { content_b64, ext } = req.body || {};
  if (!content_b64) return res.status(400).json({ ok: false, error: 'content_b64 required' });
  const safeExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'jpg';
  const buf = Buffer.from(content_b64, 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'sprite too large (max 5MB)' });
  try {
    // Sprite lives at a fixed key — the dashboard CSS references team.jpg.
    await storage.put({
      key: `team/team.${safeExt}`,
      body: buf,
      contentType: `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
    });
    res.json({ ok: true, bytes: buf.length, url: storage.urlFor(`team/team.${safeExt}`) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message.slice(0, 300) });
  }
});

// Manual reset (debug / re-run wizard).
app.post('/setup/api/reset', auth.middleware, async (_req, res) => {
  try {
    await db.query(`UPDATE dashboard_settings
                       SET first_run_done = false, setup_progress = '{}'::jsonb,
                           updated_at = NOW()
                     WHERE id = 1;`);
    await _refreshFirstRun();
    log('setup.reset');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /config.js · runtime configuration injected into dashboard.html.
// Replaces the previously-hardcoded SUPABASE_URL/KEY/etc. so the HTML
// never holds secrets at rest. The dashboard reads window.RX_* at boot.
//
// All values come from process.env (Railway env-var dashboard or local .env).
// SUPABASE_ANON_KEY is intentionally the *anon* key (publishable / row-level-
// security gated), never the service-role key. The service-role key stays
// server-side and is only used by the proxy itself.
app.get('/config.js', (_, res) => {
  const cfg = {
    RX_PROXY_URL:        process.env.PROXY_PUBLIC_URL || `http://localhost:${process.env.PORT || 7777}`,
    RX_SUPABASE_URL:     process.env.SUPABASE_URL || '',
    RX_SUPABASE_ANON_KEY:process.env.SUPABASE_ANON_KEY || '',
    RX_N8N_URL:          process.env.N8N_URL || '',
    RX_MAILHOG_URL:      process.env.MAILHOG_UI || '',
  };
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  // Browser-side: assigns each key onto window for the dashboard to read.
  const lines = Object.entries(cfg).map(([k, v]) =>
    `window[${JSON.stringify(k)}]=${JSON.stringify(v)};`).join('');
  res.send(lines);
});

app.get('/health', (_, res) => res.json({
  ok: true,
  mode: MODE,
  llmTransport: 'anthropic-api-direct',         // cloud build no longer shells out to `claude`
  pythonBin: PYTHON_BIN,
  agentsDir: AGENTS_DIR,
  agentsDirExists: fs.existsSync(AGENTS_DIR),
  features: {
    logsL2: true,                    // F2
    auth: auth.isInitialized(),      // F7 (true once password set)
    promptVersioning: true,          // F7
    services: true,                  // F3
    n8nControl: n8nCtl.isAuthConfigured(),  // F4 (true once N8N_API_KEY in env)
    chat: anthropicChat.isConfigured(),  // F5 (true once ANTHROPIC_API_KEY set)
    afshin: { draft: afshin.hasAnthropic(), render: afshin.hasOpenAI() },  // F8
    pipelines: true,                 // F6 (visual pipeline editor)
    cost: true,                      // F9
  },
  routes: ['/health', '/run-agent', '/run-agents-parallel', '/run-helper',
           '/prompts/:agent (GET, PUT)', '/prompts/:agent/versions',
           '/prompts/:agent/rollback', '/agents',
           '/logs', '/logs/:runid', '/logs/:runid/download',
           '/auth/login', '/auth/logout', '/auth/status', '/auth/set-password',
           '/settings (GET, PATCH)'],
}));

// POST /run-agent — runs claude --print with the given prompt
app.post('/run-agent', async (req, res) => {
  const { agent, prompt, model = 'sonnet' } = req.body || {};
  if (!agent || !prompt) {
    return res.status(400).json({ error: 'agent + prompt required' });
  }
  log(`run-agent agent=${agent} model=${model} prompt-len=${prompt.length}`);
  try {
    const { output } = await runClaude({ prompt, model });
    res.json({ ok: true, agent, output, model });
  } catch (e) {
    log(`FAIL agent=${agent} code=${e.code} err=${(e.error || '').slice(0, 200)}`);
    res.status(500).json({ ok: false, agent, error: e.error, code: e.code });
  }
});

// POST /run-agents-parallel — fan out to multiple Claude calls
app.post('/run-agents-parallel', async (req, res) => {
  const { agents } = req.body || {};
  if (!Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents array required' });
  }
  log(`run-agents-parallel count=${agents.length}`);
  const results = await Promise.allSettled(
    agents.map(a => runClaude({ prompt: a.prompt, model: a.model || 'sonnet' })
      .then(({ output }) => ({ agent: a.agent, output, ok: true }))
      .catch(e => ({ agent: a.agent, error: e.error, code: e.code, ok: false }))
    )
  );
  res.json({
    ok: true,
    results: results.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, ok: false })
  });
});

// POST /run-helper — runs python agents/<agent>/<agent>.py <command> [args]
//   {agent, command, args?, stdin?}
//   stdin can be a string or any JSON-serializable value (will be JSON.stringified)
//
// F2: every invocation is wrapped by log-writer — agent_runs row created
// at start with status='running', updated at end with full I/O payloads
// and cost. Raw stdout/stderr written to logs/YYYY-MM-DD/.
app.post('/run-helper', async (req, res) => {
  const { agent, command = 'help', args = [], stdin = null } = req.body || {};
  if (!agent) return res.status(400).json({ error: 'agent required' });
  if (!AGENT_NAME_RE.test(agent)) {
    return res.status(400).json({ error: 'invalid agent name (a-z, 0-9, _, -; max 40 chars)' });
  }
  log(`run-helper agent=${agent} command=${command} args=${JSON.stringify(args)}`);

  // K1 · permission gate. The matrix is keyed by (agent, command). If the
  // call comes from a cron-style trigger (n8n simulated-cron), we still
  // honour the matrix — that's the whole point: the founder set these
  // permissions to be respected regardless of who's pulling the trigger.
  const mode = permissions.getMode(agent, command);
  if (mode === 'blocked') {
    return res.status(403).json({ ok: false, error: `${agent}:${command} is blocked in the permission matrix` });
  }
  if (mode === 'ask') {
    // De-duplicate "Run X run …" → "Run X …" when the helper command IS the
    // literal word "run" (a cron-style helper convention). Otherwise keep
    // the action verb so the founder sees it.
    const verbPart = (String(command).toLowerCase() === 'run') ? '' : ' ' + command;
    const argPart = args.length ? ' ' + args.join(' ') : '';
    const queued = await permissions.queue({
      agent, action: command,
      payload: { kind: 'run-helper', command, args, stdin },
      preview: `Run ${agent}${verbPart}${argPart}`.trim(),
      estimatedCostUsd: null,
      triggeredBy: req.body && req.body._trigger || 'founder',
    });
    return res.status(202).json({ ok: true, queued: true, inbox_id: queued.id, mode: 'ask' });
  }

  // F2 — open a log run.
  let runState = null;
  const inputPayload = { command, args, started_at: new Date().toISOString() };
  try {
    runState = await logWriter.recordRunStart({ agent, command, args, stdin });
  } catch (e) {
    log(`log-writer recordRunStart failed (non-fatal): ${(e.message || '').slice(0, 200)}`);
  }

  const t0 = Date.now();
  try {
    const { output, stderr, exitCode } = await runHelper({ agent, command, args, stdin });
    const durationMs = Date.now() - t0;
    if (runState) {
      try {
        await logWriter.recordRunEnd({
          runId: runState.runId, agent, status: 'success',
          output, stderr, exitCode, durationMs,
          paths: runState, inputPayload,
        });
      } catch (e) { log(`recordRunEnd failed: ${(e.message || '').slice(0, 200)}`); }
    }
    res.json({ ok: true, agent, command, output, stderr, exitCode, runId: runState?.runId, durationMs });
  } catch (e) {
    const durationMs = Date.now() - t0;
    if (runState) {
      try {
        await logWriter.recordRunEnd({
          runId: runState.runId, agent, status: 'fail',
          output: e.output || '', stderr: e.error || '',
          exitCode: e.code, durationMs, error: e.error,
          paths: runState, inputPayload,
        });
      } catch (_) {}
    }
    log(`FAIL run-helper agent=${agent} code=${e.code} err=${(e.error || '').slice(0, 200)}`);
    res.status(500).json({ ok: false, agent, command,
      error: e.error, code: e.code, output: e.output || '', runId: runState?.runId, durationMs });
  }
});

// ── F2 · Logs L2 routes ─────────────────────────────────────────────────
// GET /logs?agent=&status=&limit=&offset=  → list of runs (joined with action counts)
// GET /logs/:runid                         → full bundle for one run
// GET /logs/:runid/download                → same bundle as a downloadable JSON
const RUNID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.get('/logs', async (req, res) => {
  try {
    const runs = await logWriter.listRuns({
      agent: req.query.agent || null,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    const action = (r) => {
      const ip = r.input_payload || {};
      return ip.command || ip.action || 'run';
    };
    const enriched = runs.map(r => {
      let narrative = '';
      try { narrative = renderers.render(r.agent, action(r), r.output_payload || {}, { run_id: r.id }); }
      catch (_) { /* leave blank */ }
      return { ...r, narrative };
    });
    res.json({ ok: true, count: enriched.length, runs: enriched });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/logs/:runid', async (req, res) => {
  const runId = req.params.runid;
  if (!RUNID_RE.test(runId)) return res.status(400).json({ error: 'invalid runid (uuid expected)' });
  const bundle = await logWriter.loadRunBundle(runId);
  if (bundle.error) return res.status(404).json(bundle);
  res.json({ ok: true, ...bundle });
});

app.get('/logs/:runid/download', async (req, res) => {
  const runId = req.params.runid;
  if (!RUNID_RE.test(runId)) return res.status(400).json({ error: 'invalid runid (uuid expected)' });
  const bundle = await logWriter.loadRunBundle(runId);
  if (bundle.error) return res.status(404).json(bundle);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${bundle.run.agent}-${runId.slice(0,8)}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

// GET /prompts/:agent — returns SKILL.md
app.get('/prompts/:agent', (req, res) => {
  const { agent } = req.params;
  if (!AGENT_NAME_RE.test(agent)) {
    return res.status(400).json({ error: 'invalid agent name' });
  }
  const skillPath = path.join(AGENTS_DIR, agent, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return res.status(404).json({ error: 'SKILL.md not found', path: skillPath });
  }
  fs.readFile(skillPath, 'utf-8', (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      ok: true, agent, path: skillPath, markdown: data,
      chars: data.length,
      bytes: Buffer.byteLength(data, 'utf-8'),
    });
  });
});

// PUT /prompts/:agent — body either {markdown:"...", reason?:"..."} JSON or raw text/markdown body
// F7: gated by auth.middleware once password is initialized; auto-records to prompt_versions.
app.put('/prompts/:agent', auth.middleware, async (req, res) => {
  const { agent } = req.params;
  if (!AGENT_NAME_RE.test(agent)) {
    return res.status(400).json({ error: 'invalid agent name' });
  }
  let markdown, reason = null;
  if (Buffer.isBuffer(req.body)) {
    markdown = req.body.toString('utf-8');
  } else if (typeof req.body === 'string') {
    markdown = req.body;
  } else if (req.body && typeof req.body.markdown === 'string') {
    markdown = req.body.markdown;
    reason = (req.body.reason || null);
  } else {
    return res.status(400).json({ error: 'send {markdown:"..."} or raw text/markdown body' });
  }
  if (!markdown.trim().startsWith('---')) {
    return res.status(400).json({
      error: 'SKILL.md must start with YAML frontmatter (---)',
      hint: 'frontmatter must contain at least: name + description'
    });
  }
  try {
    const r = await promptVersions.saveAndVersion(agent, markdown, {
      editedBy: 'founder',
      reason,
    });
    if (!r.ok) return res.status(500).json({ error: r.error });
    const utf8Bytes = Buffer.byteLength(markdown, 'utf-8');
    log(`prompts.put agent=${agent} version=${r.version} chars=${markdown.length} bytes=${utf8Bytes}`);
    res.json({ ok: true, agent, version: r.version, chars: markdown.length, bytes: utf8Bytes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /prompts/:agent/versions — list version history (header rows only, no bodies)
app.get('/prompts/:agent/versions', async (req, res) => {
  const { agent } = req.params;
  if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ error: 'invalid agent name' });
  const versions = await promptVersions.list(agent, { limit: req.query.limit });
  res.json({ ok: true, agent, count: versions.length, versions });
});

// GET /prompts/:agent/versions/:n — full body of one version
app.get('/prompts/:agent/versions/:n', async (req, res) => {
  const { agent, n } = req.params;
  if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ error: 'invalid agent name' });
  const body = await promptVersions.getBody(agent, n);
  if (body == null) return res.status(404).json({ error: 'version not found' });
  res.json({ ok: true, agent, version: parseInt(n, 10), body, chars: body.length });
});

// POST /prompts/:agent/rollback {to:<n>} — restore version :n as the active SKILL.md
app.post('/prompts/:agent/rollback', auth.middleware, async (req, res) => {
  const { agent } = req.params;
  if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ error: 'invalid agent name' });
  const to = req.body && req.body.to;
  if (to == null) return res.status(400).json({ error: 'send {to: <version>}' });
  const r = await promptVersions.rollback(agent, to);
  if (!r.ok) return res.status(404).json(r);
  log(`prompts.rollback agent=${agent} to=${to} new_version=${r.version}`);
  res.json({ ok: true, agent, restored_from: parseInt(to, 10), new_version: r.version });
});

// ── F7 · auth routes ────────────────────────────────────────────────────
app.get('/auth/status', (_, res) => {
  res.json({
    ok: true,
    initialized: auth.isInitialized(),
    totp_enabled: auth.isTotpEnabled(),
    disabled: auth.isDisabled(),  // dev override flag — AUTH_DISABLED in .env
  });
});

app.post('/auth/set-password', async (req, res) => {
  // First-time bootstrap: anyone can set the password if none exists.
  // Once initialized, must be authenticated to change it.
  const { password, current, totp_code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  if (auth.isInitialized()) {
    if (!current) return res.status(400).json({ error: 'current password required to change' });
    const v = await auth.login(current, totp_code);
    if (!v.ok) return res.status(401).json({ error: 'current credentials incorrect', requires_totp: v.requires_totp });
  }
  const r = await auth.setPassword(password);
  if (!r.ok) return res.status(400).json(r);
  // Auto-login after set.
  const lr = await auth.login(password, totp_code);
  if (lr.ok) {
    const maxAge = ((lr.expiresAt - Date.now()) / 1000) | 0;
    res.setHeader('Set-Cookie', auth.buildSessionCookie('rxapply_session', lr.token, { maxAgeSec: maxAge }));
  }
  log(`auth.set-password ok=true`);
  res.json({ ok: true, token: lr.token, csrfToken: lr.csrfToken, expiresAt: lr.expiresAt });
});

// /auth/login — rate-limited (5 attempts / 15 min per IP).
app.post('/auth/login', auth.loginRateLimiter, async (req, res) => {
  const { password, totp_code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  const r = await auth.login(password, totp_code);
  if (!r.ok) {
    log(`auth.login fail${r.requires_totp ? ' (totp_required)' : ''}`);
    return res.status(401).json(r);
  }
  const maxAge = ((r.expiresAt - Date.now()) / 1000) | 0;
  res.setHeader('Set-Cookie', auth.buildSessionCookie('rxapply_session', r.token, { maxAgeSec: maxAge }));
  log(`auth.login ok totp=${auth.isTotpEnabled() ? 'used' : 'off'}`);
  res.json({ ok: true, token: r.token, csrfToken: r.csrfToken, expiresAt: r.expiresAt });
});

app.post('/auth/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const m = /(?:^|;\s*)rxapply_session=([^;]+)/.exec(cookieHeader);
  const token = (m && decodeURIComponent(m[1])) || (req.headers.authorization || '').replace(/^Bearer\s+/, '') || null;
  auth.logout(token);
  res.setHeader('Set-Cookie', auth.buildSessionCookie('rxapply_session', '', { clear: true }));
  res.json({ ok: true });
});

// ── 2FA (TOTP) routes ────────────────────────────────────────────────
// /auth/2fa/setup           generate fresh secret + QR + recovery codes
//                           (auth-gated; secret is NOT yet persisted)
// /auth/2fa/confirm         verify the first 6-digit code, then persist
// /auth/2fa/disable         remove 2FA from the account

app.post('/auth/2fa/setup', auth.middleware, async (_req, res) => {
  try {
    const r = await auth.setupTotp({ accountLabel: 'founder', issuer: 'RxApply' });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/auth/2fa/confirm', auth.middleware, async (req, res) => {
  const { secret, code, recovery_codes } = req.body || {};
  const r = await auth.confirmTotpSetup({ secret, code, recoveryCodes: recovery_codes || [] });
  if (!r.ok) return res.status(400).json(r);
  log('auth.2fa.enabled');
  res.json(r);
});

app.post('/auth/2fa/disable', auth.middleware, async (_req, res) => {
  await auth.disableTotp();
  log('auth.2fa.disabled');
  res.json({ ok: true });
});

// ── F7 · settings (gated) ───────────────────────────────────────────────
app.get('/settings', auth.middleware, async (_, res) => {
  try {
    const json = await db.queryValue(`SELECT row_to_json(s) FROM (SELECT id, sandbox_mode, monthly_cap_usd, auth_session_hours, anthropic_key_present, openai_key_present, updated_at::text FROM dashboard_settings WHERE id = 1) s;`);
    res.json({ ok: true, settings: json ? JSON.parse(json) : null,
      auth_initialized: auth.isInitialized(),
      env_keys: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        extra_keys: [
          { name: 'STABILITY_API_KEY',  desc: 'Stable Diffusion 3 (Stability AI) renders.', set: !!process.env.STABILITY_API_KEY },
          { name: 'IDEOGRAM_API_KEY',   desc: 'Ideogram v2 renders (best in-image text).',  set: !!process.env.IDEOGRAM_API_KEY },
          { name: 'REPLICATE_API_TOKEN',desc: 'Flux Schnell/Dev via Replicate.',             set: !!process.env.REPLICATE_API_TOKEN },
          { name: 'RECRAFT_API_KEY',    desc: 'Recraft v3 renders (logos / brand).',         set: !!process.env.RECRAFT_API_KEY },
          { name: 'N8N_API_KEY',        desc: 'n8n REST API access for workflow control.',   set: !!process.env.N8N_API_KEY },
        ],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/settings', auth.middleware, async (req, res) => {
  const allowed = ['sandbox_mode', 'monthly_cap_usd', 'auth_session_hours'];
  const updates = [];
  for (const k of allowed) {
    if (req.body && req.body[k] !== undefined) {
      const v = req.body[k];
      const safeVal = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE')
                    : typeof v === 'number' ? String(v)
                    : `'${String(v).replace(/'/g, "''")}'`;
      updates.push(`${k} = ${safeVal}`);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no allowed fields' });
  updates.push('updated_at = NOW()');
  try {
    await db.query(`UPDATE dashboard_settings SET ${updates.join(', ')} WHERE id = 1;`);
    log(`settings.patch fields=${Object.keys(req.body).join(',')}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── F3 · Service control ────────────────────────────────────────────────
// GET  /services                       — status of 4 services
// GET  /services/:name                 — status of one
// POST /services/:name/:action         — start | stop | restart
const SERVICE_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const SERVICE_ACTIONS = ['start', 'stop', 'restart'];

app.get('/services', async (_, res) => {
  try {
    const all = await services.statusAll();
    res.json({ ok: true, services: all });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/services/:name', async (req, res) => {
  const name = req.params.name;
  if (!SERVICE_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid service name' });
  try {
    const status = await services.getStatus(name);
    if (status.error) return res.status(404).json({ ok: false, error: status.error });
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /services/:name/:action — start/stop/restart. Gated by auth (control plane).
app.post('/services/:name/:action', auth.middleware, async (req, res) => {
  const { name, action } = req.params;
  if (!SERVICE_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid service name' });
  if (!SERVICE_ACTIONS.includes(action)) return res.status(400).json({ error: 'invalid action — start|stop|restart' });
  log(`services.${action} name=${name}`);
  try {
    const r = services.action(name, action);
    // services.action returns either { ok, stdout, stderr } or { ok:false, error }
    if (r.ok === false && r.error) return res.status(400).json(r);
    // Re-fetch status so the response shows the new state.
    const after = await services.getStatus(name);
    res.json({ ok: true, name, action, before: null, after, raw: { stdout: (r.stdout || '').slice(0, 1000), stderr: (r.stderr || '').slice(0, 1000) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── F8 · Afshin design pipeline ─────────────────────────────────────────
app.post('/afshin/draft', auth.middleware, async (req, res) => {
  const { kind, topic, language, notes } = req.body || {};
  log(`afshin.draft kind=${kind} topic=${(topic||'').slice(0,80)}`);
  // K1 · permission gate
  const mode = permissions.getMode('afshin', 'draft', 0.005);
  if (mode === 'blocked') return res.status(403).json({ ok: false, error: 'afshin:draft is blocked in the permission matrix' });
  if (mode === 'ask') {
    const queued = await permissions.queue({
      agent: 'afshin', action: 'draft',
      payload: { kind, topic, language, notes },
      preview: `Generate SVG draft for "${(topic||'').slice(0,80)}" (${kind})`,
      estimatedCostUsd: 0.005, triggeredBy: 'founder',
    });
    return res.status(202).json({ ok: true, queued: true, inbox_id: queued.id, mode: 'ask' });
  }
  const r = await afshin.generateDraft({ kind, topic, language, notes });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.post('/afshin/render/:mediaId', auth.middleware, async (req, res) => {
  const { mediaId } = req.params;
  const prompt   = req.body && req.body.prompt;
  const modelKey = req.body && req.body.model_key;
  log(`afshin.render id=${mediaId} model=${modelKey || 'default'}`);
  // K1 · permission gate (paid render — default 'ask')
  const mode = permissions.getMode('afshin', 'render', 0.04);
  if (mode === 'blocked') return res.status(403).json({ ok: false, error: 'afshin:render is blocked in the permission matrix' });
  if (mode === 'ask') {
    const queued = await permissions.queue({
      agent: 'afshin', action: 'render',
      payload: { mediaId, prompt, modelKey },
      preview: `Render PNG via ${modelKey || 'default model'} for media ${mediaId.slice(0,8)}`,
      estimatedCostUsd: 0.04, triggeredBy: 'founder',
    });
    return res.status(202).json({ ok: true, queued: true, inbox_id: queued.id, mode: 'ask' });
  }
  const r = await afshin.generateRender({ mediaId, prompt, modelKey });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ── F8b · Afshin multi-model management ─────────────────────────────────
// GET  /afshin/models          — list registry with key-present status
// GET  /afshin/models/defaults — per-kind current defaults
// PATCH /afshin/models/defaults — { kind, model_key } → update one default

app.get('/afshin/models', (_, res) => {
  res.json({ ok: true, models: afshin.listModels(), kinds: afshin.getKindDefaults() });
});

app.patch('/afshin/models/defaults', auth.middleware, async (req, res) => {
  const { kind, model_key } = req.body || {};
  if (!kind) return res.status(400).json({ error: 'send {kind, model_key}' });
  const r = await afshin.setModelDefault(kind, model_key || null);
  if (!r.ok) return res.status(400).json(r);
  log(`afshin.setDefault kind=${kind} model=${model_key || 'cleared'}`);
  res.json(r);
});

// ── Per-agent LLM model overrides ────────────────────────────────────
// GET   /agent-models                    — registry + current overrides
// PATCH /agent-models/defaults           — { agent, model_key } (auth)
app.get('/agent-models', (_, res) => {
  res.json({
    ok: true,
    models: agentModels.listModels(),
    default: agentModels.DEFAULT_MODEL,
    overrides: agentModels.getOverrides(),
  });
});
app.patch('/agent-models/defaults', auth.middleware, async (req, res) => {
  const { agent, model_key } = req.body || {};
  if (!agent) return res.status(400).json({ error: 'send {agent, model_key}' });
  const r = await agentModels.setOverride(agent, model_key || null);
  if (!r.ok) return res.status(400).json(r);
  log(`agent-models.set agent=${agent} model=${model_key || 'cleared'}`);
  res.json(r);
});

// ── Brand profile ────────────────────────────────────────────────────
// GET   /brand-profile        — current profile
// PATCH /brand-profile        — overwrite (auth)
app.get('/brand-profile', (_, res) => {
  res.json({ ok: true, profile: brandProfile.get(), default: brandProfile.DEFAULT_PROFILE });
});
app.patch('/brand-profile', auth.middleware, async (req, res) => {
  const r = await brandProfile.set(req.body || {});
  if (!r.ok) return res.status(400).json(r);
  log(`brand-profile.set keys=${Object.keys(req.body || {}).join(',')}`);
  res.json(r);
});

// ── K1 · Permissions matrix ──────────────────────────────────────────
app.get('/permissions', (_, res) => {
  try { res.json({ ok: true, rows: permissions.listAll() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.patch('/permissions', auth.middleware, async (req, res) => {
  const { agent, action, mode, cost_threshold_usd, notes } = req.body || {};
  if (!agent || !action || !mode) return res.status(400).json({ error: 'send {agent, action, mode}' });
  const r = await permissions.setMode(agent, action, mode, {
    costThreshold: cost_threshold_usd, notes,
  });
  if (!r.ok) return res.status(400).json(r);
  log(`permissions.set ${agent}:${action} → ${mode}`);
  res.json(r);
});

// ── K1 · Inbox (pending approvals queue) ────────────────────────────
app.get('/inbox', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const [pending, recent] = await Promise.all([
      permissions.listPending({ limit }),
      permissions.listRecent({ limit: 30 }),
    ]);
    res.json({ ok: true, pending, recent });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/inbox/count', async (_, res) => {
  try { res.json({ ok: true, count: await permissions.countPending() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/inbox/:id/approve', auth.middleware, async (req, res) => {
  const id = req.params.id;
  const note = (req.body && req.body.note) || null;
  const row = await permissions.approve(id, note, 'founder');
  if (!row) return res.status(404).json({ ok: false, error: 'not pending or not found' });

  // Now actually execute the action. Currently we support:
  //   afshin.draft, afshin.render, compose.approve-plan, compose.approve-for-posting
  //   any agent helper via /run-helper-style spawn
  log(`inbox.approve ${id.slice(0,8)} ${row.agent}:${row.action}`);
  try {
    const exec = await _executeApprovedAction(row);
    await permissions.recordExecutionResult(id, exec);
    res.json({ ok: true, decided: row, executed: exec });
  } catch (e) {
    await permissions.recordExecutionFailure(id, e.message);
    res.status(500).json({ ok: false, error: e.message, decided: row });
  }
});

app.post('/inbox/:id/reject', auth.middleware, async (req, res) => {
  const id = req.params.id;
  const note = (req.body && req.body.note) || null;
  const row = await permissions.reject(id, note, 'founder');
  if (!row) return res.status(404).json({ ok: false, error: 'not pending or not found' });
  // T1 · If the rejected card was a tool call, mark the tool_calls row too.
  if (row.action && row.action.startsWith('tool:') && row.payload && row.payload.callId) {
    try { toolsRuntime.rejectCall(row.payload.callId, 'founder'); } catch (_) {}
  }
  log(`inbox.reject ${id.slice(0,8)} ${row.agent}:${row.action}`);
  res.json({ ok: true, decided: row });
});

// Execute an approved Inbox action. Routes by (agent, action).
async function _executeApprovedAction(row) {
  const { agent, action, payload } = row;

  // T1 · Tools framework. Cards queued by tools/runtime.js use action
  // names of the form `tool:<slug>:<op>` and stash a callId in payload.
  // Dispatch back through the runtime so the cost/log path is identical.
  if (typeof action === 'string' && action.startsWith('tool:') && payload && payload.callId) {
    return await toolsRuntime.executeApproved(payload.callId);
  }

  if (agent === 'afshin' && action === 'render') {
    const r = await afshin.generateRender({
      mediaId: payload.mediaId,
      prompt: payload.prompt,
      modelKey: payload.modelKey,
    });
    return r;
  }
  if (agent === 'afshin' && action === 'draft') {
    const r = await afshin.generateDraft({
      kind: payload.kind, topic: payload.topic, language: payload.language, notes: payload.notes,
    });
    return r;
  }
  // Generic helper actions: spawn the agent's helper with the recorded
  // command + args + stdin, capture stdout.
  if (payload && payload.kind === 'run-helper') {
    return await new Promise((resolve, reject) => {
      const argv = [
        path.join(AGENTS_DIR, agent, `${agent}.py`),
        payload.command || 'help',
        ...((payload.args || []).map(String)),
      ];
      const child = spawn(PYTHON_BIN, argv, {
        shell: false,
        cwd: path.join(AGENTS_DIR, agent),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString('utf-8'); });
      child.stderr.on('data', d => { err += d.toString('utf-8'); });
      child.on('error', e => reject(e));
      child.on('close', code => {
        if (code === 0) resolve({ ok: true, stdout: out, exitCode: code });
        else reject(new Error(`helper ${agent} exit ${code}: ${err.slice(0, 300)}`));
      });
    });
  }
  // Default: nothing to execute server-side; just record the approval.
  return { ok: true, note: 'approved (no server-side execution registered for this action)' };
}

// ── K1 · Output renderers (per-agent narrative formatters) ──────────
app.get('/renderers', (_, res) => {
  res.json({ ok: true, renderers: renderers.listAll() });
});
app.patch('/renderers/:agent', auth.middleware, async (req, res) => {
  const r = await renderers.setRendererForAgent(req.params.agent, req.body || {});
  if (!r.ok) return res.status(400).json(r);
  log(`renderers.set ${req.params.agent}`);
  res.json(r);
});

// Helper: render a single output via the codebase rules (used by the dashboard)
app.post('/renderers/render', (req, res) => {
  const { agent, action, output, meta } = req.body || {};
  if (!agent || !action) return res.status(400).json({ error: 'send {agent, action, output}' });
  res.json({ ok: true, text: renderers.render(agent, action, output, meta) });
});

// ── K2 · Agent memory ────────────────────────────────────────────────
// GET    /agents/:name/memory          list memories (optionally ?type=&query=)
// POST   /agents/:name/memory          add a manual entry (auth)
// PATCH  /memory/:id                   edit content/tags/importance (auth)
// DELETE /memory/:id                   remove one (auth)
// POST   /agents/:name/memory/forget   bulk delete by content match (auth)
// GET    /agents/:name/memory/recall   preview what would be injected
app.get('/agents/:name/memory', async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const items = await agentMemory.list(name, {
    type: req.query.type || null,
    limit: req.query.limit || 50,
    query: req.query.query || null,
  });
  res.json({ ok: true, agent: name, count: items.length, items });
});

app.post('/agents/:name/memory', auth.middleware, async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const { type, content, tags, importance, related_to } = req.body || {};
  const r = await agentMemory.write({
    agent: name, type, content, tags, importance,
    source: 'founder', relatedTo: related_to,
  });
  if (!r.ok) return res.status(400).json(r);
  log(`memory.write agent=${name} type=${type} importance=${importance || 3}`);
  res.json(r);
});

app.patch('/memory/:id', auth.middleware, async (req, res) => {
  const r = await agentMemory.update(req.params.id, req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.delete('/memory/:id', auth.middleware, async (req, res) => {
  const r = await agentMemory.remove(req.params.id);
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
});

app.post('/agents/:name/memory/forget', auth.middleware, async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const { query } = req.body || {};
  const r = await agentMemory.forget(name, query);
  if (!r.ok) return res.status(400).json(r);
  log(`memory.forget agent=${name} query="${(query||'').slice(0,40)}" removed=${r.removed}`);
  res.json(r);
});

app.get('/agents/:name/memory/recall', async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const text = await agentMemory.renderAsBlock(name, {
    limit: parseInt(req.query.limit, 10) || 8,
    tags: req.query.tags ? String(req.query.tags).split(',').map(s => s.trim()).filter(Boolean) : [],
    queryKeywords: req.query.query ? String(req.query.query).split(/\s+/).filter(Boolean) : [],
  });
  res.json({ ok: true, agent: name, block: text, has_memories: text.length > 0 });
});

// ── K3 · Training & Rating ──────────────────────────────────────────
// POST /evals/run/:runId/rate          { agent, score (1..5), dimension?, note? }
// POST /evals/run/:runId/correct       { agent, correctedOutput, originalOutput?, note?, tags? }
// POST /agents/:name/example           { content, tags?, importance?, note? }
// GET  /evals/recent                   ?agent=&kind=&limit=
// GET  /evals/agent/:name/kpis         ?days=7
// GET  /evals/kpis                     ?days=7
app.post('/evals/run/:runId/rate', auth.middleware, async (req, res) => {
  const { runId } = req.params;
  const { agent, score, dimension, note } = req.body || {};
  const r = await agentEvals.rateRun({ runId, agent, score: parseInt(score, 10), dimension, note });
  if (!r.ok) return res.status(400).json(r);
  log(`evals.rate run=${runId.slice(0,8)} agent=${agent} score=${score}`);
  res.json(r);
});

app.post('/evals/run/:runId/correct', auth.middleware, async (req, res) => {
  const { runId } = req.params;
  const { agent, originalOutput, correctedOutput, note, tags } = req.body || {};
  const r = await agentEvals.submitCorrection({
    runId, agent, originalOutput, correctedOutput, note, tags,
  });
  if (!r.ok) return res.status(400).json(r);
  log(`evals.correct run=${runId.slice(0,8)} agent=${agent} → mem ${(r.memory_ids||[]).map(id=>id.slice(0,8)).join(',')}`);
  res.json(r);
});

app.post('/agents/:name/example', auth.middleware, async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const { content, tags, importance, note } = req.body || {};
  const r = await agentEvals.submitExample({ agent: name, content, tags, importance: parseInt(importance, 10), note });
  if (!r.ok) return res.status(400).json(r);
  log(`evals.example agent=${name} importance=${importance || 4} → mem ${(r.memory_ids||[]).map(id=>id.slice(0,8)).join(',')}`);
  res.json(r);
});

app.get('/evals/recent', async (req, res) => {
  const items = await agentEvals.listRecent({
    agent: req.query.agent || null,
    kind: req.query.kind || null,
    limit: req.query.limit,
  });
  res.json({ ok: true, count: items.length, items });
});

app.get('/evals/agent/:name/kpis', async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  res.json({ ok: true, ...(await agentEvals.getKPIsForAgent(name, parseInt(req.query.days, 10) || 7)) });
});

app.get('/evals/kpis', async (req, res) => {
  const days = parseInt(req.query.days, 10) || 7;
  res.json({ ok: true, days, agents: await agentEvals.getKPIsAll(days) });
});

// ── K4 · Agent handoffs ─────────────────────────────────────────────
// GET    /handoffs                       pending + recent (?agent=)
// GET    /handoffs/count                 just the pending count for sidebar badge
// POST   /handoffs                       founder manually creates a handoff (rare; auto-detected mostly)
// POST   /handoffs/:id/approve           run the to_agent with payload (auth)
// POST   /handoffs/:id/reject            mark rejected (auth)
// POST   /handoffs/:id/redirect          redirect to a different agent (auth)
app.get('/handoffs', async (req, res) => {
  const [pending, recent] = await Promise.all([
    handoffs.listPending({ limit: 50 }),
    handoffs.listRecent({ limit: 30, agent: req.query.agent || null }),
  ]);
  res.json({ ok: true, pending, recent });
});
app.get('/handoffs/count', async (_, res) => {
  res.json({ ok: true, count: await handoffs.countPending() });
});
app.post('/handoffs', auth.middleware, async (req, res) => {
  const { from_agent, to_agent, reason, suggested_action, payload, source_run_id } = req.body || {};
  const r = await handoffs.record({
    fromAgent: from_agent, toAgent: to_agent, reason,
    suggestedAction: suggested_action, payload, sourceRunId: source_run_id,
  });
  if (!r.ok) return res.status(400).json(r);
  log(`handoff.create ${from_agent} → ${to_agent}`);
  res.json(r);
});
app.post('/handoffs/:id/approve', auth.middleware, async (req, res) => {
  const note = (req.body && req.body.note) || null;
  const row = await handoffs.approve(req.params.id, note, 'founder');
  if (!row) return res.status(404).json({ ok: false, error: 'not pending or not found' });
  log(`handoff.approve ${req.params.id.slice(0,8)} ${row.from_agent} → ${row.to_agent}`);
  // Execute by spawning the to_agent's helper (suggested_action is the cmd).
  // The receiver's output is recorded so the founder can see what happened.
  const action = row.suggested_action || 'help';
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(PYTHON_BIN, [
        path.join(AGENTS_DIR, row.to_agent, `${row.to_agent}.py`),
        action,
      ], {
        shell: false,
        cwd: path.join(AGENTS_DIR, row.to_agent),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
      child.on('error', e => reject(e));
      child.on('close', code => {
        if (code === 0) resolve({ ok: true, stdout, exitCode: code });
        else reject(new Error(`helper ${row.to_agent} exit ${code}: ${stderr.slice(0, 300)}`));
      });
    });
    await handoffs.recordResult(req.params.id, out);
    res.json({ ok: true, decided: row, executed: out });
  } catch (e) {
    await handoffs.recordFailure(req.params.id, e.message);
    res.status(500).json({ ok: false, error: e.message, decided: row });
  }
});
app.post('/handoffs/:id/reject', auth.middleware, async (req, res) => {
  const note = (req.body && req.body.note) || null;
  const row = await handoffs.reject(req.params.id, note, 'founder');
  if (!row) return res.status(404).json({ ok: false, error: 'not pending or not found' });
  log(`handoff.reject ${req.params.id.slice(0,8)}`);
  res.json({ ok: true, decided: row });
});
app.post('/handoffs/:id/redirect', auth.middleware, async (req, res) => {
  const { to_agent, note } = req.body || {};
  if (!to_agent) return res.status(400).json({ error: 'to_agent required' });
  const r = await handoffs.redirect(req.params.id, to_agent, note || null, 'founder');
  if (!r) return res.status(400).json({ ok: false, error: 'redirect failed' });
  log(`handoff.redirect ${req.params.id.slice(0,8)} → ${to_agent}`);
  res.json({ ok: true, ...r });
});

// ── K5 · Hire a new employee ─────────────────────────────────────────
// POST /agents/hire { name, role, division, description? }
// Creates: agents/<name>/SKILL.md + agents/<name>/<name>.py stub.
// Seeds two default permissions: chat (auto), help (auto).
app.post('/agents/hire', auth.middleware, async (req, res) => {
  const { name, role, division = 'Operations', description = '', avatar_b64 = null, avatar_ext = null } = req.body || {};
  if (!name || !AGENT_NAME_RE.test(name)) return res.status(400).json({ ok: false, error: 'name must be a-z, 0-9, _, - (max 40 chars)' });
  if (!role) return res.status(400).json({ ok: false, error: 'role required' });
  const dir = path.join(AGENTS_DIR, name);
  if (fs.existsSync(dir)) return res.status(409).json({ ok: false, error: `agent "${name}" already exists` });
  try {
    fs.mkdirSync(dir, { recursive: true });

    // Save uploaded avatar (optional) before creating agent files. If it fails
    // we keep going — a missing avatar is non-blocking, the founder can add
    // one later from the agent detail page.
    if (avatar_b64 && avatar_ext) {
      try { _saveAgentAvatar(name, avatar_b64, avatar_ext); }
      catch (e) { log(`avatar save failed during hire (${name}): ${e.message.slice(0, 200)}`); }
    }
    const skill = `---\nname: ${name}\ndescription: ${role}. Use this skill when the founder says "run ${name}", "${role.toLowerCase()}", or asks ${name} a direct question.\n---\n\n# ${name.charAt(0).toUpperCase() + name.slice(1)} — ${role}\n\n## Role\n${description || role}\n\n## Voice\n- Hype-free. Specific. Inclusive.\n- Always defer to the central brand profile (Settings → Brand profile).\n\n## Workflow\n1. Read inputs from the founder.\n2. Apply your role's specialty.\n3. Output JSON suitable for the dashboard renderers.\n4. Optionally emit a handoff_intent if another teammate is needed.\n\n## Memory\nThe founder will train you over time via Settings → Per-agent memory and the Train tab.\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill, 'utf-8');
    const helper = `"""\n${name} helper — minimum-viable stub.\n\nUsage: python ${name}.py help\n\nThis stub intentionally does nothing yet. Edit when you know the role's I/O shape.\n"""\nimport sys\nif hasattr(sys.stdout, 'reconfigure'):\n    sys.stdout.reconfigure(encoding='utf-8', errors='replace')\n\ndef main():\n    cmd = sys.argv[1] if len(sys.argv) > 1 else 'help'\n    if cmd in ('help', '--help', '-h'):\n        print(__doc__)\n        return\n    print(f"${name} stub: '{cmd}' is not implemented. Edit agents/${name}/${name}.py.")\n\nif __name__ == '__main__':\n    main()\n`;
    fs.writeFileSync(path.join(dir, `${name}.py`), helper, 'utf-8');

    // Seed default permissions
    await permissions.setMode(name, 'help', 'auto', { notes: 'safe — stub help command' });
    await permissions.setMode(name, 'chat', 'auto', { notes: 'F5 chat tab' });

    log(`agents.hire name=${name} role="${role}" division=${division}`);
    res.json({ ok: true, name, dir, role, division });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message.slice(0, 300) });
  }
});

// ════════════════════════════════════════════════════════════════════════
// Per-agent avatar upload · stored in object storage (R2 in cloud, local
// fallback in dev) under `avatars/<name>.<ext>`. Index of (agent → ext)
// kept in `dashboard_settings.avatars_jsonb` so listing is one DB read
// rather than an O(N) bucket-list. Dashboard fetches /agents/avatars on
// boot, caches the URL map in localStorage.
// ════════════════════════════════════════════════════════════════════════

const AVATAR_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

async function _readAvatarIndex() {
  try {
    const raw = await db.queryValue(`SELECT avatars FROM dashboard_settings WHERE id = 1;`);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { return {}; }
}
async function _writeAvatarIndex(map) {
  await db.query(`UPDATE dashboard_settings
                     SET avatars = ${db.q(JSON.stringify(map))}::jsonb,
                         updated_at = NOW()
                   WHERE id = 1;`);
}

// GET /agents/avatars → { agentName: '<storage url>', … }
app.get('/agents/avatars', async (_req, res) => {
  const idx = await _readAvatarIndex();
  const out = {};
  for (const [name, ext] of Object.entries(idx)) {
    out[name] = storage.urlFor(storage.KEYS.AVATAR(name, ext));
  }
  res.json({ ok: true, avatars: out });
});

// POST /agents/:name/avatar  🔒
//   Body JSON: { content_b64, ext }
//   Replaces the agent's avatar. Max 5MB. Allowed: jpg, jpeg, png, webp, gif.
app.post('/agents/:name/avatar', auth.middleware, async (req, res) => {
  const name = req.params.name;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ ok: false, error: 'invalid agent name' });
  const { content_b64, ext } = req.body || {};
  if (!content_b64) return res.status(400).json({ ok: false, error: 'content_b64 required' });
  const safeExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
  if (!AVATAR_EXTS.includes(safeExt)) {
    return res.status(400).json({ ok: false, error: `unsupported extension: ${safeExt}` });
  }
  const buf = Buffer.from(String(content_b64), 'base64');
  if (!buf || buf.length === 0) return res.status(400).json({ ok: false, error: 'empty content' });
  if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'avatar too large (max 5MB)' });

  try {
    const idx = await _readAvatarIndex();
    // Remove the prior file (different extension) before overwriting the index.
    const priorExt = idx[name];
    if (priorExt && priorExt !== safeExt) {
      await storage.remove(storage.KEYS.AVATAR(name, priorExt));
    }
    const key = storage.KEYS.AVATAR(name, safeExt);
    await storage.put({
      key, body: buf,
      contentType: `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
    });
    idx[name] = safeExt;
    await _writeAvatarIndex(idx);
    log(`avatar.save name=${name} bytes=${buf.length} ext=.${safeExt} backend=${storage.BACKEND}`);
    res.json({ ok: true, key, url: storage.urlFor(key), bytes: buf.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message.slice(0, 300) });
  }
});

// DELETE /agents/:name/avatar  🔒  →  reverts to the 5×5 sprite face
app.delete('/agents/:name/avatar', auth.middleware, async (req, res) => {
  const name = req.params.name;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ ok: false, error: 'invalid agent name' });
  try {
    const idx = await _readAvatarIndex();
    const ext = idx[name];
    if (!ext) return res.json({ ok: true, removed: false });
    await storage.remove(storage.KEYS.AVATAR(name, ext));
    delete idx[name];
    await _writeAvatarIndex(idx);
    log(`avatar.delete name=${name}`);
    res.json({ ok: true, removed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message.slice(0, 300) });
  }
});

// ── K6 · Knowledge Base ───────────────────────────────────────────────
// Founder-facing CRUD for the KB. All other agents read via injected
// renderAsBlock(); these routes manage the data.
app.get('/kb', auth.middleware, async (req, res) => {
  const { country, category, status, query, limit } = req.query || {};
  res.json({ ok: true, entries: await KB.list({ country, category, status, query, limit }) });
});
app.get('/kb/:id', auth.middleware, async (req, res) => {
  const e = await KB.getOne(req.params.id);
  if (!e) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, entry: e });
});
app.post('/kb', auth.middleware, async (req, res) => {
  const r = await KB.add({ ...(req.body || {}), verifiedBy: 'founder' });
  if (!r.ok) return res.status(400).json(r);
  log(`kb.add ${(req.body && req.body.country) || '?'}/${(req.body && req.body.category) || '?'} "${(req.body && req.body.title || '').slice(0,60)}"`);
  res.json(r);
});
app.patch('/kb/:id', auth.middleware, async (req, res) => {
  const r = await KB.update(req.params.id, req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});
app.post('/kb/:id/verify-mark', auth.middleware, async (req, res) => {
  const r = await KB.markVerified(req.params.id, 'founder');
  res.json(r);
});
app.post('/kb/:id/stale', auth.middleware, async (req, res) => {
  const r = await KB.markStale(req.params.id);
  res.json(r);
});
app.post('/kb/:id/supersede', auth.middleware, async (req, res) => {
  const r = await KB.supersede(req.params.id, { ...(req.body || {}), verifiedBy: 'founder' });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});
app.delete('/kb/:id', auth.middleware, async (req, res) => {
  res.json(await KB.remove(req.params.id));
});
// Recall (debug): ad-hoc query of what would be injected
app.get('/kb/recall/preview', auth.middleware, async (req, res) => {
  const { country, category, query, limit } = req.query || {};
  const [rows, block] = await Promise.all([
    KB.recall({ country, category, query, limit }),
    KB.renderAsBlock({ country, category, query, limit }),
  ]);
  res.json({ ok: true, rows, block });
});

// ── K6 · Daneshyar agent endpoints ────────────────────────────────────
// /parse        → preview entries; do not save
// /parse-and-save → parse then INSERT each entry as draft
// /verify       → re-check an entry's freshness/coherence
// /find-more    → propose related missing facts for an anchor entry
// Helper: every Anthropic-API route writes a row to agent_runs with the
// real cost so the Overview cost widget reflects actual spend (not just
// helper-spawn costs). Without this, daneshyar/compose calls leave no trace
// in agent_runs.cost_usd_actual and the spend dashboard reads as $0.
async function _logAnthropic(agent, action, r, payload) {
  try {
    await logWriter.logApiCall({
      agent, action,
      costUsd: r.cost_usd || 0,
      model: r.model,
      inputTokens: r.input_tokens || 0,
      outputTokens: r.output_tokens || 0,
      inputPayload: payload,
      output: JSON.stringify(r).slice(0, 8000),
    });
  } catch (_) { /* non-fatal */ }
}

app.post('/daneshyar/parse', auth.middleware, async (req, res) => {
  try {
    const { text, country, hint } = req.body || {};
    const r = await daneshyar.parse({ text, country, hint });
    if (!r.ok) return res.status(400).json(r);
    await _logAnthropic('daneshyar', 'parse', r, { country, hint, text_chars: (text || '').length });
    log(`daneshyar.parse country=${r.detected_country || '?'} entries=${r.entries.length} cost=$${(r.cost_usd||0).toFixed(4)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message.slice(0, 300) }); }
});
app.post('/daneshyar/parse-and-save', auth.middleware, async (req, res) => {
  try {
    const { text, country, hint } = req.body || {};
    const r = await daneshyar.parseAndSave({ text, country, hint });
    if (!r.ok) return res.status(400).json(r);
    await _logAnthropic('daneshyar', 'parse-and-save', r, { country, hint, text_chars: (text || '').length });
    log(`daneshyar.parse-and-save saved=${r.saved.length} cost=$${(r.cost_usd||0).toFixed(4)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message.slice(0, 300) }); }
});
app.post('/daneshyar/verify/:id', auth.middleware, async (req, res) => {
  try {
    const r = await daneshyar.verify({ id: req.params.id });
    if (!r.ok) return res.status(404).json(r);
    await _logAnthropic('daneshyar', 'verify', r, { kb_id: req.params.id });
    log(`daneshyar.verify ${req.params.id.slice(0,8)} verdict=${r.verdict} cost=$${(r.cost_usd||0).toFixed(4)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message.slice(0, 300) }); }
});
// POST /daneshyar/upload-and-parse  🔒
//   { filename, content_b64, country?, hint?, save? }
//   Decodes base64 to a temp file, runs agents/daneshyar/extract.py to pull
//   plain text, then pipes that text through Daneshyar's existing parse
//   pipeline (preview only, or parseAndSave when save=true).
//   Supported extensions: .pdf .docx .pptx .html .htm .md .txt .rtf
app.post('/daneshyar/upload-and-parse', auth.middleware, async (req, res) => {
  const { filename, content_b64, country = null, hint = null, save = false } = req.body || {};
  if (!filename || !content_b64) {
    return res.status(400).json({ ok: false, error: 'filename + content_b64 required' });
  }
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'upload';
  const ext = path.extname(safeName).toLowerCase();
  const allowed = new Set(['.pdf', '.docx', '.doc', '.pptx', '.html', '.htm', '.md', '.txt', '.rtf']);
  if (!allowed.has(ext)) {
    return res.status(400).json({ ok: false, error: `unsupported file type: ${ext || '(none)'}. Allowed: ${Array.from(allowed).join(' ')}` });
  }
  // Decode base64 → buffer.
  let buf;
  try { buf = Buffer.from(String(content_b64), 'base64'); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid base64' }); }
  if (!buf || buf.length === 0) return res.status(400).json({ ok: false, error: 'empty content' });
  if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'file too large (max 25MB)' });

  // Write to a temp path inside cowork-proxy/.tmp_uploads (created on demand).
  const tmpDir = path.join(__dirname, '.tmp_uploads');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  const tmpPath = path.join(tmpDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`);
  fs.writeFileSync(tmpPath, buf);

  // Spawn extractor.
  const extractor = path.join(AGENTS_DIR, 'daneshyar', 'extract.py');
  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch (_) {} };

  const child = spawn(PYTHON_BIN, [extractor, tmpPath], {
    shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let stdout = Buffer.alloc(0);
  let stderr = '';
  child.stdout.on('data', d => { stdout = Buffer.concat([stdout, d]); });
  child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
  child.on('error', (err) => {
    cleanup();
    res.status(500).json({ ok: false, error: 'extractor spawn failed: ' + err.message });
  });
  child.on('close', async (code) => {
    cleanup();
    if (code === 3) {
      // Missing python lib — surface install hint.
      return res.status(500).json({ ok: false, error: stderr.trim() || 'missing python dependency', code });
    }
    if (code !== 0) {
      return res.status(500).json({ ok: false, error: stderr.trim() || `extractor exit ${code}`, code });
    }
    const text = stdout.toString('utf-8').trim();
    if (!text || text.length < 10) {
      return res.status(400).json({
        ok: false, error: 'no text extracted from file (image-only PDF? empty doc?)',
        stderr: stderr.trim().slice(0, 300) || null,
      });
    }
    // Combine the founder's hint with the filename — gives Daneshyar a
    // little provenance signal even when hint is empty.
    const hintWithFilename = [hint, `source filename: ${safeName}`].filter(Boolean).join(' · ');
    try {
      const r = save
        ? await daneshyar.parseAndSave({ text, country, hint: hintWithFilename })
        : await daneshyar.parse({ text, country, hint: hintWithFilename });
      if (!r.ok) return res.status(400).json(r);
      await _logAnthropic('daneshyar', save ? 'upload-and-save' : 'upload-and-preview', r, { filename: safeName, bytes: buf.length, country });
      log(`daneshyar.upload-and-parse file="${safeName}" bytes=${buf.length} text_chars=${text.length} ` +
          (save ? `saved=${r.saved.length}` : `preview_entries=${r.entries.length}`) +
          ` cost=$${(r.cost_usd||0).toFixed(4)}`);
      // Echo the extracted text length + a small preview so the founder can
      // confirm the right thing was read out of the file.
      res.json({ ok: true, ...r,
        upload: {
          filename: safeName, ext, bytes: buf.length,
          text_chars: text.length,
          text_preview: text.slice(0, 500),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message.slice(0, 300) });
    }
  });
});

app.post('/daneshyar/find-more/:id', auth.middleware, async (req, res) => {
  try {
    const r = await daneshyar.findMore({ id: req.params.id });
    if (!r.ok) return res.status(404).json(r);
    await _logAnthropic('daneshyar', 'find-more', r, { kb_id: req.params.id });
    log(`daneshyar.find-more ${req.params.id.slice(0,8)} suggestions=${r.missing_facts.length} cost=$${(r.cost_usd||0).toFixed(4)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message.slice(0, 300) }); }
});

app.post('/afshin/approve/:mediaId', auth.middleware, async (req, res) => {
  const approved = req.body && req.body.approved !== undefined ? !!req.body.approved : true;
  const r = await afshin.approve(req.params.mediaId, approved);
  log(`afshin.approve id=${req.params.mediaId} approved=${approved}`);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.post('/afshin/archive/:mediaId', auth.middleware, async (req, res) => {
  const r = await afshin.archive(req.params.mediaId);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ── Compose-IG psql helper [cloud build] ─────────────────────────────
// Was a docker-shell-out in the local sandbox. Now goes through the
// shared pg pool. Async, so the 6 callers below all `await`.
async function _composePsql(sql) {
  return await db.queryValue(sql);
}
function _qStr(v) { return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }
function _qJson(v) { return v == null ? 'NULL' : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`; }

// POST /compose/approve-plan — Gate A
//   Body: { topic, tone, languages, design_plan }
//   Action:
//     1. Insert a media_library row with kind='ig_carousel_slide', the design plan,
//        the trio of captions, and plan_approved_at = NOW().
//     2. Synchronously call Afshin to generate the SVG draft (cheap, ~$0.005).
//     3. Return { ok, media_id, draft_path, draft_cost_usd }.
app.post('/compose/approve-plan', auth.middleware, async (req, res) => {
  const { topic, tone, languages, design_plan } = req.body || {};
  if (!topic || !design_plan || !languages) {
    return res.status(400).json({ ok: false, error: 'send {topic, tone, languages, design_plan}' });
  }

  // Insert the media_library row with status: plan approved, no draft yet.
  const id = crypto.randomUUID();
  const dim = '1080x1080';
  const kind = (design_plan.kind || 'ig_carousel_slide');
  const planSql = `
    INSERT INTO media_library (id, kind, topic, language, prompt, dimensions,
                               design_plan, captions, plan_approved_at, plan_approved_by,
                               draft_cost_usd, metadata)
    VALUES (${_qStr(id)}, ${_qStr(kind)}, ${_qStr(topic)}, 'multi',
            ${_qStr(design_plan.image_prompt)}, ${_qStr(dim)},
            ${_qJson(design_plan)}, ${_qJson(languages)},
            NOW(), 'founder', 0,
            ${_qJson({ tone, source: 'compose-ig' })});
  `;
  try { await _composePsql(planSql); }
  catch (e) { return res.status(500).json({ ok: false, error: 'failed to save: ' + e.message.slice(0, 200) }); }

  log(`compose.approve-plan id=${id.slice(0,8)} topic="${topic.slice(0,60)}"`);

  // Now generate the SVG draft via Afshin. This re-uses the existing
  // Afshin route logic; we just call generateDraft() directly.
  // Afshin's generateDraft creates its own row, so we need a slightly
  // different pattern — call Anthropic directly to make the SVG and
  // update OUR row's draft_path.
  // Instead: call the existing Afshin draft helper, then UPDATE our row's
  // draft_path to point at the generated file. This keeps Afshin reusable.
  let draftResp;
  try {
    draftResp = await afshin.generateDraft({
      kind,
      topic,
      language: 'en',  // SVG draft language is irrelevant for our shared image
      notes: design_plan.image_prompt,
    });
  } catch (e) {
    return res.json({ ok: true, media_id: id, draft_path: null, draft_error: e.message });
  }
  if (!draftResp.ok) {
    return res.json({ ok: true, media_id: id, draft_path: null, draft_error: draftResp.error });
  }

  // Move Afshin's draft path to OUR row, then archive the row Afshin created
  // so it doesn't pollute the gallery as a separate item.
  try {
    await _composePsql(`
      UPDATE media_library
         SET draft_path = ${_qStr(draftResp.draft_path)},
             draft_cost_usd = ${draftResp.draft_cost_usd || 0}
       WHERE id = ${_qStr(id)};
      UPDATE media_library
         SET archived = true
       WHERE id = ${_qStr(draftResp.id)};
    `);
  } catch (e) {
    return res.json({ ok: true, media_id: id, draft_path: draftResp.draft_path, draft_warning: e.message });
  }

  cost.invalidate();
  res.json({
    ok: true,
    media_id: id,
    draft_path: draftResp.draft_path,
    draft_cost_usd: draftResp.draft_cost_usd,
    dimensions: dim,
  });
});

// POST /compose/approve-for-posting — Gate B
//   Body: { media_id, language: 'en'|'fa'|'ar' | 'all' }
//   Action: insert one or three scheduled_posts rows with status='ready_to_post'
//           and approved_for_posting_at = NOW(). No actual posting happens.
app.post('/compose/approve-for-posting', auth.middleware, async (req, res) => {
  const { media_id, language } = req.body || {};
  if (!media_id) return res.status(400).json({ ok: false, error: 'media_id required' });
  const requested = language === 'all' ? ['en', 'fa', 'ar'] : [language];
  if (requested.length === 0 || requested.some(l => !['en', 'fa', 'ar'].includes(l))) {
    return res.status(400).json({ ok: false, error: 'language must be en | fa | ar | all' });
  }

  // Load the media row
  let row;
  try {
    const out = await _composePsql(`
      SELECT row_to_json(m) FROM (
        SELECT id, kind, topic, captions, design_plan, render_path, draft_path
        FROM media_library WHERE id = ${_qStr(media_id)}
      ) m;`);
    row = out ? JSON.parse(out) : null;
  } catch (e) { return res.status(500).json({ ok: false, error: 'load failed: ' + e.message }); }
  if (!row) return res.status(404).json({ ok: false, error: 'media not found' });
  if (!row.captions) return res.status(400).json({ ok: false, error: 'media has no captions trio (re-run compose-ig)' });

  const insertedIds = [];
  for (const lang of requested) {
    const cap = row.captions[lang];
    if (!cap) continue;
    // Combine caption + hashtags into the post body. Most IG schedulers expect
    // hashtags appended to the caption with a blank line in between.
    const hashtagBlock = (cap.hashtags || []).join(' ');
    const fullContent = (cap.caption || '') + '\n\n' + hashtagBlock;

    // The actual table uses: asset_id (uuid, nullable), account_key (NOT NULL),
    // text (the body), media_urls (text[]). Status convention follows our flow.
    const mediaUrls = row.render_path
      ? `ARRAY[${_qStr(row.render_path)}]`
      : (row.draft_path ? `ARRAY[${_qStr(row.draft_path)}]` : `ARRAY[]::text[]`);
    const sql = `
      INSERT INTO scheduled_posts (asset_id, platform, account_key, language, scheduled_at, status,
                                    text, media_urls, compose_media_id,
                                    approved_for_posting_at, approved_for_posting_by,
                                    posting_provider)
      VALUES (NULL, 'instagram', 'rxapply_main', ${_qStr(lang)}, NOW(), 'ready_to_post',
              ${_qStr(fullContent)}, ${mediaUrls}, ${_qStr(media_id)},
              NOW(), 'founder', 'manual')
      RETURNING id::text;`;
    try {
      // psql -tA on RETURNING outputs "<uuid>\nINSERT 0 1" — take only the uuid.
      const out = await _composePsql(sql);
      const id = out.split(/[\r\n]+/)[0].trim();
      insertedIds.push({ language: lang, scheduled_post_id: id });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: `insert for ${lang} failed: ${e.message.slice(0, 200)}`,
        partial: insertedIds,
      });
    }
  }
  log(`compose.approve-posting media=${media_id.slice(0,8)} langs=${requested.join(',')}`);
  res.json({ ok: true, media_id, posts: insertedIds });
});

// GET /compose/recent — last 10 compose runs (for the "Recent posts" strip)
app.get('/compose/recent', async (_, res) => {
  try {
    const out = await _composePsql(`
      SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json)
      FROM (
        SELECT id::text, topic, draft_path, render_path, plan_approved_at::text, created_at::text,
               (captions IS NOT NULL) AS has_captions,
               (design_plan IS NOT NULL) AS has_plan
        FROM media_library
        WHERE design_plan IS NOT NULL
          AND COALESCE(archived, false) = false
        ORDER BY created_at DESC LIMIT 10
      ) s;`);
    res.json({ ok: true, items: JSON.parse(out || '[]') });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /compose/:mediaId — full row including captions + design_plan
app.get('/compose/:mediaId', async (req, res) => {
  try {
    const out = await _composePsql(`
      SELECT row_to_json(m) FROM (
        SELECT id::text, topic, kind, dimensions, captions, design_plan,
               draft_path, render_path, render_cost_usd,
               plan_approved_at::text, created_at::text, metadata
        FROM media_library WHERE id = ${_qStr(req.params.mediaId)}
      ) m;`);
    if (!out) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, item: JSON.parse(out) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Compose-IG · POST /compose/instagram (SSE) ──────────────────────────
// Body: { topic, tone? }
// Stream events:
//   open       (first byte; client knows server is responsive)
//   compose-en (caption + hashtags ready for English)
//   compose-fa (Persian)
//   compose-ar (Arabic)
//   design-plan (the shared design concept + image_prompt)
//   done       (full payload + cost; client drops into the viewer)
//   error      (any stage failure)
//
// No DB persistence happens here. The frontend POSTs to a separate
// /compose/save-plan route after the founder approves the design plan.
app.post('/compose/instagram', auth.middleware, async (req, res) => {
  const { topic, tone } = req.body || {};
  if (!topic || typeof topic !== 'string' || topic.trim().length < 4) {
    return res.status(400).json({ ok: false, error: 'topic required (≥ 4 chars)' });
  }
  if (!(await cost.canSpend(0.10))) {
    return res.status(402).json({ ok: false, error: 'monthly cost cap reached', cost: await cost.snapshot() });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');

  function emit(event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  // Resolve which model compose-ig should use for this run.
  const { id: composeModel } = agentModels.resolveModel('compose-ig');
  // Render the brand profile as a prompt block — same block goes to every
  // stage so all agents share one brand context.
  const brandBlock = brandProfile.renderAsPromptBlock();
  // K2 · Pull compose-ig's memory (semantic + procedural for voice consistency,
  // episodic for "what topics have we covered before").
  const memoryBlock = await agentMemory.renderAsBlock('compose-ig', {
    limit: 8,
    queryKeywords: String(topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5),
  });
  // K6 · Knowledge base block — verified facts grounded by detected country.
  const detectedCountry = KB.detectCountry(topic);
  const knowledgeBlock = await KB.renderAsBlock({ country: detectedCountry, query: topic, limit: 6 });

  log(`compose.ig topic="${topic.slice(0, 80)}" tone=${tone || 'hype-free'} model=${composeModel}`);
  emit('start', { topic, tone: tone || 'hype-free', model: composeModel });

  const t0 = Date.now();
  let totalCost = 0;
  let pooyaBrief = null;

  // ── Stage 1: Pooya — research brief ────────────────────────────────
  emit('stage', { stage: 'pooya', label: 'Pooya · research brief', status: 'running' });
  try {
    const pr = await composeStages.runPooyaBrief(topic);
    pooyaBrief = pr.brief;
    totalCost += pr.cost_usd;
    emit('brief', pooyaBrief);
    emit('stage', {
      stage: 'pooya', status: 'success',
      model: pr.model, cost_usd: pr.cost_usd,
      tokens: { input: pr.input_tokens, output: pr.output_tokens },
    });
  } catch (e) {
    emit('error', { stage: 'pooya', message: e.message });
    res.end();
    return;
  }

  // ── Stage 2: compose-ig — captions + design plan ────────────────────
  emit('stage', { stage: 'compose-ig', label: 'compose-ig · captions + design plan', status: 'running' });

  // We pass Pooya's brief as additional context to compose-ig by appending
  // it to the topic line — the agent's system prompt already accepts
  // arbitrary topic phrasing, and the brief sharpens what gets composed.
  const briefSummary = pooyaBrief
    ? `\n\nResearch brief from Pooya:\n${JSON.stringify(pooyaBrief, null, 2)}`
    : '';
  const enrichedTopic = topic + briefSummary;

  const child = spawn(PYTHON_BIN, [
    path.join(AGENTS_DIR, 'compose-ig', 'compose-ig.py'),
    'compose-trio',
    '--topic', enrichedTopic,
    '--tone', tone || 'hype-free',
    '--model', composeModel,
    '--brand-block', brandBlock,
    ...(memoryBlock ? ['--memory-block', memoryBlock] : []),
    ...(knowledgeBlock ? ['--knowledge-block', knowledgeBlock] : []),
  ], {
    shell: false,
    cwd: path.join(AGENTS_DIR, 'compose-ig'),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
  child.stderr.on('data', d => { stderr += d.toString('utf-8'); });

  child.on('close', async (code) => {
    if (code !== 0) {
      emit('error', { stage: 'compose-ig', message: 'compose-ig failed', exitCode: code, stderr: stderr.slice(0, 500) });
      res.end();
      return;
    }
    let result;
    try { result = JSON.parse(stdout); }
    catch (e) {
      emit('error', { stage: 'compose-ig', message: 'compose-ig output is not valid JSON', preview: stdout.slice(0, 300) });
      res.end();
      return;
    }
    totalCost += (result.shared_meta && result.shared_meta.cost_usd) || 0;

    const langs = result.languages || {};
    if (langs.en) emit('compose-en', langs.en);
    if (langs.fa) emit('compose-fa', langs.fa);
    if (langs.ar) emit('compose-ar', langs.ar);
    if (result.design_plan) emit('design-plan', result.design_plan);

    emit('stage', {
      stage: 'compose-ig', status: 'success',
      model: result.shared_meta && result.shared_meta.model,
      cost_usd: (result.shared_meta && result.shared_meta.cost_usd) || 0,
      tokens: {
        input: (result.shared_meta && result.shared_meta.input_tokens) || 0,
        output: (result.shared_meta && result.shared_meta.output_tokens) || 0,
      },
    });

    // ── Stage 3: Kherad — quality score ────────────────────────────
    emit('stage', { stage: 'kherad', label: 'Kherad · quality score', status: 'running' });
    let kheradScores = null;
    try {
      const kr = await composeStages.runKheradScore(langs);
      kheradScores = kr.scores;
      totalCost += kr.cost_usd;
      emit('scores', kheradScores);
      emit('stage', {
        stage: 'kherad', status: 'success',
        model: kr.model, cost_usd: kr.cost_usd,
        tokens: { input: kr.input_tokens, output: kr.output_tokens },
      });
    } catch (e) {
      // Don't block the compose if Kherad fails — surface as a warning,
      // user can still proceed to Gate A.
      emit('stage', { stage: 'kherad', status: 'fail', error: e.message });
    }

    cost.invalidate();
    // K2 · Auto-write compose-ig episodic memory of this run.
    try {
      await agentMemory.write({
        agent: 'compose-ig', type: 'episodic',
        content: agentMemory.summarizeForEpisodic({
          agent: 'compose-ig', action: 'compose-trio',
          output: { summary: `EN ${(result.languages?.en?.caption||'').length}c · FA ${(result.languages?.fa?.caption||'').length}c · AR ${(result.languages?.ar?.caption||'').length}c` },
          costUsd: result.shared_meta?.cost_usd,
          topic,
        }),
        tags: ['compose', 'instagram'],
        importance: 2, source: 'auto',
      });
    } catch (_) { /* non-fatal */ }

    emit('done', {
      topic: result.topic,
      tone: result.tone,
      brief: pooyaBrief,
      languages: result.languages,
      design_plan: result.design_plan,
      scores: kheradScores,
      shared_meta: { ...result.shared_meta, total_cost_usd: Math.round(totalCost * 1e6) / 1e6 },
      warnings: result._warnings || [],
      durationMs: Date.now() - t0,
    });
    res.end();
  });

  child.on('error', (e) => {
    emit('error', { stage: 'compose-ig', message: 'spawn failed: ' + e.message });
    res.end();
  });
});

app.get('/afshin/gallery', async (req, res) => {
  const opts = {};
  if (req.query.kind) opts.kind = req.query.kind;
  if (req.query.approved === 'true')  opts.approved = true;
  if (req.query.approved === 'false') opts.approved = false;
  if (req.query.limit) opts.limit = parseInt(req.query.limit, 10);
  res.json({ ok: true, items: await afshin.gallery(opts), kinds: Object.keys(afshin.KIND_SPECS) });
});

// Serve generated assets (drafts SVG + renders PNG) read-only.
app.use('/assets/generated', express.static(afshin.ASSETS_ROOT));

// Serve bundled vendor libraries (Drawflow etc.) from cowork-proxy/public/.
// Fixes broken jsdelivr/unpkg CDN access on networks that block them.
app.use('/static', express.static(path.resolve(__dirname, 'public')));

// Object-storage proxy. Used for the local-disk fallback in dev, and as
// an authenticated read path for any future private R2 buckets. When
// R2_PUBLIC_URL is configured, the dashboard fetches assets directly
// from the CDN and this route is rarely hit.
app.get('/storage/*', storage.serveHandler);

// Serve dashboard.html at /dashboard so we can hit it from a real http:// origin
// (Chrome extensions + the Claude-in-Chrome MCP can't access file:// URLs).
app.get('/dashboard', (_, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'dashboard.html'));
});

// ── F9 · Cost telemetry ─────────────────────────────────────────────────
app.get('/cost', async (_, res) => {
  try {
    res.json({ ok: true, ...(await cost.snapshot()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── F5 · Agent chat (Anthropic streaming) ───────────────────────────────
// POST /agent/:name/chat  body:{ message, chat_id? }
//   Streams Server-Sent Events:
//     event: token       data: { text }
//     event: usage       data: { input_tokens, output_tokens }
//     event: done        data: { chat_id, cost_usd, model }
//     event: error       data: { error }
//
// GET  /agent/:name/chats  — list past chats for this agent
// GET  /agent/:name/chats/:chat_id  — full chat with messages
app.post('/agent/:name/chat', async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  if (!anthropicChat.isConfigured()) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
  const message = req.body && req.body.message;
  const chatId  = req.body && req.body.chat_id;
  if (!message) return res.status(400).json({ error: 'send {message}' });

  // F9 cap check (estimate ~$0.05 max for a typical 4k-token response)
  if (!(await cost.canSpend(0.05))) {
    const snap = await cost.snapshot();
    return res.status(402).json({ error: 'monthly cost cap reached', cost: snap });
  }

  // SSE setup.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Initial flush so browsers know we're streaming.
  res.write(': open\n\n');

  function send(event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (_) { /* socket might be closed */ }
  }

  log(`agent.chat agent=${name} chatId=${chatId || 'new'} msgLen=${message.length}`);

  try {
    await anthropicChat.streamChat({
      agent: name,
      userMessage: message,
      chatId,
      onText:  (t)   => send('token', { text: t }),
      onUsage: (u)   => send('usage', u),
      onError: (e)   => { send('error', { error: (e.message || String(e)).slice(0, 500) }); res.end(); },
      onDone:  (m)   => { send('done', { chat_id: m.chatId, cost_usd: m.costUsd, model: m.model, usage: m.usage }); res.end(); },
    });
  } catch (e) {
    send('error', { error: e.message || String(e) });
    res.end();
  }
});

app.get('/agent/:name/chats', async (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  res.json({ ok: true, chats: await anthropicChat.listChats(name, parseInt(req.query.limit, 10) || 20) });
});

app.get('/agent/:name/chats/:chatId', async (req, res) => {
  const { name, chatId } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const c = await anthropicChat.getChat(chatId);
  if (!c) return res.status(404).json({ error: 'chat not found' });
  res.json({ ok: true, chat: c });
});

// ── F4 · n8n workflow control ───────────────────────────────────────────
app.get('/n8n/workflows', async (req, res) => {
  const r = await n8nCtl.listWorkflows({ active: req.query.active != null ? req.query.active === 'true' : null });
  if (!r.ok) return res.status(r.status || 502).json(r);
  res.json(r);
});

app.get('/n8n/workflows/library', (_, res) => {
  res.json({ ok: true, files: n8nCtl.libraryList() });
});

app.get('/n8n/workflows/:id', async (req, res) => {
  const r = await n8nCtl.getWorkflow(req.params.id);
  if (!r.ok) return res.status(r.status || 502).json(r);
  res.json(r);
});

app.patch('/n8n/workflows/:id/active', auth.middleware, async (req, res) => {
  const active = !!(req.body && req.body.active);
  const r = await n8nCtl.setActive(req.params.id, active);
  log(`n8n.setActive id=${req.params.id} active=${active} ok=${r.ok}`);
  if (!r.ok) return res.status(r.status || 502).json(r);
  res.json(r);
});

app.post('/n8n/workflows/:id/run', auth.middleware, async (req, res) => {
  const r = await n8nCtl.runWorkflow(req.params.id);
  log(`n8n.run id=${req.params.id} ok=${r.ok}`);
  if (!r.ok) return res.status(r.status || 502).json(r);
  res.json(r);
});

app.post('/n8n/workflows/import', auth.middleware, async (req, res) => {
  const filename = req.body && req.body.filename;
  if (!filename) return res.status(400).json({ error: 'send {filename}' });
  const r = await n8nCtl.importFromLibrary(filename);
  log(`n8n.import filename=${filename} ok=${r.ok}`);
  if (!r.ok) return res.status(r.status || 502).json(r);
  res.json(r);
});

app.get('/n8n/executions', async (req, res) => {
  const r = await n8nCtl.listExecutions({ workflowId: req.query.workflow_id || null,
                                           limit: parseInt(req.query.limit, 10) || 20 });
  if (!r.ok) return res.status(r.status || 502).json(r);
  res.json(r);
});

// ── F6 · Visual pipeline editor ──────────────────────────────────────────
// GET  /pipelines                  — list saved pipelines
// POST /pipelines                  — save/update { name, description, graphData }
// GET  /pipelines/:name            — load one pipeline
// DELETE /pipelines/:name          — delete
// POST /pipelines/:name/run        — SSE stream of execution progress

app.get('/pipelines', (_, res) => {
  try {
    res.json({ ok: true, pipelines: pipelineRunner.listPipelines() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/pipelines', auth.middleware, async (req, res) => {
  const { name, description, graphData } = req.body || {};
  const r = await pipelineRunner.savePipeline({ name, description, graphData });
  if (!r.ok) return res.status(400).json(r);
  log(`pipelines.save name=${name} nodes=${r.nodeCount}`);
  res.json(r);
});

app.get('/pipelines/:name', (req, res) => {
  const r = pipelineRunner.loadPipeline(req.params.name);   // file-only read; sync
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
});

app.delete('/pipelines/:name', auth.middleware, async (req, res) => {
  const r = await pipelineRunner.deletePipeline(req.params.name);
  if (!r.ok) return res.status(404).json(r);
  log(`pipelines.delete name=${req.params.name}`);
  res.json(r);
});

// IMPORTANT: /pipelines/run MUST be registered before /pipelines/:name/run
// (Express matches in order; ":name" would otherwise capture "run").
app.post('/pipelines/run', auth.middleware, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');
  function emit(event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }
  log(`pipelines.run inline`);
  try {
    await pipelineRunner.runPipeline({ graphData: req.body && req.body.graphData }, emit);
  } catch (e) {
    emit('error', { message: e.message });
  }
  res.end();
});

app.post('/pipelines/:name/run', auth.middleware, async (req, res) => {
  // SSE stream of pipeline execution.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');

  function emit(event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  log(`pipelines.run name=${req.params.name}`);
  try {
    const inlineGraph = req.body && req.body.graphData;
    await pipelineRunner.runPipeline({ name: req.params.name, graphData: inlineGraph }, emit);
  } catch (e) {
    emit('error', { message: e.message });
  }
  res.end();
});

// GET /agents — list known agent folders
app.get('/agents', (_, res) => {
  if (!fs.existsSync(AGENTS_DIR)) return res.json({ ok: true, agents: [], dir: AGENTS_DIR });
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents = entries
    .filter(d => d.isDirectory() && AGENT_NAME_RE.test(d.name))
    .map(d => {
      const dir = path.join(AGENTS_DIR, d.name);
      const hasSkill = fs.existsSync(path.join(dir, 'SKILL.md'));
      const helperPath = path.join(dir, `${d.name}.py`);
      const hasHelper = fs.existsSync(helperPath);
      return { agent: d.name, dir, hasSkill, hasHelper };
    });
  res.json({ ok: true, count: agents.length, agents });
});

// ── start ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 7777;
// T1 · Tools framework — mount the router and seed the catalog into Postgres
// on boot so the UI's catalog list never lags behind the registry.
app.use('/tools', toolsRouter);

// Boot sequence: migrate → refresh caches → start listening.
//   1. migrate.runIfNeeded() applies any pending SQL migrations. Set
//      MIGRATE_ON_BOOT=false in env to skip (e.g. if you're applying
//      migrations from CI instead).
//   2. _refreshFirstRun() seeds the first-run cache so middleware doesn't
//      block on a cold call.
//   3. tools registry sync.
(async () => {
  try {
    const r = await migrate.runIfNeeded();
    if (r && r.failed) console.error(`[boot] migration FAILED: ${r.failed.error || r.failed}`);
  } catch (e) { console.error(`[boot] migrate.runIfNeeded threw: ${e.message}`); }
  await _refreshFirstRun();
  try {
    const n = await toolsRegistry.sync();
    console.log(`  tools registry: synced ${n} tools to Postgres`);
  } catch (e) { console.error(`  tools registry sync failed: ${e.message}`); }
})();

app.listen(PORT, () => {
  console.log(`cowork-proxy listening on :${PORT}`);
  console.log(`  mode=${MODE}  llm=anthropic-api-direct  pythonBin=${PYTHON_BIN}`);
  console.log(`  agentsDir=${AGENTS_DIR}`);
  console.log(`  routes: /health, /run-agent, /run-agents-parallel, /run-helper,`);
  console.log(`          /prompts/:agent (GET,PUT), /prompts/:agent/versions, /agents`);
  console.log(`          /logs, /logs/:runid, /logs/:runid/download                (F2)`);
  console.log(`          /auth/{login,logout,status,set-password}, /settings        (F7)`);
  console.log(`          auth initialized: ${auth.isInitialized()}`);
  // Confirm what dotenv pulled in. Mask the values — only show presence.
  const present = (v) => v ? `\x1b[32m✓ set (${v.slice(0,8)}…${v.slice(-4)})\x1b[0m` : `\x1b[31m✕ NOT SET\x1b[0m`;
  console.log(`  env keys:`);
  console.log(`    ANTHROPIC_API_KEY  ${present(process.env.ANTHROPIC_API_KEY)}`);
  console.log(`    OPENAI_API_KEY     ${present(process.env.OPENAI_API_KEY)}`);
  console.log(`    N8N_API_KEY        ${present(process.env.N8N_API_KEY)}`);
  log(`startup port=${PORT} mode=${MODE} authInit=${auth.isInitialized()} anth=${!!process.env.ANTHROPIC_API_KEY} openai=${!!process.env.OPENAI_API_KEY} n8n=${!!process.env.N8N_API_KEY}`);

  // F2 · run log retention (gzip >7d, delete >30d). Idempotent.
  try {
    const r = logWriter.cleanupOldLogs();
    if (r.gzipped || r.deleted) {
      console.log(`  log retention: gzipped=${r.gzipped} deleted=${r.deleted}`);
    }
  } catch (e) { console.warn('  log retention skipped:', (e.message || '').slice(0, 200)); }

  // F7 · prune expired auth sessions every 30 min.
  setInterval(() => {
    const removed = auth.pruneExpired();
    if (removed > 0) log(`auth.prune removed=${removed}`);
  }, 30 * 60 * 1000);
});
