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
const unsplash = require('./unsplash');                 // M64 · Unsplash stock photos
const pipelineRunner = require('./pipeline-runner');  // F6 · visual pipeline editor
const agentModels = require('./agent-models');         // per-agent LLM overrides
const brandProfile = require('./brand-profile');       // central brand spec
const composeStages = require('./compose-stages');     // Pooya brief + Kherad score (legacy IG, deprecated by M24)
const composeOrchestrator = require('./compose-orchestrator');  // M24 · recipe-driven multi-format orchestrator
const evalHarness = require('./eval-harness');                  // M43 · pairwise eval judge
const watchdog = require('./regulatory-watchdog');              // M46 · regulatory drift watchdog
const dmTriage = require('./dm-triage');                        // M47 · DM intent triage + reply draft
const fanout = require('./fanout');                             // M48 · 1 source → N channel fan-out
const memMaint = require('./memory-maintenance');               // M51 · memory decay + promotion
const brandInt = require('./brand-intelligence');               // M55 · dynamic agent training data
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
const canva         = require('./canva');              // M103 · Canva Connect API client (compose Mode B)

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
// Shorthand model aliases. The legacy CLI accepted `sonnet`/`opus`/`haiku`;
// kept for back-compat but mapped to the M16 flagship roster. Anything that
// looks like a real model id (contains `/` or starts with `claude-`/`gpt-`/`o3`)
// passes through unchanged.
const MODEL_ALIASES = {
  sonnet:  'claude-sonnet-4-6',
  opus:    'claude-opus-4-7',
  haiku:   'claude-sonnet-4-6',     // haiku dropped in M16 — alias falls back to balanced flagship
  gpt:     'gpt-5.5',
  reason:  'o3',
};

const llm = require('./llm');

// runLLM — provider-agnostic one-shot LLM call. Replaces the old
// `runClaude` (which was Anthropic-only). Same input/output shape so
// existing callers (/run-agent, /run-agents-parallel) work unchanged.
//
// Returns: { output, model, usage }
// Rejects:  { code, error }
async function runLLM({ prompt, model = 'claude-sonnet-4-6' }) {
  const resolved = MODEL_ALIASES[model] || model;
  try {
    const r = await llm.chat({
      model: resolved,
      messages: [{ role: 'user', content: String(prompt || '') }],
      maxTokens: parseInt(process.env.LLM_MAX_TOKENS, 10) || 4096,
    });
    return { output: r.output, model: r.model, usage: r.usage };
  } catch (e) {
    return Promise.reject({ code: e.code || -1, error: (e && e.message) || String(e) });
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

// ── routes ──────────────────────────────────────────────────────────────────
//
// The first-run wizard (v0.1) was removed in M14 once the founder finished
// setup. Re-enabling it would require reverting that commit. New deploys
// going forward bootstrap by either:
//   1. Setting auth_password_hash directly via a one-off `psql` insert,
//   2. Or temporarily setting AUTH_DISABLED=1 to access /settings via the
//      dashboard and changing the password from there.
// Reason for removal: the wizard was an unauthenticated entry point that
// became a perpetual attack surface once setup was done.

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

// /setup and /setup/api/* deleted in M14. They were the unauthenticated
// bootstrap surface; once the founder finished the wizard they were just
// attack surface (a stray `UPDATE dashboard_settings SET first_run_done=false`
// would re-enable them). To re-onboard a fresh deploy: revert M14, redeploy,
// run the wizard, then re-apply M14.

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
    // M101b · Image-pipeline env diagnostics — visible to the founder via
    // GET /health so you can confirm whether Unsplash is wired without
    // grepping Railway logs.
    unsplash: !!process.env.UNSPLASH_ACCESS_KEY,
    // M103 · Canva mode B. True when CANVA_API_TOKEN is in env (the DB
    // fallback isn't reflected here — that's reported via /canva/health).
    canva: !!process.env.CANVA_API_TOKEN,
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
    const { output } = await runLLM({ prompt, model });
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
    agents.map(a => runLLM({ prompt: a.prompt, model: a.model || 'sonnet' })
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

// ── M68 · Per-agent stage prompt endpoints ──────────────────────────
// One file per (agent, stage) at agents/<agent>/stages/<stage>.md.
// These are the per-stage instructions the orchestrator injects after
// the agent's SKILL.md. Edit here once, every Compose run that routes
// the stage to this agent picks up the change on next call.
//
// GET    /agents/:agent/stages           → list stage files for this agent
// GET    /agents/:agent/stages/:stage    → returns markdown body
// PUT    /agents/:agent/stages/:stage    → body {markdown:"..."} → writes file + invalidates cache
const STAGE_NAME_RE = /^[a-z][a-z0-9_-]{0,40}$/;

app.get('/agents/:agent/stages', (req, res) => {
  const { agent } = req.params;
  if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ error: 'invalid agent name' });
  const dir = path.join(AGENTS_DIR, agent, 'stages');
  if (!fs.existsSync(dir)) return res.json({ ok: true, agent, stages: [] });
  try {
    const stages = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const stage = f.replace(/\.md$/, '');
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        return { stage, path: fp, bytes: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => a.stage.localeCompare(b.stage));
    res.json({ ok: true, agent, count: stages.length, stages });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/agents/:agent/stages/:stage', (req, res) => {
  const { agent, stage } = req.params;
  if (!AGENT_NAME_RE.test(agent))   return res.status(400).json({ error: 'invalid agent name' });
  if (!STAGE_NAME_RE.test(stage))   return res.status(400).json({ error: 'invalid stage name' });
  const fp = path.join(AGENTS_DIR, agent, 'stages', `${stage}.md`);
  if (!fs.existsSync(fp))           return res.status(404).json({ error: 'stage file not found', path: fp });
  fs.readFile(fp, 'utf-8', (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      ok: true, agent, stage, path: fp,
      markdown: data, chars: data.length, bytes: Buffer.byteLength(data, 'utf-8'),
    });
  });
});

app.put('/agents/:agent/stages/:stage', auth.middleware, async (req, res) => {
  const { agent, stage } = req.params;
  if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ error: 'invalid agent name' });
  if (!STAGE_NAME_RE.test(stage)) return res.status(400).json({ error: 'invalid stage name' });

  let markdown, reason = null;
  if (Buffer.isBuffer(req.body))           markdown = req.body.toString('utf-8');
  else if (typeof req.body === 'string')   markdown = req.body;
  else if (req.body && typeof req.body.markdown === 'string') {
    markdown = req.body.markdown;
    reason = req.body.reason || null;
  } else return res.status(400).json({ error: 'send {markdown:"..."} or raw text body' });

  if (!markdown.trim().startsWith('---')) {
    return res.status(400).json({
      error: 'stage file must start with YAML frontmatter (---)',
      hint: 'frontmatter must include at least: agent + stage',
    });
  }

  const dir = path.join(AGENTS_DIR, agent, 'stages');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${stage}.md`);

  try {
    fs.writeFileSync(fp, markdown, 'utf-8');
    composeOrchestrator._invalidateStagePromptCache(agent, stage);
    // M68 ships file-only; full DB-backed versioning of stage edits lands
    // alongside Pipeline tab v2 (M72) where the version-history UI lives.
    log(`stage.put agent=${agent} stage=${stage} chars=${markdown.length} reason=${reason || '-'}`);
    res.json({ ok: true, agent, stage, path: fp, chars: markdown.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M79 · Agent operating-surface endpoints ──────────────────────────
// Single-call data fetch: everything that defines this agent's behavior,
// in one payload. Powers the rebuilt Agents tab (M79) which is the
// founder's only place to see/edit agent state — no hidden inputs.
app.get('/agents/:agent/full-context', async (req, res) => {
  try {
    const { agent } = req.params;
    if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ ok: false, error: 'invalid agent name' });
    const agentDir = path.join(AGENTS_DIR, agent);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ ok: false, error: 'agent not found' });

    // 1. SKILL.md
    let skill_md = null;
    try {
      const sp = path.join(agentDir, 'SKILL.md');
      if (fs.existsSync(sp)) skill_md = fs.readFileSync(sp, 'utf8');
    } catch (_) {}

    // 2. Stage files this agent owns
    const stagesDir = path.join(agentDir, 'stages');
    let stages = [];
    if (fs.existsSync(stagesDir)) {
      try {
        stages = fs.readdirSync(stagesDir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            const stage = f.replace(/\.md$/, '');
            const fp = path.join(stagesDir, f);
            const stat = fs.statSync(fp);
            const body = fs.readFileSync(fp, 'utf8');
            return { stage, path: fp, bytes: stat.size, mtime: stat.mtime.toISOString(), markdown: body };
          })
          .sort((a, b) => a.stage.localeCompare(b.stage));
      } catch (_) {}
    }

    // 3. Capabilities + agents-section grouping (from agent-capabilities.js)
    let capabilities = [];
    try {
      const caps = require('./agent-capabilities');
      capabilities = caps.capabilitiesFor(agent) || [];
    } catch (_) {}

    // 4. Constitution rules — brand_intelligence with importance >= 5
    //    (target this agent OR null = applies-to-all). M58/M76 wiring.
    let rules = [];
    try {
      rules = await queryRows(`
        SELECT id::text, kind, target_agent, scope_platform, scope_language,
                rule_text, importance, topic_tags, source, founder_edited, enabled
          FROM brand_intelligence
         WHERE enabled = TRUE
           AND (target_agent = ${q(agent)} OR target_agent IS NULL)
         ORDER BY importance DESC, founder_edited DESC, updated_at DESC
         LIMIT 200;`);
    } catch (_) {}

    // 5. Exemplars — by inferred kind from agent's capabilities (e.g.
    //    Sepehr → post_caption; Afshin → design_brief).
    let exemplars = [];
    try {
      const STAGE_EXEMPLAR_KIND = require('./agent-training-retrieval').STAGE_EXEMPLAR_KIND || {};
      const myKinds = new Set();
      for (const cap of capabilities) {
        const k = STAGE_EXEMPLAR_KIND && STAGE_EXEMPLAR_KIND[cap];
        if (k) myKinds.add(k);
        // Also try direct stage-name lookup (carousel-plan → design_brief)
      }
      // Fallback: include the few common kinds if no map hit
      if (myKinds.size === 0) {
        if (capabilities.includes('draft')) myKinds.add('post_caption');
        if (capabilities.includes('design')) myKinds.add('design_brief');
        if (capabilities.includes('carousel-plan')) myKinds.add('design_brief');
        if (capabilities.includes('reply-draft')) myKinds.add('dm_reply');
        if (capabilities.includes('triage')) myKinds.add('intent_example_hot');
      }
      if (myKinds.size > 0) {
        const kindsArr = Array.from(myKinds).map(k => `'${String(k).replace(/'/g, "''")}'`).join(',');
        exemplars = await queryRows(`
          SELECT id::text, kind, platform, language, body, context, importance,
                  outcome, topic_tags, source
            FROM brand_exemplars
           WHERE enabled = TRUE AND kind IN (${kindsArr})
           ORDER BY importance DESC, updated_at DESC
           LIMIT 50;`);
      }
    } catch (_) {}

    // 6. Memory entries
    let memory = [];
    try {
      memory = await agentMemory.list(agent, { limit: 100 });
    } catch (_) {}

    // 7. KPIs (last 30 days)
    let kpis = null;
    try { kpis = await agentEvals.getKPIsForAgent(agent, 30); } catch (_) {}

    // 8. Pipelines this agent appears in (capability resolution from agent-capabilities)
    let pipelines_appearing_in = [];
    try {
      const pipelines = require('./pipelines');
      const allPipes = pipelines.listCachedSync ? pipelines.listCachedSync() : [];
      for (const p of allPipes) {
        const pStages = (p.definition && p.definition.stages) || [];
        const matches = [];
        for (const s of pStages) {
          if (s.default_agent === agent) {
            matches.push({ stage: s.name, why: 'pinned' });
          } else if (s.capability && capabilities.includes(s.capability)) {
            matches.push({ stage: s.name, why: 'capability' });
          }
        }
        if (matches.length) {
          pipelines_appearing_in.push({ pipeline_id: p.id, label: p.label, stages: matches });
        }
      }
    } catch (_) {}

    res.json({
      ok: true,
      agent,
      skill_md,
      stages,
      capabilities,
      rules,
      exemplars,
      memory,
      kpis,
      pipelines_appearing_in,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /agents/:agent/prompt-preview {stage, platform, language, topic}
// Returns the EXACT system prompt the agent will see at runtime, with
// each block annotated by source so the founder knows where every line
// came from (skill / stage / rule / exemplar / memory / refine notes).
// This is THE feature for "no hidden instructions."
app.post('/agents/:agent/prompt-preview', async (req, res) => {
  try {
    const { agent } = req.params;
    if (!AGENT_NAME_RE.test(agent)) return res.status(400).json({ ok: false, error: 'invalid agent name' });
    const body = req.body || {};
    const stageName = body.stage || 'draft';
    const platform = body.platform || null;
    const language = body.language || 'fa';
    const topic = body.topic || '';

    const blocks = [];

    // Block 1 · SKILL.md
    try {
      const sp = path.join(AGENTS_DIR, agent, 'SKILL.md');
      if (fs.existsSync(sp)) {
        const md = fs.readFileSync(sp, 'utf8');
        if (md.trim()) blocks.push({ source: 'skill', label: `${agent} · SKILL.md`, text: `# ${agent}'s base brief\n${md}`, editable_at: `/agents/${agent} (SKILL.md)` });
      }
    } catch (_) {}

    // Block 2 · per-agent stage file (or fallback warning)
    try {
      const co = require('./compose-orchestrator');
      const stagePrompt = co._loadStagePrompt(agent, stageName);
      if (stagePrompt) {
        blocks.push({ source: 'stage_file', label: `${agent}/stages/${stageName}.md`, text: `# This stage: ${stageName}\n${stagePrompt}`, editable_at: `agents/${agent}/stages/${stageName}.md (Pipeline tab → click stage)` });
      } else {
        // M80 · Surface the fallback so the founder knows a per-agent file is missing
        blocks.push({
          source: 'stage_fallback_warning',
          label: `⚠ No per-agent stage file — orchestrator will use hardcoded default for "${stageName}"`,
          text: `No file found at agents/${agent}/stages/${stageName}.md.\nThe orchestrator will fall back to the hardcoded default in compose-orchestrator.js#_DEFAULT_STAGE_PROMPTS.\nCreate the file via the Pipeline tab to take full control.`,
          editable_at: `Create agents/${agent}/stages/${stageName}.md`,
        });
      }
    } catch (_) {}

    // Block 3 · brand profile
    try {
      const brandProfile = require('./brand-profile');
      const block = brandProfile.renderAsPromptBlock();
      if (block) blocks.push({ source: 'brand_profile', label: 'Brand profile (singleton)', text: block, editable_at: '/brand-profile' });
    } catch (_) {}

    // Block 4 · KB grounding (only injected for certain stages)
    if (['research', 'verify', 'verify-translation', 'draft', 'critique', 'audit'].includes(stageName)) {
      try {
        const KB = require('./knowledge-base');
        const country = KB.detectCountry(topic);
        const kb = KB.renderAsBlock({ country, query: topic, limit: 6 });
        if (kb) blocks.push({ source: 'knowledge_base', label: `Knowledge base (country=${country}, topic=${(topic || '').slice(0, 50)})`, text: kb, editable_at: '/knowledge' });
      } catch (_) {}
    }

    // Block 4b · M80 · Protected-terms glossary (auto-derived from KB)
    // Only injected for translate / verify-translation stages. Show its
    // derivation logic so the founder knows where each term came from.
    if (['translate', 'verify-translation'].includes(stageName)) {
      try {
        const KBProtected = require('./kb-protected-terms');
        const block = await KBProtected.renderAsPromptBlock();
        const meta = await KBProtected.get();
        if (block) {
          blocks.push({
            source: 'protected_terms',
            label: `Protected terms (${meta.n_total} terms · ${meta.n_explicit} explicit + ${meta.n_heuristic} heuristic — auto-derived from KB)`,
            text: `${block}\n\n--- DERIVATION (M80 surfaced) ---\nTerms come from two sources:\n  1. Explicit metadata.protected_terms in KB documents (${meta.n_explicit} terms)\n  2. Heuristic ALL-CAPS scan with stoplist + recurrence ≥3 (${meta.n_heuristic} terms)\nGenerated at: ${meta.generated_at} · Cache TTL: 1 hour`,
            editable_at: 'Edit KB documents → metadata.protected_terms; cache refreshes hourly',
          });
        }
      } catch (_) {}
    }

    // Block 4c · M80 · Recipe template variables surfaced
    // The orchestrator silently substitutes {{recipe.X}} and {{run.Y}} in
    // stage prompts. Show what they expand to so the founder knows.
    if (platform) {
      try {
        const composeOrch = require('./compose-orchestrator');
        const recipe = composeOrch.getRecipe(platform);
        if (recipe) {
          const vars = [];
          if (recipe.label) vars.push(`{{recipe.label}} → "${recipe.label}"`);
          if (recipe.length_target_words) vars.push(`{{recipe.length_target_words}} → "${recipe.length_target_words}"`);
          if (language) vars.push(`{{run.master_lang}} → "${language}"`);
          // Stage params
          const stageDef = (recipe.stages || []).find(s => s.name === stageName);
          if (stageDef && stageDef.params) {
            for (const [k, v] of Object.entries(stageDef.params)) {
              vars.push(`recipe.stages[${stageName}].params.${k} → ${JSON.stringify(v)}`);
            }
          }
          if (vars.length) {
            blocks.push({
              source: 'recipe_template_vars',
              label: `Recipe template substitutions (${platform})`,
              text: `These values get substituted into the stage prompt template at runtime:\n${vars.join('\n')}`,
              editable_at: `Pipeline tab → ${platform}`,
            });
          }
        }
      } catch (_) {}
    }

    // Block 5 · M56 unified retrieval (rules + exemplars + memory + conflicts)
    try {
      const trainingRetrieval = require('./agent-training-retrieval');
      const topicTags = trainingRetrieval.expandTopicTags ? trainingRetrieval.expandTopicTags(topic) : [];
      const packet = await trainingRetrieval.getTrainingPacket({
        agent, stageName, platform, language, topicTags,
      });
      if (packet.rules && packet.rules.length) {
        blocks.push({ source: 'brand_rules', label: `Brand intelligence (${packet.rules.length} rules — ${packet.budget?.rules || '?'} budget)`, text: packet.rules.map(r => `[imp=${r.importance}] ${r.rule_text}`).join('\n'), editable_at: '/brand', items: packet.rules });
      }
      if (packet.exemplars && packet.exemplars.length) {
        blocks.push({ source: 'brand_exemplars', label: `Reference exemplars (${packet.exemplars.length})`, text: packet.exemplars.map(e => `--- ${e.kind}${e.outcome ? ` · ${e.outcome}` : ''} ---\n${e.body}`).join('\n\n'), editable_at: '/brand/exemplars', items: packet.exemplars });
      }
      if (packet.memories && packet.memories.length) {
        blocks.push({ source: 'agent_memory', label: `${agent}'s memory (${packet.memories.length})`, text: packet.memories.map(m => `[${m.type}] ${m.content}`).join('\n'), editable_at: `/agents/${agent}/memory`, items: packet.memories });
      }
      if (packet.conflicts && packet.conflicts.length) {
        blocks.push({ source: 'conflicts', label: `⚠ Conflicts auto-detected (${packet.conflicts.length})`, text: packet.conflicts.map(c => `Global rule: "${c.rule.rule_text}"\nYour correction: "${c.memory.content}"`).join('\n\n'), editable_at: '/brand AND /agents/' + agent + '/memory' });
      }
      if (packet.rating_signal) {
        const rs = packet.rating_signal;
        const lines = [`📊 Recent founder feedback`];
        lines.push(`Last ${rs.window_days} days: ${rs.n} ratings · avg ${rs.avg}/5${rs.low_count ? ` · ${rs.low_count} low-rated (≤2)` : ''}`);
        if (rs.recent_low?.length) {
          lines.push(`Examples to learn from:`);
          for (const r of rs.recent_low) lines.push(`  · ${r.score}/5${r.note ? ` — "${(r.note || '').slice(0, 200)}"` : ''}`);
        }
        blocks.push({ source: 'rating_signal', label: `M58 rating signal (${rs.n} ratings)`, text: lines.join('\n'), editable_at: 'agent_evals (read-only — derived)' });
      }
    } catch (e) {
      blocks.push({ source: 'error', label: 'retrieval failed', text: String(e.message), editable_at: null });
    }

    const full_text = blocks.map(b => `# [${b.source}] ${b.label}\n${b.text}`).join('\n\n────────────────────────────────────────────────\n\n');

    res.json({
      ok: true,
      agent,
      stage: stageName,
      platform, language, topic,
      blocks,
      full_text,
      total_chars: full_text.length,
      block_count: blocks.length,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M84 · Moallem trainer endpoints ──────────────────────────────────
// Lists proposals, runs detection, approves/rejects.
const moallem = require('./moallem-trainer');

app.get('/trainer/proposals', async (req, res) => {
  try {
    const items = await moallem.listProposals({
      status: req.query.status || 'pending',
      agent: req.query.agent || null,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ ok: true, count: items.length, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/trainer/proposals/:id', async (req, res) => {
  try {
    const p = await moallem.getProposal(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'proposal not found' });
    res.json({ ok: true, proposal: p });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /trainer/run — manual trigger; runs Moallem against last N days
app.post('/trainer/run', auth.middleware, async (req, res) => {
  try {
    const daysBack = parseInt((req.body && req.body.daysBack) || 30, 10);
    const r = await moallem.detectPatterns({ daysBack });
    if (!r.ok) return res.status(500).json(r);
    log(`moallem.run daysBack=${daysBack} examined=${r.n_examined} proposed=${r.n_proposed}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/trainer/proposals/:id/approve', auth.middleware, async (req, res) => {
  try {
    const note = req.body && req.body.note;
    const r = await moallem.approveProposal(req.params.id, {
      note,
      decidedBy: (req.user && req.user.username) || 'founder',
    });
    if (!r.ok) return res.status(400).json(r);
    log(`moallem.approve ${req.params.id.slice(0, 8)} → ${r.applied_to}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/trainer/proposals/:id/reject', auth.middleware, async (req, res) => {
  try {
    const note = req.body && req.body.note;
    const r = await moallem.rejectProposal(req.params.id, { note });
    if (!r.ok) return res.status(400).json(r);
    log(`moallem.reject ${req.params.id.slice(0, 8)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

app.post('/auth/logout', async (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const m = /(?:^|;\s*)rxapply_session=([^;]+)/.exec(cookieHeader);
  const token = (m && decodeURIComponent(m[1])) || (req.headers.authorization || '').replace(/^Bearer\s+/, '') || null;
  await auth.logout(token);
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

// ── Health Monitor (M18 · was F3 service control) ──────────────────────
// GET  /services         → all probes (database, storage, anthropic, openai, process)
// GET  /services/:name   → single probe
// POST /services/:name/:action → 410 Gone (Railway can't shell out to docker)
const SERVICE_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

app.get('/services', async (_, res) => {
  try {
    const r = await services.probeAll();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/services/:name', async (req, res) => {
  const name = req.params.name;
  if (!SERVICE_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid service name' });
  try {
    const r = await services.probe(name);
    if (r.error && /unknown service/.test(r.error)) return res.status(404).json({ ok: false, error: r.error });
    res.json({ ok: true, name, status: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Start / stop / restart — gone in cloud build. Returns 410 with a hint.
app.post('/services/:name/:action', auth.middleware, (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'service_actions_removed_in_cloud',
    note: 'This deploy runs on Railway, not local Docker. Use Railway dashboard for restart, Supabase Cloud dashboard for DB pause, etc. The /services endpoint is now a read-only health monitor.',
  });
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
// M42 · Cost-aware router diagnostic — what would the router pick + why?
//   GET /agent-models/router-status?agent=<name>&capability=<cap>
app.get('/agent-models/router-status', async (req, res) => {
  try {
    const router = require('./cost-aware-router');
    const agent = req.query.agent || null;
    const capability = req.query.capability || null;
    if (!agent || !capability) {
      return res.json({
        ok: true,
        floors: router.FLOORS,
        quality_bar: router.QUALITY_BAR,
        window_days: router.WINDOW_DAYS,
        usage: 'pass ?agent=...&capability=... for an explanation of the router pick',
      });
    }
    const r = await router.reasonFor({ agent, capability });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Force a refresh of the router's rolling-stats cache (call after rating bursts).
app.post('/agent-models/router-refresh', auth.middleware, (_req, res) => {
  try {
    const router = require('./cost-aware-router');
    router.refresh();
    res.json({ ok: true, refreshed_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

// ── M91 · Unified inbox · /inbox/all ────────────────────────────────
// Aggregates EVERY pending decision into one queue, sorted by urgency:
//   1. Gated compose runs (status=awaiting_approval)
//   2. Refine cap_reached runs
//   3. Hot DM intents (M47)
//   4. Training proposals pending (M84 Moallem)
//   5. Regulatory drift events pending (M46)
//   6. Media library awaiting approval (designs)
//   7. K4 handoffs pending
//   8. K1 action approvals (legacy)
//
// Each card is typed with: { kind, id, title, sub, urgency, action_label,
// detected_at, link } — frontend renders uniform cards with kind-specific
// pills. /inbox/count-all returns total across all sources.
app.get('/inbox/all', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const cards = [];

    // 1. Gated compose runs — highest urgency (founder mid-flow)
    try {
      const rows = await queryRows(`
        SELECT id::text, recipe_id, topic, status, current_stage,
                refine_status, refine_attempts,
                created_at::text, started_at::text
          FROM compose_runs
         WHERE status IN ('awaiting_approval', 'gated')
           AND created_at >= NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC LIMIT 30;`);
      for (const r of rows) {
        const refineN = Array.isArray(r.refine_attempts) ? r.refine_attempts.length : 0;
        const isCap = r.refine_status === 'cap_reached';
        cards.push({
          kind: isCap ? 'refine_cap' : 'gated_run',
          id: r.id,
          title: r.topic || '(no topic)',
          sub: `${r.recipe_id} · ${r.current_stage || 'unknown stage'}${refineN ? ` · ${refineN} refine attempt${refineN===1?'':'s'}` : ''}`,
          urgency: isCap ? 'high' : 'high',
          action_label: isCap ? 'Review (cap reached)' : 'Approve',
          detected_at: r.created_at,
          link: { tab: 'compose', run_id: r.id },
        });
      }
    } catch (_) {}

    // 2. Training proposals pending (Moallem)
    try {
      const rows = await queryRows(`
        SELECT id::text, target_agent, pattern_summary, confidence, detected_at::text
          FROM training_proposals
         WHERE founder_decision = 'pending'
         ORDER BY detected_at DESC LIMIT 30;`);
      for (const r of rows) {
        cards.push({
          kind: 'trainer_proposal',
          id: r.id,
          title: `📚 Moallem proposal · target=${r.target_agent}`,
          sub: r.pattern_summary,
          urgency: r.confidence >= 0.85 ? 'high' : 'medium',
          action_label: 'Approve & apply',
          detected_at: r.detected_at,
          link: { tab: 'agents', overlay: 'trainer' },
        });
      }
    } catch (_) {}

    // 3. Hot DM intents (M47)
    try {
      const rows = await queryRows(`
        SELECT id::text, sender_handle, message_text, intent, urgency, language,
                triaged_at::text, status
          FROM dm_inbox
         WHERE status IN ('triaged', 'drafted')
           AND urgency IN ('hot', 'qualifying')
         ORDER BY triaged_at DESC LIMIT 20;`);
      for (const r of rows) {
        cards.push({
          kind: 'dm_hot',
          id: r.id,
          title: `💬 ${r.sender_handle || 'inbound DM'} · ${r.intent || 'unclassified'}`,
          sub: (r.message_text || '').slice(0, 140),
          urgency: r.urgency === 'hot' ? 'high' : 'medium',
          action_label: r.status === 'drafted' ? 'Send / Edit reply' : 'Draft reply',
          detected_at: r.triaged_at,
          link: { tab: 'dms', dm_id: r.id },
        });
      }
    } catch (_) {}

    // 4. Regulatory drift events
    try {
      const rows = await queryRows(`
        SELECT id::text, watchpoint_id::text, label, summary, detected_at::text, status
          FROM regulatory_drift_events
         WHERE status = 'pending'
         ORDER BY detected_at DESC LIMIT 15;`);
      for (const r of rows) {
        cards.push({
          kind: 'reg_drift',
          id: r.id,
          title: `⚖ Regulatory change: ${r.label}`,
          sub: r.summary || 'Hash diff detected',
          urgency: 'medium',
          action_label: 'Review',
          detected_at: r.detected_at,
          link: { tab: 'watchdog' },
        });
      }
    } catch (_) {}

    // 5. Media library awaiting approval (designs)
    try {
      const rows = await queryRows(`
        SELECT id::text, kind, topic, language, render_path, draft_path,
                created_at::text
          FROM media_library
         WHERE COALESCE(approved, false) = false
           AND COALESCE(archived, false) = false
           AND created_at >= NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC LIMIT 15;`);
      for (const r of rows) {
        cards.push({
          kind: 'design_pending',
          id: r.id,
          title: `🎨 Design awaiting approval · ${r.kind}`,
          sub: (r.topic || 'no topic').slice(0, 140),
          urgency: 'medium',
          action_label: 'Open in Designs',
          detected_at: r.created_at,
          link: { tab: 'designs', media_id: r.id },
        });
      }
    } catch (_) {}

    // 6. K4 handoffs pending
    try {
      const rows = await queryRows(`
        SELECT id::text, from_agent, to_agent, reason, suggested_action,
                created_at::text, status
          FROM agent_handoffs
         WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT 20;`);
      for (const r of rows) {
        cards.push({
          kind: 'handoff',
          id: r.id,
          title: `🤝 Handoff · ${r.from_agent} → ${r.to_agent}`,
          sub: r.reason || r.suggested_action || 'pending action',
          urgency: 'low',
          action_label: 'Approve / Redirect',
          detected_at: r.created_at,
          link: { tab: 'inbox', handoff_id: r.id },
        });
      }
    } catch (_) {}

    // 7. K1 legacy action approvals
    try {
      const pending = await permissions.listPending({ limit: 30 });
      for (const r of (pending || [])) {
        cards.push({
          kind: 'action_approval',
          id: r.id,
          title: `🔔 Action approval · ${r.action || 'pending'}`,
          sub: r.summary || (r.payload ? JSON.stringify(r.payload).slice(0, 120) : ''),
          urgency: 'low',
          action_label: 'Approve',
          detected_at: r.created_at,
          link: { tab: 'inbox' },
        });
      }
    } catch (_) {}

    // Sort: urgency rank then detected_at desc
    const URG = { high: 3, medium: 2, low: 1 };
    cards.sort((a, b) => {
      const ua = URG[a.urgency] || 0;
      const ub = URG[b.urgency] || 0;
      if (ua !== ub) return ub - ua;
      return new Date(b.detected_at) - new Date(a.detected_at);
    });

    // Aggregate counts per kind for the badge / breadcrumb
    const counts = {};
    for (const c of cards) counts[c.kind] = (counts[c.kind] || 0) + 1;

    res.json({
      ok: true,
      total: cards.length,
      counts,
      cards: cards.slice(0, limit),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lightweight count-only for the sidebar breadcrumb badge (M96 will use this)
app.get('/inbox/count-all', async (_, res) => {
  try {
    const sources = await Promise.all([
      queryValue(`SELECT COUNT(*) FROM compose_runs WHERE status IN ('awaiting_approval','gated') AND created_at >= NOW() - INTERVAL '30 days';`),
      queryValue(`SELECT COUNT(*) FROM training_proposals WHERE founder_decision = 'pending';`),
      queryValue(`SELECT COUNT(*) FROM dm_inbox WHERE status IN ('triaged','drafted') AND urgency IN ('hot','qualifying');`),
      queryValue(`SELECT COUNT(*) FROM regulatory_drift_events WHERE status = 'pending';`),
      queryValue(`SELECT COUNT(*) FROM media_library WHERE COALESCE(approved, false) = false AND COALESCE(archived, false) = false;`),
      queryValue(`SELECT COUNT(*) FROM agent_handoffs WHERE status = 'pending';`),
    ]);
    const breakdown = {
      gated_runs:           parseInt(sources[0], 10) || 0,
      trainer_proposals:    parseInt(sources[1], 10) || 0,
      hot_dms:              parseInt(sources[2], 10) || 0,
      reg_drift:            parseInt(sources[3], 10) || 0,
      designs_pending:      parseInt(sources[4], 10) || 0,
      handoffs:             parseInt(sources[5], 10) || 0,
    };
    let actionApprovals = 0;
    try { actionApprovals = await permissions.countPending(); } catch (_) {}
    breakdown.action_approvals = actionApprovals;
    const total = Object.values(breakdown).reduce((s, n) => s + n, 0);
    res.json({ ok: true, total, breakdown });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
  const { country, category, topic, subtopic, status, query, limit } = req.query || {};
  res.json({ ok: true, entries: await KB.list({ country, category, topic, subtopic, status, query, limit }) });
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
  const { country, category, topic, subtopic, query, limit } = req.query || {};
  const [rows, block] = await Promise.all([
    KB.recall({ country, category, topic, subtopic, query, limit }),
    KB.renderAsBlock({ country, category, topic, subtopic, query, limit }),
  ]);
  res.json({ ok: true, rows, block });
});

// ── M105 · Knowledge tree + taxonomy CRUD ────────────────────────────
// /knowledge/tree              · nested taxonomy + entry counts
// /knowledge/topics            · GET list / POST add
// /knowledge/topics/:id        · PATCH / DELETE
// /knowledge/subtopic-suggest  · existing subtopic_slugs + tags for a topic
//
// /kb/* endpoints (above) accept ?topic=&subtopic= already.
app.get('/knowledge/tree', async (req, res) => {
  try {
    const out = await KB.tree({ country: req.query.country || null });
    res.json({ ok: true, tree: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/knowledge/topics', async (req, res) => {
  try {
    const items = await KB.topicsList({ country: req.query.country || null });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/knowledge/topics', auth.middleware, async (req, res) => {
  try {
    const r = await KB.topicsAdd(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/knowledge/topics/:id', auth.middleware, async (req, res) => {
  try {
    const r = await KB.topicsUpdate(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/knowledge/topics/:id', auth.middleware, async (req, res) => {
  try {
    const r = await KB.topicsRemove(req.params.id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/knowledge/subtopic-suggest', async (req, res) => {
  try {
    const out = await KB.subtopicSuggestions({
      country: req.query.country || null,
      topic:   req.query.topic   || null,
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M106 · Embeddings — status + manual backfill ─────────────────────
app.get('/knowledge/embeddings/status', async (_req, res) => {
  try {
    const r = await KB.embeddingsStatus();
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/knowledge/embeddings/backfill', auth.middleware, async (req, res) => {
  try {
    const limit = (req.body && req.body.limit) || 50;
    const r = await KB.backfillEmbeddings({ limit });
    if (!r.ok) return res.status(400).json(r);
    log(`kb.backfill processed=${r.processed} ok=${r.succeeded} fail=${r.failed} cost=$${(r.cost_usd||0).toFixed(5)} remaining=${r.remaining}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Re-embed one row on demand (e.g. after a manual edit before the
// background job runs, or to retry a 'failed' row).
app.post('/kb/:id/reembed', auth.middleware, async (req, res) => {
  try {
    KB.embedRowAsync(req.params.id);
    res.json({ ok: true, queued: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M110 · External-AI JSON ingest ────────────────────────────────────
// The founder uses ChatGPT / Gemini / Claude.ai to extract structured
// facts from regulator PDFs / web pages, and uploads the resulting
// JSON straight to the KB. Two helper downloads:
//   /kb/json-template       — empty template the AI fills in
//   /kb/json-prompt-guide   — markdown instructions to paste into the AI
// One upload route:
//   /kb/upload-json         — batch-creates entries with per-row error capture

// Build the template payload. Returns a real example so the AI sees
// the shape (one realistic UK exam entry, one minimal CA visa entry).
function _kbJsonTemplate() {
  return {
    "rxapply_kb_format_version": 1,
    "default_country":  "UK",
    "default_status":   "draft",
    "default_importance": 3,
    "entries": [
      {
        "country":    "UK",
        "topic":      "exam",
        "subtopic":   "ore_part_1",
        "title":      "ORE Part 1 — eligibility",
        "content":    "Candidates must hold a dental qualification of at least four years that is recognised by the GDC. The degree must be from outside the EEA. Applicants need to demonstrate English-language ability via IELTS Academic 7.0 overall (no band below 6.5) or equivalent OET grade B.",
        "facts":      { "fee_gbp": 1066, "year": 2025, "ielts_overall": 7.0 },
        "source":     "https://www.gdc-uk.org/registration-applications/the-overseas-registration-examination",
        "source_type": "manual",
        "tags":       ["ore", "exam", "uk", "eligibility", "ielts"],
        "importance": 4,
        "status":     "draft"
      },
      {
        "country":    "CA",
        "topic":      "visa",
        "subtopic":   "express_entry",
        "title":      "Express Entry — Comprehensive Ranking System (CRS) overview",
        "content":    "Express Entry ranks candidates by CRS score across age, education, language, and Canadian work experience. Provincial nominations add 600 points.",
        "facts":      { "max_crs_score": 1200, "pnp_bonus": 600 },
        "source":     "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry.html",
        "tags":       ["express-entry", "crs", "canada", "immigration"]
      }
    ]
  };
}

// Build the AI prompt guide as markdown. The founder pastes this into
// any LLM chat along with their source material; the LLM returns a
// JSON conforming to the template; founder uploads that JSON here.
function _kbAiPromptGuide() {
  return `# RxApply Knowledge Base · AI Extraction Guide

You are an extraction assistant for RxApply, a multilingual brand that
helps internationally-trained dentists migrate. Your job: read source
material (regulator handbooks, government pages, founder notes,
interview transcripts) and return structured **JSON** that conforms
to the schema below. The founder will upload your JSON directly into
the RxApply Knowledge Base.

---

## OUTPUT FORMAT

Return ONE JSON object, exactly matching this shape:

\`\`\`json
{
  "rxapply_kb_format_version": 1,
  "default_country":  "UK",
  "default_status":   "draft",
  "default_importance": 3,
  "entries": [
    { /* entry 1 */ },
    { /* entry 2 */ }
  ]
}
\`\`\`

No prose before or after. No markdown code fences in your final answer.
Just the JSON object.

---

## ENTRY SCHEMA

Each \`entries[]\` object can include these fields. **country**,
**title**, and **content** are REQUIRED; the rest are optional.

| Field        | Type    | Required | Notes |
|--------------|---------|----------|-------|
| \`country\`    | string  | ✅       | One of: UK · USA · DE · AU · CA · UAE · SA · GLOBAL. Use GLOBAL only for facts that apply across all countries. |
| \`title\`      | string  | ✅       | Short label (3–10 words). Examples: "ORE Part 1 — eligibility", "GDC ARF — annual fee 2025". |
| \`content\`    | string  | ✅       | The canonical fact in prose (1–4 sentences). Include numbers, dates, named bodies. Avoid marketing language. |
| \`topic\`      | string  | strongly recommended | One of: \`visa\` · \`exam\` · \`courses\` · \`fees\` · \`tax\` · \`quality_of_life\` · \`regulator\` · \`timeline\` · \`document\` · \`other\`. |
| \`subtopic\`   | string  | recommended | The specific item within the topic. Use lowercase snake_case. Examples: \`ore_part_1\`, \`tier_2_skilled_worker\`, \`j1_visa\`, \`ndeb_afk\`. |
| \`facts\`      | object  | recommended | Structured key/value extraction of numbers, dates, names. Examples: \`{"fee_gbp": 1066, "year": 2025}\`, \`{"deadline": "2025-09-30"}\`. Use SI units / ISO dates where possible. |
| \`source\`     | string  | recommended | The URL of the source page, OR a citation like "GDC handbook 2025 ch. 4". |
| \`source_type\`| string  | optional | \`manual\` (default) · \`parsed\` · \`web\` · \`inherited\`. |
| \`tags\`       | array of strings | recommended | Free-form lowercase tags for retrieval. Examples: \`["ore", "exam", "uk"]\`. 3–8 tags is ideal. |
| \`importance\` | integer 1–5 | optional | 1 = trivia · 3 = standard fact · 5 = critical (deadline-bearing or regulatory). Default 3. |
| \`status\`     | string  | optional | \`active\` (verified) · \`draft\` (needs review). Default \`draft\` when extracting from external sources. |

---

## CHOOSING TOPIC AND SUBTOPIC

The KB is hierarchical: **country → topic → subtopic**. Pick the
narrowest applicable level.

**Topic decision tree:**
- Is it about who can enter the country? → \`visa\`
- Is it a licensing/certification exam? → \`exam\`
- Is it a school/course/CE? → \`courses\`
- Is it a numerical fee, currency, or money figure? → \`fees\`
- Is it about taxes / withholding / tax residency? → \`tax\`
- Is it about cost of living, healthcare, schooling, climate? → \`quality_of_life\`
- Is it about a regulatory body itself (mandate, contact)? → \`regulator\`
- Is it a step in the migration journey? → \`timeline\`
- Is it about a specific document / form / attestation? → \`document\`
- None of the above → \`other\`

**Subtopic — be specific:**
- Don't write \`ore\` if you mean \`ore_part_1\`. Use the actual exam name.
- For visas, use the official class: \`tier_2_skilled_worker\`, \`j1_exchange_visitor\`, \`subclass_482\`, \`express_entry\`, \`approbation\`.
- For exams: \`inbde\`, \`adat\`, \`ndeb_afk\`, \`acs\`, \`adc_written\`, \`kenntnisprufung\`, \`fsp\`.
- For documents: \`apostille\`, \`certified_translation\`, \`cos\`, \`wes_eca\`.

If you genuinely can't pin a subtopic, leave it out — better than guessing.

---

## CONTENT QUALITY RULES

DO:
- Quote numbers, dates, named bodies VERBATIM from the source.
- Use ISO date format: \`2025-09-30\` (not "September 30, 2025").
- Mark currency in field names: \`fee_gbp\`, \`fee_usd\`, \`fee_cad\`.
- Group related fields into \`facts\` even if mentioned in \`content\`.
- Split a long paragraph into MULTIPLE entries — one fact per entry.
- Use \`status: "draft"\` for any fact you weren't 100% certain about.

DON'T:
- Fabricate numbers. If the source says "approximately £1000" do NOT invent £1066.
- Include marketing language ("fast-track", "easy", "guaranteed").
- Include opinions or testimonials.
- Repeat the same fact under multiple subtopics — pick the most specific.
- Output content longer than 4 sentences per entry. Split it instead.

---

## EXAMPLES

### Example 1 — Single regulatory fact

Source paragraph:
> "The General Dental Council requires all internationally qualified
> applicants to pass the Overseas Registration Examination (ORE).
> Part 1 is a written exam covering biomedical and clinical sciences.
> The current Part 1 fee is £1,066, set in April 2025."

Produces:
\`\`\`json
{
  "country": "UK",
  "topic": "exam",
  "subtopic": "ore_part_1",
  "title": "ORE Part 1 — overview and 2025 fee",
  "content": "The Overseas Registration Examination (ORE) Part 1 is a written exam covering biomedical and clinical sciences, required by the GDC for internationally-qualified applicants. The 2025 fee is £1,066, effective April 2025.",
  "facts": { "fee_gbp": 1066, "year": 2025, "fee_effective_from": "2025-04-01" },
  "source": "https://www.gdc-uk.org/...",
  "tags": ["ore", "exam", "uk", "fee", "2025"],
  "importance": 4
}
\`\`\`

### Example 2 — Splitting a multi-fact paragraph into multiple entries

Source paragraph:
> "Express Entry candidates need a CRS score above the most recent
> draw cutoff. The minimum draw cutoff in 2024 ranged from 524 to 561
> for general draws. Provincial nominations add 600 CRS points."

Produces THREE entries:
1. \`title: "Express Entry — CRS draw cutoffs (2024)"\` with \`facts: { "min_cutoff_2024": 524, "max_cutoff_2024": 561 }\`
2. \`title: "Express Entry — Provincial Nomination CRS bonus"\` with \`facts: { "pnp_bonus": 600 }\`
3. \`title: "Express Entry — CRS score gating mechanism"\` with prose explaining the draw mechanism.

This is BETTER than one long entry because each fact lives at its own granularity and gets its own embedding for retrieval.

### Example 3 — When NOT to include in KB

> "Many of our clients have successfully relocated to the UK and love
> their new lives in London."

Skip this. It's marketing, has no verifiable fact, and pollutes recall.

---

## CHECKLIST BEFORE YOU RETURN

1. ✅ All entries have \`country\`, \`title\`, \`content\`.
2. ✅ \`topic\` is one of the 10 valid values (or omitted if you genuinely can't pick).
3. ✅ \`subtopic\` uses lowercase snake_case.
4. ✅ Numbers + dates + named bodies are exactly as in the source.
5. ✅ One fact = one entry. Long paragraphs are split.
6. ✅ The output is valid JSON. No code fences. No prose around it.
7. ✅ \`status: "draft"\` for anything you weren't 100% sure about.

That's it. Read the source carefully, follow the schema, return JSON.
`;
}

// M111b · Routes under /knowledge/ namespace to avoid collision with the
// parametric /kb/:id route registered earlier in this file. (Express
// matches /kb/json-template against /kb/:id first, treating
// "json-template" as an id and never reaching this handler.)
app.get('/knowledge/json-template', (_req, res) => {
  const body = JSON.stringify(_kbJsonTemplate(), null, 2);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rxapply-kb-template.json"');
  res.end(body);
});

app.get('/knowledge/json-prompt-guide', (_req, res) => {
  const body = _kbAiPromptGuide();
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rxapply-kb-ai-extraction-guide.md"');
  res.end(body);
});

// Back-compat aliases — same handlers under the old /kb/ paths in case
// any external bookmark or curl script was already using them. These
// also work now because the parametric /kb/:id is async and the static
// path lands here first when registered later — but safer to keep them.
app.get('/kb-export/json-template', (req, res) => {
  res.redirect(307, '/knowledge/json-template');
});
app.get('/kb-export/json-prompt-guide', (req, res) => {
  res.redirect(307, '/knowledge/json-prompt-guide');
});

app.post('/knowledge/upload-json', auth.middleware, async (req, res) => {
  try {
    const body = req.body || {};
    const entries = Array.isArray(body.entries) ? body.entries : null;
    if (!entries || !entries.length) {
      return res.status(400).json({ ok: false, error: 'expected { entries: [...] } in body' });
    }
    const defaultCountry = body.default_country || null;
    const defaultStatus  = body.default_status  || 'draft';
    const defaultImp     = parseInt(body.default_importance, 10) || 3;
    const filename       = body.filename        || null;

    const created = [], failed = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      try {
        const r = await KB.add({
          country:     e.country     || defaultCountry,
          topic:       e.topic       || null,
          subtopic:    e.subtopic    || null,
          category:    e.category    || null,
          title:       e.title,
          content:     e.content,
          facts:       e.facts       || {},
          source:      e.source      || null,
          sourceType:  e.source_type || 'manual',
          tags:        Array.isArray(e.tags) ? e.tags : [],
          importance:  Number.isFinite(e.importance) ? e.importance : defaultImp,
          status:      e.status      || defaultStatus,
          verifiedBy:  e.status === 'active' ? 'founder' : null,
          updatedBy:   'founder',
        });
        if (r.ok) created.push({ index: i, id: r.id, title: e.title });
        else      failed.push({ index: i, title: e.title || '(no title)', error: r.error });
      } catch (ex) {
        failed.push({ index: i, title: e.title || '(no title)', error: ex.message });
      }
    }

    // M112 · Persist an import row so the founder can review history + undo.
    let importId = null;
    try {
      const idsArr  = created.map(c => `'${c.id}'::uuid`).join(',');
      const idsLit  = idsArr ? `ARRAY[${idsArr}]` : `'{}'::uuid[]`;
      const failedJsonStr = JSON.stringify(failed).replace(/'/g, "''");
      importId = await db.queryReturning(`
        INSERT INTO kb_imports
          (created_by, filename, default_country, default_status, default_importance,
           total_count, created_count, failed_count, entry_ids, failed_entries)
        VALUES (
          'founder',
          ${filename ? db.q(filename) : 'NULL'},
          ${defaultCountry ? db.q(defaultCountry) : 'NULL'},
          ${defaultStatus  ? db.q(defaultStatus)  : 'NULL'},
          ${defaultImp},
          ${entries.length}, ${created.length}, ${failed.length},
          ${idsLit},
          '${failedJsonStr}'::jsonb
        )
        RETURNING id::text;`);
    } catch (e) {
      // Non-fatal — entries already inserted; we just couldn't write the audit row.
      console.warn('kb.upload-json · failed to persist import row:', e.message);
    }

    log(`kb.upload-json import=${importId ? importId.slice(0,8) : '?'} created=${created.length} failed=${failed.length}`);
    res.json({
      ok: true,
      import_id: importId,
      total: entries.length,
      created_count: created.length,
      failed_count: failed.length,
      created, failed,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M112 · KB import history + undo
app.get('/knowledge/imports', auth.middleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const json = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(i) ORDER BY i.created_at DESC), '[]'::json) FROM (
        SELECT id::text, created_at::text, created_by, filename, default_country, default_status,
               default_importance, total_count, created_count, failed_count,
               array_length(entry_ids, 1) AS entry_count,
               status, undone_at::text, undone_by, undone_method
          FROM kb_imports
         ORDER BY created_at DESC
         LIMIT ${limit}
      ) i;`);
    res.json({ ok: true, imports: JSON.parse(json || '[]') });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/knowledge/imports/:id', auth.middleware, async (req, res) => {
  try {
    const json = await db.queryValue(`
      SELECT row_to_json(i) FROM (
        SELECT id::text, created_at::text, created_by, filename, default_country, default_status,
               default_importance, total_count, created_count, failed_count,
               entry_ids::text[], failed_entries,
               status, undone_at::text, undone_by, undone_method, notes
          FROM kb_imports WHERE id = ${db.q(req.params.id)}
      ) i;`);
    if (!json) return res.status(404).json({ ok: false, error: 'import not found' });
    res.json({ ok: true, import: JSON.parse(json) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Undo body: { method: 'soft' | 'hard' }  (default 'soft')
app.post('/knowledge/imports/:id/undo', auth.middleware, async (req, res) => {
  try {
    const method = (req.body && req.body.method) === 'hard' ? 'hard' : 'soft';
    const row = await db.queryOne(`
      SELECT id::text, status, entry_ids::text[]
        FROM kb_imports WHERE id = ${db.q(req.params.id)};`);
    if (!row) return res.status(404).json({ ok: false, error: 'import not found' });
    if (row.status !== 'active') return res.status(400).json({ ok: false, error: `import already ${row.status}` });
    const ids = row.entry_ids || [];
    if (!ids.length) {
      // No entries to undo (everything failed at insert time)
      await db.query(`UPDATE kb_imports SET status='undone', undone_at=NOW(), undone_by='founder', undone_method=${db.q(method)} WHERE id=${db.q(req.params.id)};`);
      return res.json({ ok: true, undone: 0, method, note: 'no entries existed to undo' });
    }
    const idsSql = ids.map(x => `'${x}'::uuid`).join(',');
    let affected = 0;
    if (method === 'hard') {
      // HARD: delete the rows entirely. Cannot be reversed.
      const r = await db.query(`DELETE FROM knowledge_base WHERE id IN (${idsSql});`);
      affected = (r && r.rowCount) || ids.length;
      await db.query(`UPDATE kb_imports SET status='undone_hard', undone_at=NOW(), undone_by='founder', undone_method='hard' WHERE id=${db.q(req.params.id)};`);
    } else {
      // SOFT: flip every entry to status='rejected' (excluded from recall;
      // preserved for audit). Reversible via the existing edit modal.
      const r = await db.query(`UPDATE knowledge_base SET status='rejected', updated_at=NOW(), updated_by='founder' WHERE id IN (${idsSql});`);
      affected = (r && r.rowCount) || ids.length;
      await db.query(`UPDATE kb_imports SET status='undone', undone_at=NOW(), undone_by='founder', undone_method='soft' WHERE id=${db.q(req.params.id)};`);
    }
    log(`kb.imports.undo id=${req.params.id.slice(0,8)} method=${method} affected=${affected}`);
    res.json({ ok: true, method, undone: affected });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M107 · Versioning · history + restore ─────────────────────────────
// History walks the supersede chain in both directions and returns a
// chronologically-ordered list of versions. Restore copies an old
// version's content into a new row that supersedes the current one,
// preserving full audit history.
app.get('/kb/:id/history', auth.middleware, async (req, res) => {
  try {
    const r = await KB.history(req.params.id);
    if (!r.ok) return res.status(404).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/kb/:id/restore', auth.middleware, async (req, res) => {
  try {
    const versionId = (req.body && req.body.version_id) || null;
    if (!versionId) return res.status(400).json({ ok: false, error: 'version_id required in body' });
    const r = await KB.restore(versionId, req.params.id, 'founder');
    if (!r.ok) return res.status(400).json(r);
    log(`kb.restore current=${req.params.id.slice(0,8)} from=${versionId.slice(0,8)} → new=${(r.new_id || '').slice(0,8)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M108 · Bulk re-tag ────────────────────────────────────────────────
// POST /kb/bulk-update
// Body: { filter: {country?, topic?, subtopic?, status?, query?, ids?[]},
//         patch:  {country?, topic?, subtopic?, category?, status?,
//                  importance?, tags?[], tags_add?[], tags_remove?[]},
//         dry_run: bool }
// Always require some filter (refuses to update entire table). Returns
// either a preview of matched rows (dry_run) or applied=true with count.
app.post('/kb/bulk-update', auth.middleware, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await KB.bulkUpdate({
      filter:    b.filter || {},
      patch:     b.patch  || {},
      dryRun:    b.dry_run !== false,         // default to dry-run for safety
      updatedBy: 'founder',
    });
    if (!r.ok) return res.status(400).json(r);
    if (!r.dry_run && r.applied) {
      log(`kb.bulk-update applied=${r.matched_count} embed_queued=${!!r.embed_queued}`);
    }
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

// ── M24 · Compose orchestrator routes ───────────────────────────────────
// New recipe-driven, multi-format Compose. The legacy /compose/instagram
// (and friends) routes remain for now — M28 ports IG onto the orchestrator.
//
//   GET    /compose/recipes                    — list available recipes
//   GET    /compose/runs                       — list runs (?limit, ?recipe, ?status)
//   GET    /compose/runs/:id                   — run + ordered stages
//   POST   /compose/runs                       — create + start a run (auth)
//   POST   /compose/runs/:id/tick              — advance one stage (auth)
//   POST   /compose/runs/:id/run               — run-to-block (auth)
//   POST   /compose/runs/:id/approve           — approve a gated stage (auth)
//   POST   /compose/runs/:id/cancel            — cancel a run (auth)
app.get('/compose/recipes', (_req, res) => {
  try { res.json({ ok: true, recipes: composeOrchestrator.listRecipes() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M72A · Pipeline management API ──────────────────────────────────
// Founder-facing CRUD for pipelines. The Pipeline tab v2 (M72B) reads
// and writes through these endpoints. Compose runs use the orchestrator's
// in-memory cache (populated by pipelines.js); these endpoints invalidate
// that cache on every write.
//
//   GET    /pipelines                          — list (?category, ?include_disabled)
//   GET    /pipelines/:id                      — full row + cached definition
//   PUT    /pipelines/:id (auth)               — save (creates new version)
//   POST   /pipelines/:id/clone (auth)         — body {newId, newLabel?}
//   POST   /pipelines/:id/rollback (auth)      — body {to:<n>}
//   DELETE /pipelines/:id (auth)               — soft-disable (?hard=true to actually delete)
//   GET    /pipelines/:id/versions             — version history (header rows)
//   GET    /pipelines/:id/versions/:n          — full snapshot
//   POST   /pipelines/import (auth)            — body = pipeline JSON, creates new
//   GET    /pipelines/:id/export               — JSON dump for backup
const _pipelines = require('./pipelines');
const PIPELINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/i;

app.get('/pipelines', async (req, res) => {
  try {
    const items = await _pipelines.listAll({
      category: req.query.category || null,
      includeDisabled: req.query.include_disabled === 'true',
    });
    res.json({ ok: true, count: items.length, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/pipelines/:id', async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const row = await _pipelines.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'pipeline not found' });
    res.json({ ok: true, pipeline: row });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/pipelines/:id', auth.middleware, async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const body = req.body || {};
    const definition = body.definition || body;        // accept either {definition:{...}} or raw def
    const r = await _pipelines.save(req.params.id, definition, {
      changedBy: (req.user && req.user.username) || 'founder',
      changeNote: body.change_note || body.changeNote || null,
      label: body.label || null,
      description: body.description || null,
      category: body.category || null,
    });
    log(`pipelines.put id=${req.params.id} v=${r.version}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/pipelines/:id/clone', auth.middleware, async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const body = req.body || {};
    const newId = body.newId || body.new_id;
    const newLabel = body.newLabel || body.new_label || null;
    if (!newId || !PIPELINE_ID_RE.test(newId)) return res.status(400).json({ ok: false, error: 'newId required and must be a valid id' });
    const r = await _pipelines.clone(req.params.id, newId, newLabel);
    log(`pipelines.clone src=${req.params.id} new=${newId}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/pipelines/:id/rollback', auth.middleware, async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const to = req.body && (req.body.to || req.body.toVersion);
    if (to == null) return res.status(400).json({ ok: false, error: 'send {to: <version>}' });
    const r = await _pipelines.rollback(req.params.id, to, {
      changedBy: (req.user && req.user.username) || 'founder',
    });
    if (!r.ok) return res.status(404).json(r);
    log(`pipelines.rollback id=${req.params.id} to=${to} new_v=${r.version}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.delete('/pipelines/:id', auth.middleware, async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const hard = req.query.hard === 'true';
    const r = await _pipelines.del(req.params.id, { hard });
    log(`pipelines.delete id=${req.params.id} hard=${hard}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/pipelines/:id/versions', async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const versions = await _pipelines.listVersions(req.params.id, { limit: req.query.limit });
    res.json({ ok: true, count: versions.length, versions });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/pipelines/:id/versions/:n', async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const def = await _pipelines.getVersion(req.params.id, req.params.n);
    if (!def) return res.status(404).json({ ok: false, error: 'version not found' });
    res.json({ ok: true, id: req.params.id, version: parseInt(req.params.n, 10), definition: def });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/pipelines/import', auth.middleware, async (req, res) => {
  try {
    const body = req.body || {};
    const def = body.definition || body;
    if (!def || !def.id) return res.status(400).json({ ok: false, error: 'definition.id required' });
    if (!PIPELINE_ID_RE.test(def.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const r = await _pipelines.save(def.id, def, {
      changedBy: (req.user && req.user.username) || 'founder',
      changeNote: 'imported from JSON',
      label: def.label,
      description: def.description,
      category: def.category || 'compose',
    });
    log(`pipelines.import id=${def.id} v=${r.version}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/pipelines/:id/export', async (req, res) => {
  try {
    if (!PIPELINE_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid pipeline id' });
    const row = await _pipelines.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'pipeline not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="pipeline-${row.id}-v${row.version}.json"`);
    res.send(JSON.stringify(row.definition, null, 2));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M38 · List available image-gen models for the run-form picker.
app.get('/compose/image-models', (_req, res) => {
  try {
    const composeImage = require('./compose-image');
    res.json({ ok: true, models: composeImage.listAvailableModels() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/compose/runs', async (req, res) => {
  try {
    const items = await composeOrchestrator.listRuns({
      limit: parseInt(req.query.limit, 10) || 30,
      recipe: req.query.recipe || null,
      status: req.query.status || null,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/compose/runs/:id', async (req, res) => {
  try {
    const run = await composeOrchestrator.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M99 · Process-log download. Returns a single human-readable text dump
// of EVERYTHING that flowed through the run: run metadata, recipe + options,
// each stage's resolved agent + model, the system prompt + user input
// (verbatim, as sent to the LLM), the raw output (pre-parse), parsed result,
// validation errors, refine attempts, costs, tokens, timing, errors. The
// founder's "I want to see exactly what happened" surface.
//   ?format=json → returns the full JSON dump (machine-readable)
//   default      → returns a markdown/text log (Content-Disposition: attachment)
app.get('/compose/runs/:id/log', async (req, res) => {
  try {
    const run = await composeOrchestrator.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'not found' });
    const fmt = String(req.query.format || 'text').toLowerCase();

    // Helpers
    const j = (v) => {
      if (v == null) return '(none)';
      try { return JSON.stringify(v, null, 2); }
      catch (_) { return String(v); }
    };
    const fence = (lang, body) => `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
    const hr = '\n' + '─'.repeat(78) + '\n';

    if (fmt === 'json') {
      const filename = `compose-run-${run.id}.json`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.end(JSON.stringify(run, null, 2));
    }

    // Build markdown/text log
    const stages = (run.stages || []).slice().sort((a, b) => {
      if (a.stage_index !== b.stage_index) return a.stage_index - b.stage_index;
      return String(a.lang || '').localeCompare(String(b.lang || ''));
    });

    const lines = [];
    lines.push(`# Compose run · process log`);
    lines.push('');
    lines.push(`Run ID:          ${run.id}`);
    lines.push(`Recipe:          ${run.recipe_id} (v${run.recipe_version || '?'})`);
    lines.push(`Topic:           ${run.topic || ''}`);
    lines.push(`Audience:        ${run.audience || ''}`);
    lines.push(`Master language: ${run.master_lang || ''}`);
    lines.push(`Target langs:    ${Array.isArray(run.target_langs) ? run.target_langs.join(', ') : ''}`);
    lines.push(`Gate strategy:   ${run.gate_strategy || ''}`);
    lines.push(`Status:          ${run.status}${run.error ? '  · error: ' + run.error : ''}`);
    lines.push(`Cost:            $${Number(run.total_cost_usd || 0).toFixed(4)}   (in: ${run.total_input_tokens || 0} tok · out: ${run.total_output_tokens || 0} tok)`);
    lines.push(`Refine attempts: ${run.refine_attempts || 0}   (${run.refine_status || 'n/a'})`);
    lines.push(`Created:         ${run.created_at || ''}`);
    lines.push(`Started:         ${run.started_at || ''}`);
    lines.push(`Finished:        ${run.finished_at || ''}`);
    lines.push('');
    lines.push('## Options');
    lines.push(fence('json', j(run.options)));
    if (run.agent_overrides && Object.keys(run.agent_overrides).length) {
      lines.push('## Agent overrides');
      lines.push(fence('json', j(run.agent_overrides)));
    }
    if (run.final_output) {
      lines.push('## Final output (rendered)');
      lines.push(fence('json', j(run.final_output)));
    }

    lines.push(hr);
    lines.push(`## Stage timeline (${stages.length} stages)`);
    lines.push('');

    for (const s of stages) {
      const head = `### #${s.stage_index} · ${s.stage_name}${s.lang ? ' [' + s.lang + ']' : ''}`;
      lines.push(head);
      lines.push('');
      lines.push(`Agent:    ${s.agent || '(renderer)'}`);
      lines.push(`Model:    ${s.model || '(none)'}`);
      lines.push(`Capability: ${s.capability || ''}`);
      lines.push(`Status:   ${s.status}${s.error ? '  · ' + s.error : ''}`);
      lines.push(`Tokens:   in ${s.input_tokens || 0} · out ${s.output_tokens || 0}   Cost: $${Number(s.cost_usd || 0).toFixed(4)}`);
      lines.push(`Timing:   started ${s.started_at || ''} → finished ${s.finished_at || ''}`);
      if (s.approval_required) {
        lines.push(`Gate:     approved_at=${s.approved_at || '(pending)'} by ${s.approved_by || ''}${s.approval_note ? '  note: ' + s.approval_note : ''}`);
      }
      lines.push('');
      // INPUT — verbatim system prompt + user prompt the model received.
      // Older runs (pre-M99) only have an excerpt; newer runs have full text.
      const inp = s.input && typeof s.input === 'object' ? s.input : {};
      if (inp.system_prompt || inp.user_prompt) {
        if (inp.system_prompt) {
          lines.push('#### System prompt (full)');
          lines.push(fence('text', inp.system_prompt));
        }
        if (inp.user_prompt) {
          lines.push('#### User prompt (full)');
          lines.push(fence('text', inp.user_prompt));
        }
        if (inp.retried) lines.push('_Note: this stage was retried once after contract validation._\n');
        if (inp.agent_run_id) lines.push(`Linked agent_runs row: ${inp.agent_run_id}\n`);
      } else {
        lines.push('#### Input (sent to model)');
        lines.push(fence('json', j(s.input)));
      }
      // OUTPUT — parsed JSON the model produced
      lines.push('#### Output (parsed)');
      lines.push(fence('json', j(s.output)));
      lines.push(hr);
    }

    const filename = `compose-run-${run.id}.log.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.end(lines.join('\n'));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/compose/runs', auth.middleware, async (req, res) => {
  try {
    const {
      recipeId, topic, audience, masterLang = 'en', targetLangs = [],
      options = {}, gateStrategy = 'critique', agentOverrides = {},
    } = req.body || {};
    if (!recipeId || !topic) return res.status(400).json({ ok: false, error: 'recipeId + topic required' });
    const r = await composeOrchestrator.start({
      recipeId, topic, audience, masterLang, targetLangs,
      options, gateStrategy, agentOverrides,
    });
    log(`compose.start id=${r.id} recipe=${recipeId}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/compose/runs/:id/tick', auth.middleware, async (req, res) => {
  try {
    const run = await composeOrchestrator.tick(req.params.id);
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/compose/runs/:id/run', auth.middleware, async (req, res) => {
  try {
    const run = await composeOrchestrator.runToBlock(req.params.id);
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/compose/runs/:id/approve', auth.middleware, async (req, res) => {
  try {
    const run = await composeOrchestrator.approve(
      req.params.id, (req.body || {}).note || null,
      (req.user && req.user.username) || 'founder',
    );
    log(`compose.approve id=${req.params.id}`);
    res.json({ ok: true, run });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/compose/runs/:id/cancel', auth.middleware, async (req, res) => {
  try {
    const run = await composeOrchestrator.cancel(req.params.id, (req.body || {}).note || null);
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M44 · Fork from stage. Body: { stageIndex, options?, agentOverrides?, topic?, audience?, gateStrategy? }
app.post('/compose/runs/:id/fork-from', auth.middleware, async (req, res) => {
  try {
    const r = await composeOrchestrator.forkFromStage(req.params.id, req.body || {});
    log(`compose.fork-from src=${req.params.id} stageIndex=${(req.body || {}).stageIndex} new=${r.id}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// M30 · Publish a finished render to the n8n publish webhook.
//   Body: { lang }
//   Env:  N8N_PUBLISH_WEBHOOK  — full URL to n8n's webhook node
app.post('/compose/runs/:id/publish', auth.middleware, async (req, res) => {
  try {
    const url = process.env.N8N_PUBLISH_WEBHOOK;
    if (!url) {
      return res.status(400).json({
        ok: false, error: 'N8N_PUBLISH_WEBHOOK env var not set',
        hint: 'In Railway → cowork-proxy service → Variables, add:\nN8N_PUBLISH_WEBHOOK=https://n8n.rxapply.com/webhook/<your-webhook-id>',
      });
    }
    const run = await composeOrchestrator.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'run not found' });
    const lang = (req.body && req.body.lang) || run.master_lang;
    const stage = (run.stages || []).find(s => s.stage_name === 'render' && (s.lang || run.master_lang) === lang);
    if (!stage || !stage.output) return res.status(400).json({ ok: false, error: `no rendered output for lang=${lang}` });

    // M32 · Optional cover image (master phase, shared across all langs).
    const imageStage = (run.stages || []).find(s => s.stage_name === 'image' && s.status === 'done' && s.output && s.output.url);
    const coverUrl = imageStage ? imageStage.output.url : null;

    // For Telegram, when an image is present, switch the bot payload from
    // sendMessage → sendPhoto. n8n's Telegram node accepts either shape.
    let outputForN8n = stage.output;
    if (run.recipe_id === 'telegram' && coverUrl && stage.output && stage.output.sendMessage_payload) {
      const sm = stage.output.sendMessage_payload;
      const sp = {
        chat_id: sm.chat_id,
        photo: coverUrl,
        caption: sm.text,
        parse_mode: sm.parse_mode,
      };
      outputForN8n = { ...stage.output, sendPhoto_payload: sp, _telegram_method: 'sendPhoto' };
    }

    const payload = {
      run_id: run.id,
      recipe: run.recipe_id,
      lang,
      topic: run.topic,
      audience: run.audience,
      options: run.options,
      output: outputForN8n,
      cover_url: coverUrl,
      published_at: new Date().toISOString(),
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const responseText = await r.text();
    log(`compose.publish run=${run.id} lang=${lang} → n8n ${r.status}`);
    res.json({ ok: r.ok, status: r.status, response: responseText.slice(0, 500) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// M103 · Canva Connect — settings, templates, sizes, fan-out, dynamic options
// All persisted in canva_settings / canva_templates / canva_sizes / canva_runs.
// Nothing about Canva is hardcoded in recipes; the founder edits everything
// from the dashboard at runtime.
// ════════════════════════════════════════════════════════════════════════

// ── Health + live-Canva diagnostics ────────────────────────────────────
app.get('/canva/health', async (_req, res) => {
  try {
    const tokenSet = await canva.hasTokenAsync();
    if (!tokenSet) return res.json({ ok: true, token_set: false, note: 'Set CANVA_API_TOKEN in Railway env vars OR paste it via the Canva settings panel.' });
    const r = await canva.ping();
    res.json({ ok: true, token_set: true, live: r.ok, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Settings (single-row config) ───────────────────────────────────────
app.get('/canva/settings', async (_req, res) => {
  try {
    const s = await canva.getSettings();
    // Mask the token if it's stored in the DB so the dashboard can show
    // "set" without exposing the value to the wire.
    if (s && s.api_token) s.api_token_masked = `${s.api_token.slice(0, 6)}…${s.api_token.slice(-4)}`;
    if (s) delete s.api_token;
    res.json({ ok: true, settings: s, env_token_set: !!process.env.CANVA_API_TOKEN });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/canva/settings', auth.middleware, async (req, res) => {
  try {
    const r = await canva.patchSettings(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Brand templates (founder-managed registry) ─────────────────────────
app.get('/canva/templates', async (_req, res) => {
  try {
    const json = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(t) ORDER BY enabled DESC, slot_type, name), '[]'::json)
        FROM (SELECT id::text, name, canva_template_id, slot_type, platform, language,
                     slot_mappings, notes, enabled, created_at::text, updated_at::text
                FROM canva_templates) t;`);
    res.json({ ok: true, templates: JSON.parse(json || '[]') });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/canva/templates', auth.middleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.canva_template_id) return res.status(400).json({ ok: false, error: 'name + canva_template_id required' });
    const id = await db.queryReturning(`
      INSERT INTO canva_templates (name, canva_template_id, slot_type, platform, language, slot_mappings, notes, enabled)
      VALUES (
        ${db.q(b.name)},
        ${db.q(b.canva_template_id)},
        ${b.slot_type ? db.q(b.slot_type) : 'NULL'},
        ${b.platform  ? db.q(b.platform)  : 'NULL'},
        ${b.language  ? db.q(b.language)  : 'NULL'},
        ${b.slot_mappings ? db.qJson(b.slot_mappings) : `'{}'::jsonb`},
        ${b.notes ? db.q(b.notes) : 'NULL'},
        ${b.enabled === false ? 'false' : 'true'}
      ) RETURNING id::text;`);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/canva/templates/:id', auth.middleware, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    if ('name' in b)               sets.push(`name = ${db.q(b.name)}`);
    if ('canva_template_id' in b)  sets.push(`canva_template_id = ${db.q(b.canva_template_id)}`);
    if ('slot_type' in b)          sets.push(`slot_type = ${b.slot_type == null ? 'NULL' : db.q(b.slot_type)}`);
    if ('platform' in b)           sets.push(`platform = ${b.platform == null ? 'NULL' : db.q(b.platform)}`);
    if ('language' in b)           sets.push(`language = ${b.language == null ? 'NULL' : db.q(b.language)}`);
    if ('slot_mappings' in b)      sets.push(`slot_mappings = ${db.qJson(b.slot_mappings)}`);
    if ('notes' in b)              sets.push(`notes = ${b.notes == null ? 'NULL' : db.q(b.notes)}`);
    if ('enabled' in b)            sets.push(`enabled = ${b.enabled ? 'true' : 'false'}`);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push(`updated_at = now()`);
    await db.query(`UPDATE canva_templates SET ${sets.join(', ')} WHERE id = ${db.q(req.params.id)};`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/canva/templates/:id', auth.middleware, async (req, res) => {
  try {
    await db.query(`UPDATE canva_templates SET enabled = false, updated_at = now() WHERE id = ${db.q(req.params.id)};`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Live fetch of slot dataset from Canva to help the founder map slots.
app.get('/canva/templates/:id/canva-info', async (req, res) => {
  try {
    const row = await db.queryOne(`SELECT canva_template_id FROM canva_templates WHERE id = ${db.q(req.params.id)};`);
    if (!row) return res.status(404).json({ ok: false, error: 'template not registered' });
    const r = await canva.getBrandTemplate(row.canva_template_id);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Live fetch of all available brand templates from Canva (so founder
// can pick from a dropdown rather than typing IDs).
app.get('/canva/brand-templates', async (req, res) => {
  try {
    const r = await canva.listBrandTemplates({
      brandId:   req.query.brand_id || null,
      query:     req.query.q || null,
      limit:     parseInt(req.query.limit, 10) || 50,
      continuation: req.query.continuation || null,
    });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Sizes (founder-managed Magic-Resize targets) ───────────────────────
app.get('/canva/sizes', async (_req, res) => {
  try {
    const json = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(s) ORDER BY enabled DESC, platform, name), '[]'::json)
        FROM (SELECT id::text, name, width_px, height_px, platform, enabled, created_at::text
                FROM canva_sizes) s;`);
    res.json({ ok: true, sizes: JSON.parse(json || '[]') });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/canva/sizes', auth.middleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.width_px || !b.height_px) return res.status(400).json({ ok: false, error: 'name + width_px + height_px required' });
    const id = await db.queryReturning(`
      INSERT INTO canva_sizes (name, width_px, height_px, platform, enabled) VALUES (
        ${db.q(b.name)}, ${parseInt(b.width_px, 10)}, ${parseInt(b.height_px, 10)},
        ${b.platform ? db.q(b.platform) : 'NULL'},
        ${b.enabled === false ? 'false' : 'true'}
      ) RETURNING id::text;`);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/canva/sizes/:id', auth.middleware, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    if ('name' in b)      sets.push(`name = ${db.q(b.name)}`);
    if ('width_px' in b)  sets.push(`width_px = ${parseInt(b.width_px, 10)}`);
    if ('height_px' in b) sets.push(`height_px = ${parseInt(b.height_px, 10)}`);
    if ('platform' in b)  sets.push(`platform = ${b.platform == null ? 'NULL' : db.q(b.platform)}`);
    if ('enabled' in b)   sets.push(`enabled = ${b.enabled ? 'true' : 'false'}`);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    await db.query(`UPDATE canva_sizes SET ${sets.join(', ')} WHERE id = ${db.q(req.params.id)};`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/canva/sizes/:id', auth.middleware, async (req, res) => {
  try {
    await db.query(`UPDATE canva_sizes SET enabled = false WHERE id = ${db.q(req.params.id)};`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Dynamic options resolver — feeds the Compose form ──────────────────
// The recipe declares `dynamic_source: 'canva-templates'` (or 'canva-sizes').
// The dashboard hits this endpoint at form-render time so dropdowns
// populate from live DB rows rather than hardcoded JSON.
app.get('/canva/dynamic-options/:recipeId', async (req, res) => {
  try {
    const tplJson = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(t) ORDER BY slot_type, name), '[]'::json)
        FROM (SELECT id::text, name, slot_type, platform, language, canva_template_id
                FROM canva_templates WHERE enabled = true) t;`);
    const sizeJson = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(s) ORDER BY platform, name), '[]'::json)
        FROM (SELECT id::text, name, width_px, height_px, platform
                FROM canva_sizes WHERE enabled = true) s;`);
    res.json({
      ok: true,
      recipe_id: req.params.recipeId,
      templates: JSON.parse(tplJson || '[]'),
      sizes: JSON.parse(sizeJson || '[]'),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Magic-Resize fan-out for an existing compose run ───────────────────
// Body: { lang?: 'fa', size_ids: ['<uuid>', ...], from_slide_n?: 1 }
// Picks the source design from the run's canva-render output and
// resizes it across each requested size. Persists one canva_runs row
// per output for traceability.
app.post('/compose/runs/:id/canva-fanout', auth.middleware, async (req, res) => {
  try {
    if (!await canva.hasTokenAsync()) return res.status(400).json({ ok: false, error: 'Canva token not set' });
    const run = await composeOrchestrator.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'run not found' });

    const lang = (req.body && req.body.lang) || run.master_lang;
    const fromSlideN = (req.body && req.body.from_slide_n) || 1;
    const sizeIds = (req.body && Array.isArray(req.body.size_ids)) ? req.body.size_ids : [];
    if (!sizeIds.length) return res.status(400).json({ ok: false, error: 'size_ids required (array of UUIDs)' });

    // Find the source canva-render stage output
    const stage = (run.stages || []).find(s =>
      (s.stage_name === 'canva-render' || s.stage_name === 'render') &&
      (s.lang || run.master_lang) === lang &&
      s.status === 'done');
    if (!stage || !stage.output) return res.status(400).json({ ok: false, error: `no canva-render output for lang=${lang}` });

    const slides = (stage.output.slides || []).filter(s => s && s.canva_design_id);
    if (!slides.length) return res.status(400).json({ ok: false, error: 'no canva designs found in stage output' });

    const source = slides.find(s => s.n === fromSlideN) || slides[0];
    if (!source) return res.status(400).json({ ok: false, error: 'source slide not found' });

    // Look up size rows
    const sizeJson = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json) FROM (
        SELECT id::text, name, width_px, height_px, platform FROM canva_sizes
         WHERE id IN (${sizeIds.map(id => db.q(id)).join(',')}) AND enabled = true
      ) s;`);
    const sizes = JSON.parse(sizeJson || '[]');
    if (!sizes.length) return res.status(400).json({ ok: false, error: 'no enabled sizes match the IDs' });

    const r = await canva.resize({
      designId: source.canva_design_id,
      custom: sizes.map(s => ({ width_px: s.width_px, height_px: s.height_px, name: s.name })),
    });
    if (!r.ok) return res.status(400).json(r);

    // Persist a canva_runs row per output and find each design's edit URL
    const out = [];
    for (let i = 0; i < r.results.length; i++) {
      const result = r.results[i];
      const size = sizes[i];
      const designId = result && result.design && result.design.id;
      let editUrl = null, viewUrl = null;
      if (designId) {
        const d = await canva.getDesign(designId);
        if (d.ok && d.design && d.design.urls) {
          editUrl = d.design.urls.edit_url || d.design.urls.edit;
          viewUrl = d.design.urls.view_url || d.design.urls.view;
        }
      }
      try {
        await db.query(`
          INSERT INTO canva_runs (compose_run_id, slide_n, canva_design_id, edit_url, view_url, size_id, status, finished_at)
          VALUES (
            ${db.q(req.params.id)}, NULL,
            ${designId ? db.q(designId) : 'NULL'},
            ${editUrl ? db.q(editUrl) : 'NULL'},
            ${viewUrl ? db.q(viewUrl) : 'NULL'},
            ${db.q(size.id)},
            ${result.ok ? `'ready'` : `'failed'`},
            now()
          );`);
      } catch (_) {}
      out.push({ size, ok: !!result.ok, design_id: designId, edit_url: editUrl, view_url: viewUrl, error: result.error || null });
    }
    res.json({ ok: true, source_design_id: source.canva_design_id, results: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// List canva_runs rows for a compose run (per-slide originals + fan-out children).
app.get('/compose/runs/:id/canva-runs', async (req, res) => {
  try {
    const json = await db.queryValue(`
      SELECT COALESCE(json_agg(row_to_json(r) ORDER BY parent_run_id NULLS FIRST, slide_n, created_at), '[]'::json)
        FROM (SELECT id::text, compose_run_id::text, slide_n, canva_design_id, edit_url, view_url,
                     template_id::text, size_id::text, parent_run_id::text, status, error,
                     created_at::text, finished_at::text
                FROM canva_runs WHERE compose_run_id = ${db.q(req.params.id)}) r;`);
    res.json({ ok: true, runs: JSON.parse(json || '[]') });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M43 · Eval harness routes ───────────────────────────────────────────
//   GET    /evals/golden-prompts                       — list (?country, ?recipe)
//   GET    /evals/golden-prompts/:id                   — single
//   POST   /evals/golden-prompts                       — create (auth)
//   PATCH  /evals/golden-prompts/:id                   — update (auth)
//   DELETE /evals/golden-prompts/:id                   — archive (auth)
//   POST   /evals/run-candidate                        — { promptId, options? } → starts a candidate compose run (auth)
//   POST   /evals/judge                                — { promptId, candidateRunId } → judge & persist (auth)
//   POST   /evals/run-and-judge                        — convenience: candidate + run-to-block + judge (auth)
//   GET    /evals/runs                                 — list pairwise runs (?promptId, ?country)
//   GET    /evals/scoreboard                           — win/loss/tie per country+recipe (?country)
app.get('/evals/golden-prompts', async (req, res) => {
  try {
    const items = await evalHarness.listGoldenPrompts({
      country: req.query.country || null,
      recipeId: req.query.recipe || null,
      limit: parseInt(req.query.limit, 10) || 100,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/evals/golden-prompts/:id', async (req, res) => {
  try {
    const item = await evalHarness.getGoldenPrompt(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/evals/golden-prompts', auth.middleware, async (req, res) => {
  try {
    const r = await evalHarness.createGoldenPrompt(req.body || {});
    log(`evals.create-prompt id=${r.id}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.patch('/evals/golden-prompts/:id', auth.middleware, async (req, res) => {
  try {
    const r = await evalHarness.updateGoldenPrompt(req.params.id, req.body || {});
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.delete('/evals/golden-prompts/:id', auth.middleware, async (req, res) => {
  try {
    const r = await evalHarness.archiveGoldenPrompt(req.params.id);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/evals/run-candidate', auth.middleware, async (req, res) => {
  try {
    const { promptId, ...overrides } = req.body || {};
    if (!promptId) return res.status(400).json({ ok: false, error: 'promptId required' });
    const r = await evalHarness.runCandidate(promptId, overrides);
    log(`evals.run-candidate prompt=${promptId} candidate=${r.candidate_run_id}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/evals/judge', auth.middleware, async (req, res) => {
  try {
    const { promptId, candidateRunId, judgeAgent } = req.body || {};
    if (!promptId || !candidateRunId) {
      return res.status(400).json({ ok: false, error: 'promptId + candidateRunId required' });
    }
    const r = await evalHarness.judgePairwise(promptId, candidateRunId, { judgeAgent });
    log(`evals.judge prompt=${promptId} winner=${r.verdict.winner_overall}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Convenience: start candidate + run-to-block + judge in one POST. Used by the
// dashboard's eval workflow ("Run + judge").
app.post('/evals/run-and-judge', auth.middleware, async (req, res) => {
  try {
    const { promptId, judgeAgent, ...overrides } = req.body || {};
    if (!promptId) return res.status(400).json({ ok: false, error: 'promptId required' });
    const r = await evalHarness.runCandidate(promptId, overrides);
    // Run candidate to completion (or block) — evals always run end-to-end (no founder gates).
    await composeOrchestrator.runToBlock(r.candidate_run_id, { maxIterations: 60 });
    const j = await evalHarness.judgePairwise(promptId, r.candidate_run_id, { judgeAgent });
    log(`evals.run-and-judge prompt=${promptId} winner=${j.verdict.winner_overall}`);
    res.json({ ok: true, candidate_run_id: r.candidate_run_id, ...j });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/evals/runs', async (req, res) => {
  try {
    const items = await evalHarness.listEvalRuns({
      promptId: req.query.promptId || null,
      country: req.query.country || null,
      limit: parseInt(req.query.limit, 10) || 100,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/evals/scoreboard', async (req, res) => {
  try {
    const rows = await evalHarness.scoreboard({ country: req.query.country || null });
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M46 · Regulatory watchdog ───────────────────────────────────────────
//   GET    /watchdog/watchpoints                  — list (?country, ?active)
//   POST   /watchdog/watchpoints                  — create (auth)
//   PATCH  /watchdog/watchpoints/:id              — update (auth)
//   DELETE /watchdog/watchpoints/:id              — archive (auth)
//   POST   /watchdog/check/:id                    — check one (auth)
//   POST   /watchdog/check                        — check all (auth) — call from Railway cron / n8n
//   GET    /watchdog/drift-events                 — list (?status)
//   POST   /watchdog/drift-events/:id/resolve     — { status: reviewed|dismissed|kb-updated, note? } (auth)
//   GET    /watchdog/pending-count                — for the Inbox badge
app.get('/watchdog/watchpoints', async (req, res) => {
  try {
    const items = await watchdog.listWatchpoints({
      country: req.query.country || null,
      active: req.query.active === 'true' ? true : (req.query.active === 'false' ? false : null),
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/watchdog/watchpoints', auth.middleware, async (req, res) => {
  try { res.json(await watchdog.createWatchpoint(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.patch('/watchdog/watchpoints/:id', auth.middleware, async (req, res) => {
  try { res.json(await watchdog.updateWatchpoint(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/watchdog/watchpoints/:id', auth.middleware, async (req, res) => {
  try { res.json(await watchdog.archiveWatchpoint(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/watchdog/check/:id', auth.middleware, async (req, res) => {
  try { res.json(await watchdog.checkOne(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/watchdog/check', auth.middleware, async (_req, res) => {
  try {
    const r = await watchdog.checkAll();
    log(`watchdog.check-all checked=${r.checked} changed=${r.changed} errors=${r.errors}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/watchdog/drift-events', async (req, res) => {
  try {
    const items = await watchdog.listDriftEvents({
      status: req.query.status || null,
      limit: parseInt(req.query.limit, 10) || 100,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/watchdog/drift-events/:id/resolve', auth.middleware, async (req, res) => {
  try {
    const { status, note } = req.body || {};
    res.json(await watchdog.resolveDriftEvent(req.params.id, { status, note }));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// ── M47 · DM inbox + triage ────────────────────────────────────────────
app.get('/dm/inbox', async (req, res) => {
  try {
    const items = await dmTriage.listInbox({
      status: req.query.status || null,
      untriaged: req.query.untriaged === 'true',
      source: req.query.source || null,
      limit: parseInt(req.query.limit, 10) || 100,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/dm/counts', async (_req, res) => {
  try { res.json({ ok: true, counts: await dmTriage.counts() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/dm/inbox', auth.middleware, async (req, res) => {
  try { res.json(await dmTriage.ingest(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/dm/inbox/:id/triage', auth.middleware, async (req, res) => {
  try {
    const auto = (req.body && req.body.autoDraftReply !== false);
    res.json(await dmTriage.triage(req.params.id, { autoDraftReply: auto }));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/dm/inbox/:id/draft', auth.middleware, async (req, res) => {
  try { res.json(await dmTriage.draftReply(req.params.id)); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// ── M48 · Fan-out (1 source → N channels) ──────────────────────────────
//   POST /fanout/expand { sourceRunId, channels[], options?, gateStrategy?, masterLang?, targetLangs?, agentOverrides? }
//   GET  /fanout/children/:sourceRunId
app.post('/fanout/expand', auth.middleware, async (req, res) => {
  try {
    const r = await fanout.expand(req.body || {});
    log(`fanout.expand src=${r.source_run_id} channels=${(r.children || []).map(c => c.recipe).join(',')}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/fanout/children/:sourceRunId', async (req, res) => {
  try { res.json({ ok: true, children: await fanout.listChildren(req.params.sourceRunId) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── M51 · Memory maintenance ────────────────────────────────────────────
app.post('/memory/maintenance/run', auth.middleware, async (req, res) => {
  try {
    const r = await memMaint.run(req.body || {});
    log(`memory.maintenance decayed=${r.decayed} promoted=${r.promoted}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/memory/health', async (_req, res) => {
  try { res.json({ ok: true, ...(await memMaint.health()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/memory/maintenance/runs', async (req, res) => {
  try {
    const items = await memMaint.listMaintenanceRuns({ limit: parseInt(req.query.limit, 10) || 30 });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/memory/promotion-score/bump', auth.middleware, async (req, res) => {
  try { res.json(await memMaint.bumpPromotionScore(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── M55 · Brand intelligence (dynamic agent training) ─────────────────────
//
// CRUD on intelligence rules + exemplars + voice fingerprint, plus the
// bulk-import endpoint for the local analyzer's JSON outputs.

// Rules / intelligence
app.get('/brand/intelligence', async (req, res) => {
  try {
    const items = await brandInt.listIntelligence({
      kind: req.query.kind || null,
      target_agent: req.query.agent || null,
      platform: req.query.platform || null,
      language: req.query.language || null,
      enabled: req.query.enabled === 'true' ? true : (req.query.enabled === 'false' ? false : null),
      limit: parseInt(req.query.limit, 10) || 200,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/brand/intelligence', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.createIntelligence(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.patch('/brand/intelligence/:id', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.updateIntelligence(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/brand/intelligence/:id', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.deleteIntelligence(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Exemplars
app.get('/brand/exemplars', async (req, res) => {
  try {
    const items = await brandInt.listExemplars({
      kind: req.query.kind || null,
      platform: req.query.platform || null,
      language: req.query.language || null,
      limit: parseInt(req.query.limit, 10) || 200,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/brand/exemplars', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.createExemplar(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.patch('/brand/exemplars/:id', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.updateExemplar(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/brand/exemplars/:id', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.deleteExemplar(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Voice fingerprint
app.get('/brand/fingerprint', async (req, res) => {
  try {
    const items = await brandInt.listFingerprint({
      cluster: req.query.cluster || null,
      language: req.query.language || null,
      limit: parseInt(req.query.limit, 10) || 200,
    });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/brand/fingerprint', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.createFingerprint(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.patch('/brand/fingerprint/:id', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.updateFingerprint(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/brand/fingerprint/:id', auth.middleware, async (req, res) => {
  try { res.json(await brandInt.deleteFingerprint(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Counts + uploads provenance
app.get('/brand/counts', async (_req, res) => {
  try { res.json({ ok: true, counts: await brandInt.counts() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/brand/uploads', async (req, res) => {
  try {
    const items = await brandInt.listUploads({ limit: parseInt(req.query.limit, 10) || 50 });
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Bulk imports (called by tools/brand-analyzer/upload.js)
app.post('/brand/archive/upload', auth.middleware, async (req, res) => {
  try {
    const r = await brandInt.importPublicArchive(req.body || {});
    log(`brand.import.public source=${r.source} intelligence=${r.intelligence} exemplars=${r.exemplars} fp=${r.fingerprint}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/brand/dm-analysis/upload', auth.middleware, async (req, res) => {
  try {
    const r = await brandInt.importDmAnalysis(req.body || {});
    log(`brand.import.dm source=${r.source} intelligence=${r.intelligence} exemplars=${r.exemplars} fp=${r.fingerprint}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// M56 batch B · Afshin visual reference upload (one image at a time)
//   Body: { filename, b64, mime, metadata: { post_id, platform, language, layout, style, palette, topic_tags, outcome } }
//   Side effects:
//     1. Uploads image bytes to R2 under brand-references/<safeId>.<ext>
//     2. Inserts media_library row (kind='custom', owner_agent='afshin', approved=true)
//     3. Inserts brand_exemplars row (kind='design_brief', source=stamp, topic_tags from metadata)
app.post('/brand/visual-references/upload', auth.middleware, async (req, res) => {
  try {
    const { filename, b64, mime = 'image/jpeg', metadata = {}, sourceLabel = null } = req.body || {};
    if (!filename || !b64) return res.status(400).json({ ok: false, error: 'filename + b64 required' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.length > 20 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: `image size out of bounds (${buf.length} bytes)` });
    }
    const stamp = sourceLabel || `brand_visuals_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

    // Build a deterministic ID so re-uploads of the same filename are idempotent
    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
    const mediaId = require('crypto').createHash('sha1').update(stamp + ':' + safeName).digest('hex').slice(0, 32);
    const ext = (filename.match(/\.([A-Za-z0-9]+)$/) || [])[1] || (mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg');
    const r2Key = `brand-references/${mediaId}.${ext}`;

    // 1. Upload to R2
    const storage = require('./storage');
    await storage.put({ key: r2Key, body: buf, contentType: mime });

    // 2. media_library row (idempotent on (id))
    const { query, qJson, q } = require('./db');
    // Use a deterministic UUID v5-ish: convert sha1 hex to uuid format
    const u = mediaId.padEnd(32, '0');
    const uuid = `${u.slice(0,8)}-${u.slice(8,12)}-${u.slice(12,16)}-${u.slice(16,20)}-${u.slice(20,32)}`;
    await query(`
      INSERT INTO media_library (id, kind, topic, language, prompt, owner_agent, approved, approved_at, dimensions, metadata)
      VALUES (${q(uuid)}, 'custom',
              ${q(metadata.topic || filename)},
              ${q(metadata.language || 'fa')},
              ${q(`Brand reference imported from analyzer · ${filename}`)},
              'afshin', true, NOW(),
              ${q(metadata.dimensions || '1080x1080')},
              ${qJson({
                source: 'brand_visual_references',
                source_label: stamp,
                analysis_metadata: metadata,
                r2_key: r2Key,
                original_filename: filename,
              })})
      ON CONFLICT (id) DO UPDATE SET
        prompt = EXCLUDED.prompt,
        metadata = EXCLUDED.metadata;
    `);
    // Update render_path so the dashboard's Designs gallery picks it up
    await query(`UPDATE media_library SET render_path = ${q(r2Key)}, render_cost_usd = 0 WHERE id = ${q(uuid)};`);

    // 3. brand_exemplars row for retrieval at design-stage time
    const url = (storage.urlFor ? storage.urlFor(r2Key) : null) || `/storage/${r2Key}`;
    const tags = Array.isArray(metadata.topic_tags) ? metadata.topic_tags.slice(0, 12) : [];

    // The body captures a useful descriptive anchor + the retrievable URL
    const descParts = [];
    if (metadata.style)   descParts.push(`Style: ${metadata.style}`);
    if (metadata.layout)  descParts.push(`Layout: ${metadata.layout}`);
    if (metadata.subject) descParts.push(`Subject: ${metadata.subject}`);
    if (Array.isArray(metadata.dominant_colors) && metadata.dominant_colors.length)
      descParts.push(`Dominant colors: ${metadata.dominant_colors.join(', ')}`);
    if (metadata.logo && metadata.logo.position)
      descParts.push(`Logo: ${metadata.logo.position}, ${metadata.logo.size_pct || '?'}% canvas, ${metadata.logo.opacity || '?'}`);
    if (Array.isArray(metadata.brand_pattern_motifs) && metadata.brand_pattern_motifs.length)
      descParts.push(`Motifs: ${metadata.brand_pattern_motifs.join('; ')}`);
    descParts.push(`URL: ${url}`);
    descParts.push(`(Use this past design as a style reference. When image_model supports reference images (Recraft V3, Ideogram V3), pass this URL via the provider's reference-image parameter. Otherwise, anchor the prompt to its style/layout/palette description above.)`);
    const body = descParts.join('\n');

    await brandInt.createExemplar({
      kind: 'design_brief',
      platform: metadata.platform || null,
      language: metadata.language || null,
      body,
      context: metadata.original_post_url || metadata.post_id || filename,
      topic_tags: tags,
      importance: metadata.outcome === 'top_engagement' ? 5 : 4,
      source: stamp,
      source_ref: filename,
      outcome: metadata.outcome || 'brand_reference',
    });

    res.json({ ok: true, media_id: uuid, r2_key: r2Key, url, source: stamp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// M56 · DM tone profile import (different shape from dm_question_patterns + dm_objection_playbook)
app.post('/brand/dm-tone-profile/upload', auth.middleware, async (req, res) => {
  try {
    const r = await brandInt.importDmToneProfile(req.body || {});
    log(`brand.import.dm-tone source=${r.source} intelligence=${r.intelligence} exemplars=${r.exemplars}`);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── M64 · Unsplash stock photos ──────────────────────────────────────
//
// GET  /unsplash/status                  → { ok, has_key }
// GET  /unsplash/search?query=...&orientation=&per_page=
//        Search; returns up to 30 photos with photographer attribution.
//        Read-only for the founder's "Browse stock" UI; no auth required
//        (read-only public search).
// POST /unsplash/import   (auth)
//        Body: { photo_id, download_location, url_to_fetch, photographer,
//                topic, language, topic_tags }
//        Downloads the photo to R2, registers in media_library with
//        attribution metadata, and triggers Unsplash's download counter
//        for the photographer (compliance — required by their API terms).
// POST /unsplash/quick-pick   (auth)
//        Body: { query, orientation?, topic?, language?, topic_tags? }
//        Searches + imports the top result in one shot. For Afshin's
//        automated "give me a hero photo about X" flow.
app.get('/unsplash/status', (_, res) => {
  res.json({ ok: true, has_key: unsplash.hasKey() });
});

app.get('/unsplash/search', async (req, res) => {
  if (!unsplash.hasKey()) {
    return res.status(503).json({ ok: false, error: 'UNSPLASH_ACCESS_KEY not set on server' });
  }
  const r = await unsplash.searchPhotos({
    query: req.query.query || req.query.q,
    perPage: parseInt(req.query.per_page, 10) || 12,
    orientation: req.query.orientation || null,
    contentFilter: req.query.content_filter === 'high' ? 'high' : 'low',
  });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.post('/unsplash/import', auth.middleware, async (req, res) => {
  if (!unsplash.hasKey()) {
    return res.status(503).json({ ok: false, error: 'UNSPLASH_ACCESS_KEY not set on server' });
  }
  try {
    const { photo_id, download_location, url_to_fetch, photographer,
            topic, language, topic_tags } = req.body || {};
    const r = await unsplash.importPhoto({
      photoId: photo_id,
      downloadLocation: download_location,
      urlToFetch: url_to_fetch,
      photographer,
      topic, language,
      topicTags: Array.isArray(topic_tags) ? topic_tags : [],
    });
    if (!r.ok) return res.status(400).json(r);
    log(`unsplash.import id=${photo_id} → media ${r.media_id.slice(0, 8)} by ${photographer && photographer.name || '?'}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/unsplash/quick-pick', auth.middleware, async (req, res) => {
  if (!unsplash.hasKey()) {
    return res.status(503).json({ ok: false, error: 'UNSPLASH_ACCESS_KEY not set on server' });
  }
  try {
    const { query: qText, orientation, topic, language, topic_tags } = req.body || {};
    if (!qText) return res.status(400).json({ ok: false, error: 'query required' });
    const r = await unsplash.quickPick({
      query: qText,
      orientation: orientation || null,
      topic: topic || qText,
      language: language || null,
      topicTags: Array.isArray(topic_tags) ? topic_tags : [],
    });
    if (!r.ok) return res.status(400).json(r);
    log(`unsplash.quickPick "${qText.slice(0,60)}" → media ${r.media_id.slice(0, 8)} by ${r.photographer && r.photographer.name || '?'}`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M56 · Per-agent training packet preview (what the agent will SEE on next call)
// M58 · Now also returns the SKILL.md excerpt + KPIs so the founder sees all
//       four training surfaces (skill, brand, train-tab memory, scores) in one view.
app.get('/training/preview', async (req, res) => {
  try {
    const trainingRetrieval = require('./agent-training-retrieval');
    const agent = req.query.agent || null;
    const stage = req.query.stage || 'draft';
    const packet = await trainingRetrieval.getTrainingPacket({
      agent,
      stageName: stage,
      platform: req.query.platform || null,
      language: req.query.language || null,
      topicTags: (req.query.topics || '').split(',').map(s => s.trim()).filter(Boolean),
    });

    // Pull SKILL.md (block 1 of every system prompt — what the founder edits in
    // the Prompt tab). Stripped of YAML frontmatter for the preview.
    let skill_md = null;
    if (agent && AGENT_NAME_RE.test(agent)) {
      try {
        const p = path.join(AGENTS_DIR, agent, 'SKILL.md');
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          skill_md = raw.length > 4000 ? raw.slice(0, 4000) + '\n…(truncated)' : raw;
        }
      } catch (_) {}
    }

    // Pull recent KPIs (the founder's stars from the rating sub-tab) so the
    // preview reflects all four sources, not just the three retrieved ones.
    let kpis = null;
    if (agent) {
      try { kpis = await agentEvals.getKPIsForAgent(agent, 14); } catch (_) {}
    }

    res.json({
      ok: true,
      agent, stage,
      sources: {
        skill_md_present: !!skill_md,
        rules_count:      (packet.rules || []).length,
        exemplars_count:  (packet.exemplars || []).length,
        memories_count:   (packet.memories || []).length,
        rating_signal:    packet.rating_signal || null,
      },
      skill_md,
      kpis,
      packet,
      rendered: trainingRetrieval.renderUnifiedBlock(packet),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M56 · Promotion proposals (librarian → founder review)
app.get('/training/promotions', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const limit = parseInt(req.query.limit, 10) || 50;
    const { queryRows } = require('./db');
    const rows = await queryRows(`
      SELECT id::text, source_kind, source_id::text, source_agent,
              proposed_kind, proposed_target_agent, proposed_scope_platform,
              proposed_scope_language, proposed_topic_tags, proposed_rule_text,
              proposed_importance, promotion_reason, recurrence_count, avg_rating,
              detected_at::text, status, decided_at::text, decided_by, decision_note
        FROM training_promotion_proposals
       WHERE status = '${String(status).replace(/'/g, "''")}'
       ORDER BY detected_at DESC LIMIT ${limit};`);
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Founder approves a promotion proposal — creates the brand_intelligence row
app.post('/training/promotions/:id/approve', auth.middleware, async (req, res) => {
  try {
    const { query, queryRows, queryReturning, q, qJson } = require('./db');
    const rows = await queryRows(`SELECT * FROM training_promotion_proposals WHERE id = '${String(req.params.id).replace(/'/g, "''")}' LIMIT 1;`);
    const p = rows[0];
    if (!p) return res.status(404).json({ ok: false, error: 'proposal not found' });
    if (p.status !== 'pending') return res.status(400).json({ ok: false, error: `already ${p.status}` });
    // Create the intelligence row
    const created = await brandInt.createIntelligence({
      kind: p.proposed_kind,
      target_agent: p.proposed_target_agent || null,
      scope_platform: p.proposed_scope_platform || null,
      scope_language: p.proposed_scope_language || null,
      topic_tags: p.proposed_topic_tags || [],
      rule_text: p.proposed_rule_text,
      importance: p.proposed_importance,
      source: 'promoted_from_memory',
      source_ref: p.source_id,
      founder_edited: true,
      founder_note: req.body && req.body.note,
    });
    await query(`UPDATE training_promotion_proposals
                    SET status='approved', decided_at=NOW(),
                        decided_by=${q((req.user && req.user.username) || 'founder')},
                        decision_note=${q(req.body && req.body.note)},
                        resulting_intelligence_id=${q(created.id)}
                  WHERE id=${q(p.id)};`);
    log(`training.promotion.approved id=${p.id} → intelligence ${created.id}`);
    res.json({ ok: true, intelligence_id: created.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/training/promotions/:id/reject', auth.middleware, async (req, res) => {
  try {
    const { query, q } = require('./db');
    await query(`UPDATE training_promotion_proposals
                    SET status='rejected', decided_at=NOW(),
                        decided_by=${q((req.user && req.user.username) || 'founder')},
                        decision_note=${q(req.body && req.body.note)}
                  WHERE id=${q(req.params.id)} AND status='pending';`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// M56 · Librarian scan — find candidates to promote. Founder approves manually.
//   Heuristic: agent_memory rows of type=procedural with promotion_score>=3
//   AND not already promoted (no resulting_intelligence_id pointing at them).
app.post('/training/promotions/scan', auth.middleware, async (_req, res) => {
  try {
    const { query, queryRows, queryReturning, q, qArr } = require('./db');
    // Find unpromoted procedural memories with proven repetition
    const candidates = await queryRows(`
      SELECT m.id::text, m.agent, m.content, m.tags, m.importance, m.promotion_score
        FROM agent_memory m
        LEFT JOIN training_promotion_proposals p ON p.source_id = m.id
       WHERE m.type = 'procedural'
         AND COALESCE(m.archived, false) = false
         AND COALESCE(m.promotion_score, 0) >= 3
         AND p.id IS NULL
       ORDER BY m.promotion_score DESC LIMIT 50;`);
    let proposed = 0;
    for (const c of candidates) {
      await queryReturning(`
        INSERT INTO training_promotion_proposals
          (source_kind, source_id, source_agent, proposed_kind, proposed_rule_text,
            proposed_importance, proposed_topic_tags, promotion_reason, recurrence_count)
        VALUES ('agent_memory', ${q(c.id)}, ${q(c.agent)}, 'manual',
                ${q(c.content)}, ${parseInt(c.importance || 4, 10)},
                ${qArr(Array.isArray(c.tags) ? c.tags : [])},
                'recurring_correction', ${parseInt(c.promotion_score, 10) || 0})
        RETURNING id::text;`);
      proposed++;
    }
    log(`training.promotion.scan proposed=${proposed}`);
    res.json({ ok: true, proposed });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/brand/cache/clear', auth.middleware, (_req, res) => {
  try { brandInt.clearCache(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/dm/inbox/:id/action', auth.middleware, async (req, res) => {
  try {
    const { action, note } = req.body || {};
    res.json(await dmTriage.setFounderAction(req.params.id, { action, note }));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/watchdog/pending-count', async (_req, res) => {
  try { res.json({ ok: true, pending: await watchdog.pendingCount() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

// Root → dashboard. Without this, hitting bare https://rxapply.com after
// the wizard is finished returns Express's default "Cannot GET /". The
// firstRunGate redirects to /setup until setup is done; once first_run_done
// flips to true we always land here on /dashboard.
app.get('/', (_, res) => res.redirect(302, '/dashboard'));

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

// M72B · Legacy Drawflow pipeline runner endpoints renamed to
// /pipeline-runner/* to free up /pipelines/* for the new compose-pipeline
// management API (M72A). The legacy ad-hoc agent pipelines feature remains
// available at /pipeline-runner if anyone still uses it.
app.get('/pipeline-runner', async (_, res) => {
  try {
    res.json({ ok: true, pipelines: await pipelineRunner.listPipelines() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/pipeline-runner', auth.middleware, async (req, res) => {
  const { name, description, graphData } = req.body || {};
  const r = await pipelineRunner.savePipeline({ name, description, graphData });
  if (!r.ok) return res.status(400).json(r);
  log(`pipeline-runner.save name=${name} nodes=${r.nodeCount}`);
  res.json(r);
});

app.get('/pipeline-runner/:name', async (req, res) => {
  const r = await pipelineRunner.loadPipeline(req.params.name);
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
});

app.delete('/pipeline-runner/:name', auth.middleware, async (req, res) => {
  const r = await pipelineRunner.deletePipeline(req.params.name);
  if (!r.ok) return res.status(404).json(r);
  log(`pipeline-runner.delete name=${req.params.name}`);
  res.json(r);
});

// IMPORTANT: /pipeline-runner/run MUST be registered before /pipeline-runner/:name/run
// (Express matches in order; ":name" would otherwise capture "run").
app.post('/pipeline-runner/run', auth.middleware, async (req, res) => {
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

app.post('/pipeline-runner/:name/run', auth.middleware, async (req, res) => {
  // SSE stream of pipeline execution.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');

  function emit(event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  log(`pipeline-runner.run name=${req.params.name}`);
  try {
    const inlineGraph = req.body && req.body.graphData;
    await pipelineRunner.runPipeline({ name: req.params.name, graphData: inlineGraph }, emit);
  } catch (e) {
    emit('error', { message: e.message });
  }
  res.end();
});

// GET /agents — list known agent folders
// M79 · Now also includes capabilities (from agent-capabilities.js) and
// stage-file count so the Agents tab can show what each agent does
// without a second API call.
app.get('/agents', (_, res) => {
  if (!fs.existsSync(AGENTS_DIR)) return res.json({ ok: true, agents: [], dir: AGENTS_DIR });
  let caps = null;
  try { caps = require('./agent-capabilities'); } catch (_) {}
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents = entries
    .filter(d => d.isDirectory() && AGENT_NAME_RE.test(d.name))
    .map(d => {
      const dir = path.join(AGENTS_DIR, d.name);
      const hasSkill = fs.existsSync(path.join(dir, 'SKILL.md'));
      const helperPath = path.join(dir, `${d.name}.py`);
      const hasHelper = fs.existsSync(helperPath);
      const capabilities = caps ? (caps.capabilitiesFor(d.name) || []) : [];
      const stagesDir = path.join(dir, 'stages');
      let stageCount = 0;
      if (fs.existsSync(stagesDir)) {
        try { stageCount = fs.readdirSync(stagesDir).filter(f => f.endsWith('.md')).length; } catch (_) {}
      }
      return { agent: d.name, dir, hasSkill, hasHelper, capabilities, stageCount };
    });
  res.json({ ok: true, count: agents.length, agents });
});

// ── start ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 7777;
// T1 · Tools framework — mount the router and seed the catalog into Postgres
// on boot so the UI's catalog list never lags behind the registry.
app.use('/tools', toolsRouter);

// Boot sequence: migrate → tools registry sync → start listening.
//   1. migrate.runIfNeeded() applies any pending SQL migrations. Set
//      MIGRATE_ON_BOOT=false in env to skip.
//   2. tools registry sync.
(async () => {
  try {
    const r = await migrate.runIfNeeded();
    if (r && r.failed) console.error(`[boot] migration FAILED: ${r.failed.error || r.failed}`);
  } catch (e) { console.error(`[boot] migrate.runIfNeeded threw: ${e.message}`); }
  try {
    const n = await toolsRegistry.sync();
    console.log(`  tools registry: synced ${n} tools to Postgres`);
  } catch (e) { console.error(`  tools registry sync failed: ${e.message}`); }
  // M72A · Bootstrap pipelines table from compose-recipes/*.json on first
  // boot. Idempotent: skipped when the table already has rows.
  try {
    await composeOrchestrator.ensurePipelinesLoaded();
  } catch (e) { console.error(`  pipelines bootstrap failed: ${e.message}`); }
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
  console.log(`    ANTHROPIC_API_KEY    ${present(process.env.ANTHROPIC_API_KEY)}`);
  console.log(`    OPENAI_API_KEY       ${present(process.env.OPENAI_API_KEY)}`);
  console.log(`    N8N_API_KEY          ${present(process.env.N8N_API_KEY)}`);
  // M101b · Image pipeline diagnostics. Without UNSPLASH_ACCESS_KEY,
  // Tarrah's image_source='mixed' silently degrades to 'generated' (M101).
  // This boot line tells the founder what to expect at a glance.
  console.log(`    UNSPLASH_ACCESS_KEY  ${present(process.env.UNSPLASH_ACCESS_KEY)}`);
  console.log(`    CANVA_API_TOKEN      ${present(process.env.CANVA_API_TOKEN)}`);
  log(`startup port=${PORT} mode=${MODE} authInit=${auth.isInitialized()} anth=${!!process.env.ANTHROPIC_API_KEY} openai=${!!process.env.OPENAI_API_KEY} n8n=${!!process.env.N8N_API_KEY}`);

  // M95 · Single-source-of-truth control map
  // Print which endpoint owns which write path so the founder can audit
  // for parallel writes. After V10's consolidation, every piece of agent
  // state should have ONE owner.
  console.log('');
  console.log('  \x1b[1mM95 · Control surface map (single source of truth):\x1b[0m');
  console.log('    SKILL.md             → PUT /prompts/:agent             (Brain tab)');
  console.log('    Stage instructions   → PUT /agents/:agent/stages/:stage (Brain tab + Pipeline drawer)');
  console.log('    Brand rules          → POST/PATCH/DELETE /brand/intelligence (Brain tab Constitution)');
  console.log('    Brand exemplars      → POST/PATCH/DELETE /brand/exemplars (Brand tab)');
  console.log('    Agent memory         → POST/PATCH/DELETE /agents/:name/memory (Brain tab Memory)');
  console.log('    Pipeline definition  → PUT /pipelines/:id              (Pipeline tab)');
  console.log('    Per-agent model pin  → PATCH /agent-models/:agent      (Settings/Brain top-right)');
  console.log('    Training proposals   → POST /trainer/proposals/:id/{approve,reject} (Trainer overlay)');
  console.log('    Inbox aggregator     → GET /inbox/all (8 sources unified — M91)');

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
