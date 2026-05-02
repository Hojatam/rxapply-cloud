// cowork-proxy/prompt-versions.js
// =====================================================================
// F7 · SKILL.md version history.
//
// Whenever PUT /prompts/:agent succeeds (the dashboard's prompt editor
// saves an edit), we ALSO append a row to prompt_versions. Reads:
//   - GET  /prompts/:agent/versions       -> list (newest first)
//   - GET  /prompts/:agent/versions/:n    -> body of one version
//   - POST /prompts/:agent/rollback {to:N} -> writes that body back to
//     SKILL.md, captures yet another version with reason='rollback'.
// =====================================================================

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');

// Same regex as server.js — blocks path traversal in case this is called
// from a context that doesn't validate upstream (M-2).
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

function _psqlExec(script) {
  const args = ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'];
  const r = spawnSync('docker', args, { input: script, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`psql (${r.status}): ${(r.stderr || '').slice(0, 500)}`);
  return (r.stdout || '').trim();
}
function _q(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function nextVersion(agent) {
  try {
    const out = _psqlExec(`SELECT COALESCE(MAX(version),0)+1 FROM prompt_versions WHERE agent = ${_q(agent)};`);
    return Math.max(1, parseInt(out, 10) || 1);
  } catch (_) { return 1; }
}

function record(agent, body, { editedBy = 'founder', reason = null, prevBody = null } = {}) {
  const v = nextVersion(agent);
  const diffChars = prevBody == null ? body.length : Math.abs(body.length - prevBody.length);
  const sql = `
    INSERT INTO prompt_versions (agent, version, body, edited_by, diff_chars, reason)
    VALUES (${_q(agent)}, ${v}, ${_q(body)}, ${_q(editedBy)}, ${diffChars}, ${_q(reason)})
    RETURNING version;
  `;
  try {
    const out = _psqlExec(sql);
    return { ok: true, version: parseInt(out, 10) || v };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200), version: v };
  }
}

function list(agent, { limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY version DESC), '[]'::json)
    FROM (
      SELECT version, edited_by, edited_at::text, diff_chars, reason,
             length(body) AS body_chars
      FROM prompt_versions WHERE agent = ${_q(agent)}
      ORDER BY version DESC LIMIT ${limit}
    ) s;
  `;
  try { return JSON.parse(_psqlExec(sql) || '[]'); } catch (_) { return []; }
}

function getBody(agent, version) {
  const sql = `SELECT body FROM prompt_versions WHERE agent = ${_q(agent)} AND version = ${parseInt(version, 10) || 0};`;
  try {
    const out = _psqlExec(sql);
    return out || null;
  } catch (_) { return null; }
}

// Persists `body` as the active SKILL.md and ALSO appends a version row.
// Returns { ok, version } or { ok:false, error }.
function saveAndVersion(agent, body, { editedBy = 'founder', reason = null } = {}) {
  if (!agent || typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
    return { ok: false, error: 'invalid agent name' };
  }
  if (!body || typeof body !== 'string') return { ok: false, error: 'body required' };
  if (!body.trim().startsWith('---')) return { ok: false, error: 'SKILL.md must start with --- frontmatter' };

  const skillDir = path.join(AGENTS_DIR, agent);
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

  // 1. Read previous body (for diff char computation).
  let prevBody = null;
  try { prevBody = fs.readFileSync(skillPath, 'utf-8'); } catch (_) {}

  // 2. Atomic write: tmp -> rename.
  const tmpPath = skillPath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, skillPath);

  // 3. Append version.
  return record(agent, body, { editedBy, reason, prevBody });
}

function rollback(agent, toVersion, { editedBy = 'founder' } = {}) {
  const body = getBody(agent, toVersion);
  if (body == null) return { ok: false, error: `version ${toVersion} not found` };
  return saveAndVersion(agent, body, { editedBy, reason: `rollback to v${toVersion}` });
}

module.exports = { record, list, getBody, saveAndVersion, rollback, nextVersion };
