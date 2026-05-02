// cowork-proxy/tools/adapters/mcp-stdio.js
// =====================================================================
// Adapter for community MCP servers shipped as npm packages. We spawn
// `npx <package>` (or `node <package>`) as a subprocess on first use,
// keep the pipe open, and speak JSON-RPC over stdio. The process is
// lazy-started + auto-restarted on crash.
//
// Each connected stdio MCP gets one long-running child process. We
// fingerprint by tool slug — multiple agents share the same child for
// the same tool. Args go in via stdin, replies out via stdout (one
// line per JSON-RPC message). Stderr is captured for diagnostics.
//
// Note: we do NOT install packages here — the founder pastes the npm
// package name in the connect form and we assume it's installable via
// npx. If not present, npx will fetch it transparently on first run.
// =====================================================================

const { spawn } = require('child_process');
const { psql, q, qJson } = require('../db');
const { decryptSqlExpr } = require('../crypto');

const _children = {};      // slug → { proc, stdoutBuf, pending: Map<id, {resolve, reject}>, ready }
let _rpcId = 1;

async function _loadSecrets(slug) {
  const out = await psql(`
    SELECT ${decryptSqlExpr('secrets_enc')}
    FROM tool_credentials WHERE tool_slug = ${q(slug)};
  `);
  if (!out) return null;
  try { return JSON.parse(out); } catch (_) { return null; }
}

async function _spawn(slug) {
  const secrets = await _loadSecrets(slug);
  if (!secrets || !secrets.package) {
    throw new Error(`mcp-stdio: package name missing for '${slug}' — connect the tool first.`);
  }
  // Pass the per-tool secrets as env vars. Convention: UPPERCASE_KEY.
  // The package decides which it cares about.
  const env = { ...process.env };
  for (const [k, v] of Object.entries(secrets)) {
    if (k === 'package') continue;
    env[k.toUpperCase()] = v;
  }
  // Use npx so the package can be auto-installed if absent. -y skips prompts.
  const proc = spawn('npx', ['-y', secrets.package], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    shell: process.platform === 'win32',
  });
  const state = {
    proc,
    pending: new Map(),
    stdoutBuf: '',
    stderrBuf: '',
    ready: false,
    initPromise: null,
  };
  proc.stdout.on('data', d => {
    state.stdoutBuf += d.toString('utf-8');
    let nl;
    while ((nl = state.stdoutBuf.indexOf('\n')) >= 0) {
      const line = state.stdoutBuf.slice(0, nl).trim();
      state.stdoutBuf = state.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && state.pending.has(msg.id)) {
          const { resolve, reject } = state.pending.get(msg.id);
          state.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (_) { /* ignore non-JSON lines */ }
    }
  });
  proc.stderr.on('data', d => {
    state.stderrBuf += d.toString('utf-8');
    if (state.stderrBuf.length > 5000) state.stderrBuf = state.stderrBuf.slice(-5000);
  });
  proc.on('exit', (code) => {
    delete _children[slug];
    for (const { reject } of state.pending.values()) {
      reject(new Error(`mcp-stdio child for '${slug}' exited with code ${code}; stderr: ${state.stderrBuf.slice(-300)}`));
    }
  });
  _children[slug] = state;
  return state;
}

function _send(state, method, params) {
  const id = _rpcId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error(`mcp-stdio timeout (30s) on ${method}`));
      }
    }, 30_000);
  });
}

async function _ensure(slug) {
  let state = _children[slug];
  if (!state || state.proc.killed) state = await _spawn(slug);
  if (!state.ready) {
    if (!state.initPromise) {
      state.initPromise = _send(state, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'rxapply-cowork-proxy', version: '1.0' },
      }).then(() => { state.ready = true; });
    }
    await state.initPromise;
  }
  return state;
}

async function discoverOps(slug) {
  const state = await _ensure(slug);
  const r = await _send(state, 'tools/list', {});
  const ops = (r.tools || []).map(t => ({
    name: t.name,
    description: t.description || '',
    write: /post|create|publish|send|update|delete|reply|schedule/i.test(t.name),
    schema: t.inputSchema || null,
  }));
  await psql(`UPDATE tools SET ops = ${qJson(ops)}, updated_at = now() WHERE slug = ${q(slug)};`);
  return ops;
}

async function execute({ tool, op, args }) {
  if (op === 'test' || op === '_test') {
    const state = await _ensure(tool.slug);
    await _send(state, 'tools/list', {});
    return { output: { ok: true, note: 'tools/list reachable via stdio' }, costUsd: 0 };
  }
  const state = await _ensure(tool.slug);
  const r = await _send(state, 'tools/call', { name: op, arguments: args || {} });
  return { output: r.content || r, costUsd: 0 };
}

function shutdown() {
  for (const [slug, state] of Object.entries(_children)) {
    try { state.proc.kill(); } catch (_) {}
    delete _children[slug];
  }
}

module.exports = { execute, discoverOps, shutdown };
