// cowork-proxy/output-renderers.js
// =====================================================================
// K1 · Per-agent narrative formatters.
//
// Turns raw JSON output (or stdout/json mix from a Python helper) into
// a one-paragraph human-readable narrative. Defaults live in code;
// per-agent overrides live in dashboard_settings.output_renderers
// (jsonb), edited from Settings → Output renderers.
//
// Public API:
//   render(agent, action, output, meta)        → string
//   render(agent, action, output)              → same, meta optional
//
// Template placeholder syntax: {dot.path} from the output object,
// or {meta.field} from the meta arg. Missing values render as '?'.
//
// If the per-agent template throws or yields '', we fall through to
// the codebase default. If THAT throws or yields '', we fall through
// to a generic "<Agent> ran <action>" line.
// =====================================================================

const { spawnSync } = require('child_process');
const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';

function _psql(sql) {
  const r = spawnSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: Buffer.from(sql, 'utf-8') });
  if (r.status !== 0) {
    throw new Error(`psql (${r.status}): ${(r.stderr || Buffer.alloc(0)).toString('utf-8').slice(0, 300)}`);
  }
  return (r.stdout || Buffer.alloc(0)).toString('utf-8').trim();
}

// Cache the renderers map for 60s — edited rarely, read constantly.
let _renderersCache = null;
let _renderersStamp = 0;
const RENDERERS_TTL_MS = 60_000;

function _loadRenderers() {
  try {
    const raw = _psql(`SELECT output_renderers FROM dashboard_settings WHERE id = 1;`);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}
function _getRenderers() {
  const now = Date.now();
  if (!_renderersCache || (now - _renderersStamp) > RENDERERS_TTL_MS) {
    _renderersCache = _loadRenderers();
    _renderersStamp = now;
  }
  return _renderersCache;
}
function invalidate() {
  _renderersCache = null;
}

// Look up a deep dotted path in `obj`. Returns undefined if any step missing.
function _get(obj, path) {
  if (obj == null) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Replace {a.b.c} in template with str(_get(ctx, 'a.b.c')).
// Special placeholders accepted: {cost_usd_str} ($X.XXXX), counts derived
// at render time, etc.
function _substitute(template, ctx) {
  return String(template).replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, key) => {
    if (key === 'cost_usd_str') {
      const c = _get(ctx, 'cost_usd') ?? _get(ctx, 'shared_meta.cost_usd');
      return c == null ? '$?' : `$${Number(c).toFixed(4)}`;
    }
    if (key.endsWith('_count')) {
      // e.g. {key_facts_count} → length of ctx.key_facts
      const target = key.slice(0, -'_count'.length);
      const v = _get(ctx, target);
      return Array.isArray(v) ? String(v.length) : (v == null ? '?' : String(v));
    }
    if (key.endsWith('_chars')) {
      const target = key.slice(0, -'_chars'.length);
      const v = _get(ctx, target);
      return v == null ? '?' : String(String(v).length);
    }
    if (key.endsWith('_short')) {
      // e.g. {angle_short} → first 80 chars of ctx.angle
      const target = key.slice(0, -'_short'.length);
      const v = _get(ctx, target);
      if (v == null) return '?';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 80 ? s.slice(0, 77) + '…' : s;
    }
    const v = _get(ctx, key);
    if (v == null) return '?';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return v.join(', ');
    return JSON.stringify(v);
  });
}

// Codebase default fallbacks. Used when neither user override nor an
// explicit codebase entry exists. Keep tight: one sentence each.
//
// `{action_phrase}` resolves to "" when the action is the literal word "run"
// (so we don't get "X ran run.") and to " {action}" otherwise. This avoids
// awkward duplication for cron-style agents whose action *is* `run`.
const _BUILTIN_DEFAULTS = {
  '*': '{agent} ran{action_phrase}.',
};

function _enrichContextForTemplate(agent, action, output, meta) {
  // The template sees: top-level merge of (output, meta, {agent, action}).
  // It's also useful to expose row_count for arrays at the top level.
  const ctx = { ...(output || {}), ...(meta || {}), agent, action };
  // {action_phrase} renders as "" when action is the literal word "run"
  // (avoiding "X ran run.") and as " <action>" otherwise.
  ctx.action_phrase = (String(action || '').toLowerCase() === 'run')
    ? '' : ` ${action}`;
  // If output is itself an array, expose .row_count
  if (Array.isArray(output)) {
    ctx.row_count = output.length;
  }
  // Convenience for compose-ig (caption_chars used by the template).
  for (const lang of ['en', 'fa', 'ar']) {
    const cap = _get(output, `languages.${lang}.caption`);
    if (typeof cap === 'string') {
      _set(ctx, `languages.${lang}.caption_chars`, cap.length);
    }
  }
  return ctx;
}
function _set(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function render(agent, action, output, meta = {}) {
  if (!agent) return '';
  // Try user override first.
  const all = _getRenderers();
  let template = (all[agent] && all[agent][action]) || null;
  // Fall through to a generic agent template if specific action missing.
  if (!template) template = (all[agent] && all[agent]['*']) || null;
  // Last fallback: codebase default.
  if (!template) template = _BUILTIN_DEFAULTS['*'];

  const ctx = _enrichContextForTemplate(agent, action, output, meta);
  try {
    const result = _substitute(template, ctx);
    if (result && result.trim().length > 0) return result;
  } catch (_) { /* fall through */ }
  // Last resort — same de-duplication as the default template.
  const phrase = (String(action || '').toLowerCase() === 'run')
    ? '' : ` ${action}`;
  return `${agent} ran${phrase}.`;
}

// Save an updated renderers map. Only edits the {agent} subtree.
function setRendererForAgent(agent, perActionMap) {
  if (!agent || !perActionMap || typeof perActionMap !== 'object') {
    return { ok: false, error: 'agent + perActionMap required' };
  }
  const cur = _getRenderers();
  cur[agent] = { ...(cur[agent] || {}), ...perActionMap };
  // strip empty strings ⇒ deleting a template
  for (const [k, v] of Object.entries(cur[agent])) {
    if (typeof v !== 'string' || v.trim() === '') delete cur[agent][k];
  }
  if (Object.keys(cur[agent]).length === 0) delete cur[agent];
  try {
    const sql = `UPDATE dashboard_settings
                    SET output_renderers = '${JSON.stringify(cur).replace(/'/g, "''")}'::jsonb,
                        updated_at = NOW()
                  WHERE id = 1;`;
    _psql(sql);
    invalidate();
    return { ok: true, agent };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function listAll() {
  return _getRenderers();
}

module.exports = { render, setRendererForAgent, listAll, invalidate };
