// cowork-proxy/prompt-versions.js
// =====================================================================
// F7 · SKILL.md version history.  [cloud build]
// All public functions are now async (pg-backed). Callers must await.
//
// Cloud-deploy note: SKILL.md files live on the container's local FS.
// On Railway that's per-deploy ephemeral storage. Versions live in the
// DB so even after redeploy, history survives — but the *active*
// SKILL.md needs to be re-materialised on boot. The migration runner
// will write each agent's latest version back to disk on container start.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { query, queryValue, queryReturning, q } = require('./db');

const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

async function nextVersion(agent) {
  try {
    const out = await queryValue(`SELECT COALESCE(MAX(version),0)+1 FROM prompt_versions WHERE agent = ${q(agent)};`);
    return Math.max(1, parseInt(out, 10) || 1);
  } catch (_) { return 1; }
}

async function record(agent, body, { editedBy = 'founder', reason = null, prevBody = null } = {}) {
  const v = await nextVersion(agent);
  const diffChars = prevBody == null ? body.length : Math.abs(body.length - prevBody.length);
  try {
    const out = await queryReturning(`
      INSERT INTO prompt_versions (agent, version, body, edited_by, diff_chars, reason)
      VALUES (${q(agent)}, ${v}, ${q(body)}, ${q(editedBy)}, ${diffChars}, ${q(reason)})
      RETURNING version;`);
    return { ok: true, version: parseInt(out, 10) || v };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200), version: v };
  }
}

async function list(agent, { limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY version DESC), '[]'::json)
    FROM (
      SELECT version, edited_by, edited_at::text, diff_chars, reason,
             length(body) AS body_chars
      FROM prompt_versions WHERE agent = ${q(agent)}
      ORDER BY version DESC LIMIT ${limit}
    ) s;`;
  try { return JSON.parse((await queryValue(sql)) || '[]'); } catch (_) { return []; }
}

async function getBody(agent, version) {
  try {
    const out = await queryValue(`SELECT body FROM prompt_versions
                                    WHERE agent = ${q(agent)} AND version = ${parseInt(version, 10) || 0};`);
    return out || null;
  } catch (_) { return null; }
}

async function saveAndVersion(agent, body, { editedBy = 'founder', reason = null } = {}) {
  if (!agent || typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
    return { ok: false, error: 'invalid agent name' };
  }
  if (!body || typeof body !== 'string') return { ok: false, error: 'body required' };
  if (!body.trim().startsWith('---')) return { ok: false, error: 'SKILL.md must start with --- frontmatter' };

  const skillDir = path.join(AGENTS_DIR, agent);
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

  let prevBody = null;
  try { prevBody = fs.readFileSync(skillPath, 'utf-8'); } catch (_) {}

  const tmpPath = skillPath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, skillPath);

  return await record(agent, body, { editedBy, reason, prevBody });
}

async function rollback(agent, toVersion, { editedBy = 'founder' } = {}) {
  const body = await getBody(agent, toVersion);
  if (body == null) return { ok: false, error: `version ${toVersion} not found` };
  return await saveAndVersion(agent, body, { editedBy, reason: `rollback to v${toVersion}` });
}

module.exports = { record, list, getBody, saveAndVersion, rollback, nextVersion };
