// cowork-proxy/log-writer.js
// =====================================================================
// F2 · Logs L2 — full I/O capture for every helper invocation.
//
// This module is the only writer for agent_runs.{input_payload,
// output_payload, error_payload, log_file_path, cost_usd_actual} and
// for the agent_actions table. It also writes raw {stdout,stderr,bundle.json}
// files to logs/YYYY-MM-DD/.
//
// Dependencies: only Node built-ins + child_process to docker exec psql.
// We deliberately avoid `pg` to keep the proxy zero-pip-deps.
//
// Public API:
//   recordRunStart({ agent, command, args, stdin })
//     -> { runId, logDir, bundlePath, stdoutPath, stderrPath }
//   recordRunEnd({ runId, status, output, stderr, exitCode, durationMs, error })
//   recordAction({ runId, stepIndex, kind, data, durationMs, status })
//   listRuns({ agent, status, limit, offset })
//   loadRunBundle(runId)
//   cleanupOldLogs() — gzip after 7d, delete after 30d
// =====================================================================

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const LOGS_ROOT     = path.resolve(__dirname, '..', 'logs');
const RETENTION_DAYS = 30;
const GZIP_AFTER_DAYS = 7;

// M19 cloud hardening:
//   The proxy has always written full run-log bundles to disk under
//   ../logs/YYYY-MM-DD/<agent>-<runid>.json plus raw .stdout/.stderr.
//   On Railway that path is wiped on every redeploy — which means
//   /logs/:runid/download silently breaks for every run from before
//   the latest deploy.
//
//   Postgres (agent_runs.{input,output,error}_payload) already holds
//   the structured I/O. The disk bundles are mostly diagnostic.
//
//   We now gate disk writes behind RUN_LOGS_TO_DISK=true. Default OFF
//   in cloud — agent_runs is the source of truth. Local dev can turn
//   it on if they want grep-friendly text files alongside the DB rows.
const RUN_LOGS_TO_DISK = process.env.RUN_LOGS_TO_DISK === 'true';

// pg-backed DB client (cloud build).
const { query, queryValue, q: _q, qJson: _qjson } = require('./db');

// _psqlExecScript replaced by `query()`. Helpers below now async.
async function _psqlExecScript(sql) {
  return await queryValue(sql);
}

// ── path helpers ──────────────────────────────────────────────────────

function _todayDir() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _filesFor(runId, agent) {
  const dateDir = _todayDir();
  const base = `${agent}-${runId.slice(0, 8)}`;
  if (!RUN_LOGS_TO_DISK) {
    // Disk writes disabled (cloud default). Return paths that look
    // sane for callers that build URLs from `relativeBundlePath`, but
    // never touch the filesystem.
    return {
      logDir: null, base,
      bundlePath: null, stdoutPath: null, stderrPath: null,
      relativeBundlePath: null,
    };
  }
  const logDir = path.join(LOGS_ROOT, dateDir);
  _ensureDir(logDir);
  return {
    logDir,
    base,
    bundlePath: path.join(logDir, base + '.json'),
    stdoutPath: path.join(logDir, base + '.stdout'),
    stderrPath: path.join(logDir, base + '.stderr'),
    relativeBundlePath: path.join('logs', dateDir, base + '.json').replace(/\\/g, '/'),
  };
}

// ── Sanitization (best-effort secret masking) ─────────────────────────

const SECRET_KEY_RE = /(?:api[_-]?key|secret|password|token|authorization)/i;
function _sanitize(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    // Mask things that look like API keys: long random-ish strings.
    if (/^(sk-|sb_secret_|key_|Bearer\s+)/.test(value) || /^[A-Za-z0-9_-]{40,}$/.test(value)) {
      return value.slice(0, 8) + '…' + value.slice(-4);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(_sanitize);
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) {
      o[k] = SECRET_KEY_RE.test(k) ? '<redacted>' : _sanitize(value[k]);
    }
    return o;
  }
  return value;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Record the start of a helper invocation.
 * Inserts a row into agent_runs with status='running' and returns the runId
 * plus the file paths the caller should write stdout/stderr to.
 */
async function recordRunStart({ agent, command, args = [], stdin = null }) {
  const runId = crypto.randomUUID();
  const paths = _filesFor(runId, agent);

  const inputPayload = _sanitize({
    command,
    args,
    stdin: stdin == null ? null
         : (typeof stdin === 'string' ? (stdin.length > 4000 ? stdin.slice(0, 4000) + '… [truncated]' : stdin)
                                      : stdin),
    started_at: new Date().toISOString(),
  });

  const sql = `
    INSERT INTO agent_runs (id, agent, started_at, status, input_payload, log_file_path)
    VALUES (${_q(runId)}, ${_q(agent)}, NOW(), 'running', ${_qjson(inputPayload)}, ${_q(paths.relativeBundlePath)})
    ON CONFLICT (id) DO NOTHING
    RETURNING id::text;
  `;
  try {
    await query(sql);
  } catch (e) {
    // Schema may be missing the new columns. Fall back to bare-bones insert.
    try {
      await query(`INSERT INTO agent_runs (id, agent, started_at, status) VALUES (${_q(runId)}, ${_q(agent)}, NOW(), 'running');`);
    } catch (_) {
      console.warn('[log-writer] DB unavailable, logging to disk only:', e.message.slice(0, 200));
    }
  }
  return { runId, ...paths };
}

/**
 * Finalize a run: write the bundle JSON to disk, update agent_runs with payloads + status.
 */
async function recordRunEnd({ runId, agent, status = 'success', output = '', stderr = '', exitCode = 0,
                              durationMs = 0, error = null, parsedOutput = null, costUsd = 0,
                              paths = null, inputPayload = null }) {
  if (!paths) paths = _filesFor(runId, agent || 'unknown');

  // 1. Write raw stdout/stderr — only when RUN_LOGS_TO_DISK=true (off
  //    in cloud; agent_runs is the source of truth there).
  if (RUN_LOGS_TO_DISK) {
    try {
      if (output && paths.stdoutPath) fs.writeFileSync(paths.stdoutPath, output);
      if (stderr && paths.stderrPath) fs.writeFileSync(paths.stderrPath, stderr);
    } catch (e) {
      console.warn('[log-writer] failed to write log files:', e.message);
    }
  }

  // 2. Detect parsedOutput if it looks like JSON.
  let parsed = parsedOutput;
  if (parsed == null && typeof output === 'string' && output.trim()) {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); } catch (_) { /* leave null */ }
    }
  }

  const outputPayload = parsed != null
    ? { kind: 'json', value: _sanitize(parsed) }
    : { kind: 'text', value: output.slice(0, 50000) }; // hard cap inline DB copy

  const errorPayload = status === 'fail' ? {
    code: exitCode,
    message: typeof error === 'string' ? error : (error && error.message) || null,
    stderr_excerpt: (stderr || '').slice(0, 4000),
  } : null;

  // 3. Write the bundle file — only when disk logging is on.
  if (RUN_LOGS_TO_DISK && paths.bundlePath) {
    const bundle = {
      run_id: runId,
      agent,
      status,
      duration_ms: durationMs,
      exit_code: exitCode,
      cost_usd_actual: costUsd,
      started_at: inputPayload?.started_at,
      finished_at: new Date().toISOString(),
      input_payload: inputPayload,
      output_payload: outputPayload,
      error_payload: errorPayload,
      files: {
        stdout: paths.stdoutPath && fs.existsSync(paths.stdoutPath) ? path.basename(paths.stdoutPath) : null,
        stderr: paths.stderrPath && fs.existsSync(paths.stderrPath) ? path.basename(paths.stderrPath) : null,
      },
    };
    try {
      fs.writeFileSync(paths.bundlePath, JSON.stringify(bundle, null, 2));
    } catch (e) {
      console.warn('[log-writer] failed to write bundle:', e.message);
    }
  }

  // 4. Update agent_runs.
  const sql = `
    UPDATE agent_runs SET
      status         = ${_q(status)},
      finished_at    = NOW(),
      duration_ms    = ${Number.isFinite(durationMs) ? durationMs : 'NULL'},
      output_payload = ${_qjson(outputPayload)},
      error_payload  = ${_qjson(errorPayload)},
      cost_usd_actual = ${Number.isFinite(costUsd) ? costUsd : 0}
    WHERE id = ${_q(runId)};
  `;
  try { await query(sql); }
  catch (e) { console.warn('[log-writer] DB update failed (non-fatal):', e.message.slice(0, 200)); }

  return { runId, bundlePath: paths.bundlePath };
}

/**
 * Record one discrete action within a run.
 * (Used when helpers explicitly call out steps. Most existing helpers won't yet.)
 */
async function recordAction({ runId, stepIndex, kind, data = {}, durationMs = 0, status = 'success' }) {
  const sql = `
    INSERT INTO agent_actions (run_id, step_index, action_kind, action_data, duration_ms, status)
    VALUES (${_q(runId)}, ${stepIndex|0}, ${_q(kind)}, ${_qjson(data)}, ${durationMs|0}, ${_q(status)});
  `;
  try { await query(sql); }
  catch (e) { console.warn('[log-writer] action insert failed (non-fatal):', e.message.slice(0, 200)); }
}

/**
 * List runs for the dashboard's Logs panel.
 */
async function listRuns({ agent = null, status = null, limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  offset = Math.max(parseInt(offset) || 0, 0);
  const where = [];
  if (agent)  where.push(`agent = ${_q(agent)}`);
  if (status) where.push(`status = ${_q(status)}`);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY started_at DESC), '[]'::json)
    FROM (
      SELECT id::text AS id, agent, started_at::text AS started_at,
             finished_at::text AS finished_at, status, duration_ms,
             cost_usd_actual, log_file_path, action_count, failed_actions,
             has_input, has_output
      FROM v_run_log_summary
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    ) s;
  `;
  try {
    const out = await queryValue(sql);
    return out ? JSON.parse(out) : [];
  } catch (e) {
    console.warn('[log-writer] listRuns failed:', e.message.slice(0, 200));
    return [];
  }
}

/**
 * Load the full bundle for one run: agent_runs row + actions + raw files.
 */
async function loadRunBundle(runId) {
  // 1. Run row.
  const runSql = `
    SELECT row_to_json(r) FROM (
      SELECT id::text AS id, agent, started_at::text, finished_at::text,
             status, duration_ms, cost_usd_actual, log_file_path,
             input_payload, output_payload, error_payload
      FROM agent_runs WHERE id = ${_q(runId)}
    ) r;
  `;
  let run = null;
  try {
    const out = await queryValue(runSql);
    if (out) run = JSON.parse(out);
  } catch (e) {
    return { error: 'run not found or DB unreachable: ' + e.message.slice(0, 200) };
  }
  if (!run) return { error: 'run not found' };

  // 2. Actions.
  const actSql = `
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY step_index), '[]'::json)
    FROM (
      SELECT step_index, action_kind, action_data, duration_ms, status, created_at::text
      FROM agent_actions WHERE run_id = ${_q(runId)} ORDER BY step_index
    ) a;
  `;
  let actions = [];
  try {
    const out = await queryValue(actSql);
    actions = out ? JSON.parse(out) : [];
  } catch (_) { /* tolerate */ }

  // 3. Raw stdout/stderr from disk if available. Skipped entirely
  //    when RUN_LOGS_TO_DISK=false — the structured input/output
  //    payloads in agent_runs already cover what the dashboard renders.
  let stdout = null, stderr = null;
  if (RUN_LOGS_TO_DISK && run.log_file_path) {
    const bundleAbs = path.resolve(__dirname, '..', run.log_file_path);
    const baseAbs = bundleAbs.replace(/\.json$/, '');
    try { stdout = fs.readFileSync(baseAbs + '.stdout', 'utf-8'); } catch (_) {}
    try { stderr = fs.readFileSync(baseAbs + '.stderr', 'utf-8'); } catch (_) {}
    if (stdout == null) {
      try { stdout = zlib.gunzipSync(fs.readFileSync(baseAbs + '.stdout.gz')).toString('utf-8'); } catch (_) {}
    }
    if (stderr == null) {
      try { stderr = zlib.gunzipSync(fs.readFileSync(baseAbs + '.stderr.gz')).toString('utf-8'); } catch (_) {}
    }
  }

  return { run, actions, stdout, stderr };
}

/**
 * Retention: gzip files older than 7 days, delete files older than 30.
 * Idempotent. Safe to call on every proxy startup. No-op when disk
 * logging is disabled (cloud default).
 */
function cleanupOldLogs() {
  if (!RUN_LOGS_TO_DISK) return { gzipped: 0, deleted: 0, skipped: 'disk_logging_disabled' };
  if (!fs.existsSync(LOGS_ROOT)) return { gzipped: 0, deleted: 0 };
  let gzipped = 0, deleted = 0;
  const now = Date.now();
  const dirs = fs.readdirSync(LOGS_ROOT);
  for (const dirName of dirs) {
    const dirPath = path.join(LOGS_ROOT, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    // Parse YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dirName);
    if (!m) continue;
    const dirDate = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime();
    const ageDays = (now - dirDate) / 86400000;
    if (ageDays > RETENTION_DAYS) {
      // Delete entire day folder.
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        deleted++;
      } catch (e) { console.warn('[log-writer] delete failed:', dirPath, e.message); }
    } else if (ageDays > GZIP_AFTER_DAYS) {
      // Gzip stdout/stderr files in place (skip already-gzipped, skip .json bundles).
      for (const fname of fs.readdirSync(dirPath)) {
        if (fname.endsWith('.gz') || fname.endsWith('.json')) continue;
        const fp = path.join(dirPath, fname);
        if (!fs.statSync(fp).isFile()) continue;
        try {
          const data = fs.readFileSync(fp);
          fs.writeFileSync(fp + '.gz', zlib.gzipSync(data));
          fs.unlinkSync(fp);
          gzipped++;
        } catch (e) { console.warn('[log-writer] gzip failed:', fp, e.message); }
      }
    }
  }
  return { gzipped, deleted };
}

// Convenience helper for one-shot Anthropic API calls (not helper-process
// spawns). Writes a single agent_runs row with cost_usd_actual populated so
// the topbar / Overview cost widget reflects real spend. Used by the
// daneshyar-router, compose-stages, and afshin-router routes.
async function logApiCall({ agent, action, costUsd = 0, model = null, inputTokens = 0,
                            outputTokens = 0, durationMs = 0, status = 'success',
                            inputPayload = null, output = '', error = null }) {
  try {
    const start = await recordRunStart({
      agent, command: action,
      args: [], stdin: null,
      via: 'api',
    });
    if (!start || !start.runId) return null;
    await recordRunEnd({
      runId: start.runId,
      agent,
      status,
      output: typeof output === 'string' ? output : JSON.stringify(output || ''),
      stderr: '',
      exitCode: status === 'success' ? 0 : 1,
      durationMs,
      error,
      costUsd,
      inputPayload: inputPayload || { model, input_tokens: inputTokens, output_tokens: outputTokens },
      parsedOutput: null,
    });
    return start.runId;
  } catch (e) {
    console.warn('[log-writer] logApiCall failed:', e.message);
    return null;
  }
}

module.exports = {
  recordRunStart,
  recordRunEnd,
  recordAction,
  logApiCall,
  listRuns,
  loadRunBundle,
  cleanupOldLogs,
  LOGS_ROOT,
};
