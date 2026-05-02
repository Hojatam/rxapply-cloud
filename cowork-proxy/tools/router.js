// cowork-proxy/tools/router.js
// =====================================================================
// Express sub-router for the Tools framework. Mounted at /tools in
// server.js (after auth.middleware where appropriate).
//
//   GET    /tools                       → list (catalog + connection state)
//   GET    /tools/:slug                 → one tool with full state + perms
//   POST   /tools/:slug/connect         → save secrets (encrypted)
//   POST   /tools/:slug/test            → ping the adapter, no logging
//   POST   /tools/:slug/disconnect      → remove credentials row
//   POST   /tools/:slug/exec            → trigger a call (server-side caller)
//   GET    /tools/:slug/calls           → recent tool_calls rows
//   GET    /tools/agents/:agent         → all (tool, mode) for one agent
//   POST   /tools/:slug/perms/:agent    → set per-agent mode + policy
//   DELETE /tools/:slug/perms/:agent    → clear (= off)
// =====================================================================

const express = require('express');
const { psql, q, qJson } = require('./db');
const { encryptSqlExpr, decryptSqlExpr } = require('./crypto');
const registry = require('./registry');
const runtime = require('./runtime');

const router = express.Router();

// ── Pending-count (drives the dashboard's tool-approval banner) ────
router.get('/pending-count', async (_req, res) => {
  try {
    const out = await psql(`SELECT COUNT(*)::int FROM tool_calls
                              WHERE status IN ('pending','policy_ask');`);
    res.json({ ok: true, count: parseInt(out, 10) || 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Catalog list ────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  try {
    const out = await psql(`
      SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.kind, r.name), '[]'::json) FROM (
        SELECT t.slug, t.name, t.vendor, t.kind, t.conn_method, t.icon,
               t.cost_model, t.description, t.default_policy, t.ops, t.status,
               (c.tool_slug IS NOT NULL)            AS connected,
               c.monthly_cap_usd,
               c.monthly_spent_usd,
               c.last_status,
               c.last_used_at::text                  AS last_used_at,
               (SELECT COUNT(*) FROM tool_calls tc
                  WHERE tc.tool_slug = t.slug
                    AND tc.started_at >= now() - interval '30 days') AS calls_30d
        FROM tools t
        LEFT JOIN tool_credentials c ON c.tool_slug = t.slug
        WHERE t.status = 'available'
      ) r;
    `);
    res.json({ ok: true, tools: out ? JSON.parse(out) : [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── One tool, full detail ──────────────────────────────────────────
router.get('/:slug', async (req, res) => {
  const slug = req.params.slug;
  const spec = registry.get(slug);
  if (!spec) return res.status(404).json({ ok: false, error: 'unknown_tool' });
  try {
    const out = await psql(`
      SELECT row_to_json(r) FROM (
        SELECT t.slug, t.name, t.vendor, t.kind, t.conn_method, t.icon,
               t.cost_model, t.description, t.default_policy, t.ops, t.status,
               (c.tool_slug IS NOT NULL)             AS connected,
               c.monthly_cap_usd,
               c.monthly_spent_usd,
               c.last_status, c.last_status_msg,
               c.last_used_at::text                   AS last_used_at,
               c.connected_at::text                   AS connected_at,
               (SELECT COALESCE(json_agg(row_to_json(p)), '[]'::json)
                  FROM (SELECT agent_name, mode, policy_text, per_call_cap_usd
                          FROM agent_tool_permissions
                         WHERE tool_slug = t.slug
                         ORDER BY agent_name) p)      AS permissions
        FROM tools t
        LEFT JOIN tool_credentials c ON c.tool_slug = t.slug
        WHERE t.slug = ${q(slug)}
      ) r;
    `);
    if (!out) return res.status(404).json({ ok: false, error: 'unknown_tool' });
    const row = JSON.parse(out);
    // Echo the secret_fields spec from the registry (without secrets)
    row.secret_fields = spec.secret_fields || [];
    res.json({ ok: true, tool: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Connect (save encrypted secrets) ───────────────────────────────
router.post('/:slug/connect', async (req, res) => {
  const slug = req.params.slug;
  const spec = registry.get(slug);
  if (!spec) return res.status(404).json({ ok: false, error: 'unknown_tool' });
  const secrets = req.body && req.body.secrets;
  const monthlyCap = Number(req.body && req.body.monthly_cap_usd);
  if (!secrets || typeof secrets !== 'object') {
    return res.status(400).json({ ok: false, error: 'secrets_required' });
  }
  try {
    const cap = Number.isFinite(monthlyCap) && monthlyCap > 0 ? monthlyCap : 5.00;
    await psql(`
      INSERT INTO tool_credentials (tool_slug, secrets_enc, monthly_cap_usd, connected_by, connected_at, last_status)
      VALUES (${q(slug)}, ${encryptSqlExpr(JSON.stringify(secrets))}, ${q(cap)}, 'founder', now(), 'ok')
      ON CONFLICT (tool_slug) DO UPDATE SET
        secrets_enc = EXCLUDED.secrets_enc,
        monthly_cap_usd = EXCLUDED.monthly_cap_usd,
        last_status = 'ok',
        last_status_msg = NULL;
    `);
    // For MCP tools, discover ops immediately so the matrix shows them.
    if (spec.conn_method === 'mcp_http' || spec.conn_method === 'mcp_stdio') {
      try {
        const mod = spec.conn_method === 'mcp_http'
          ? require('./adapters/mcp-http')
          : require('./adapters/mcp-stdio');
        const ops = await mod.discoverOps(slug);
        return res.json({ ok: true, discovered_ops: ops.length });
      } catch (e) {
        await psql(`UPDATE tool_credentials SET last_status = 'auth_error',
                      last_status_msg = ${q('discovery: ' + String(e.message).slice(0, 200))}
                    WHERE tool_slug = ${q(slug)};`);
        return res.json({ ok: true, discovered_ops: 0, warning: e.message });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Disconnect ─────────────────────────────────────────────────────
router.post('/:slug/disconnect', async (req, res) => {
  try {
    await psql(`DELETE FROM tool_credentials WHERE tool_slug = ${q(req.params.slug)};`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Test connection ────────────────────────────────────────────────
// Calls the adapter's "test" op if defined, else a known cheap op.
router.post('/:slug/test', async (req, res) => {
  const slug = req.params.slug;
  const spec = registry.get(slug);
  if (!spec) return res.status(404).json({ ok: false, error: 'unknown_tool' });
  // For REST adapters, dispatch directly without going through perms.
  // Echo just runs ping; others should expose a 'test' op (we'll add).
  const op = (spec.ops || []).some(o => o.name === 'test') ? 'test'
           : slug === 'echo' ? 'ping'
           : (spec.ops && spec.ops[0] && spec.ops[0].name) || 'ping';
  try {
    const restAdapter = require('./adapters/rest');
    if (spec.conn_method === 'rest') {
      const r = await restAdapter.execute({ tool: spec, op, args: { _test: true }, agent: '_test' });
      await psql(`UPDATE tool_credentials SET last_status = 'ok', last_status_msg = NULL WHERE tool_slug = ${q(slug)};`);
      return res.json({ ok: true, output: r.output });
    }
    if (spec.conn_method === 'mcp_http' || spec.conn_method === 'mcp_stdio') {
      const mod = spec.conn_method === 'mcp_http'
        ? require('./adapters/mcp-http')
        : require('./adapters/mcp-stdio');
      const r = await mod.execute({ tool: spec, op: 'test', args: {} });
      await psql(`UPDATE tool_credentials SET last_status = 'ok', last_status_msg = NULL WHERE tool_slug = ${q(slug)};`);
      return res.json({ ok: true, output: r.output });
    }
    return res.json({ ok: true, note: 'unknown conn_method' });
  } catch (e) {
    await psql(`UPDATE tool_credentials SET last_status = 'error', last_status_msg = ${q(String(e.message).slice(0, 300))}
                  WHERE tool_slug = ${q(slug)};`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Server-side execute (for callers that aren't agents themselves) ─
router.post('/:slug/exec', async (req, res) => {
  const slug = req.params.slug;
  const { op, args, agent, taskContext, projectedCostUsd } = req.body || {};
  if (!op || !agent) return res.status(400).json({ ok: false, error: 'op_and_agent_required' });
  try {
    const r = await runtime.execute({
      agent, tool: slug, op, args: args || {}, taskContext, projectedCostUsd: Number(projectedCostUsd) || 0,
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Call log ───────────────────────────────────────────────────────
router.get('/:slug/calls', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  try {
    const out = await psql(`
      SELECT COALESCE(json_agg(row_to_json(c) ORDER BY c.started_at DESC), '[]'::json) FROM (
        SELECT id, agent, op, args_redacted, output_summary, cost_usd, status,
               decision, error_msg, started_at::text, ended_at::text
        FROM tool_calls WHERE tool_slug = ${q(req.params.slug)}
        ORDER BY started_at DESC LIMIT ${limit}
      ) c;
    `);
    res.json({ ok: true, calls: out ? JSON.parse(out) : [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Per-agent permission CRUD ──────────────────────────────────────
router.post('/:slug/perms/:agent', async (req, res) => {
  const slug = req.params.slug;
  const agent = req.params.agent;
  const { mode, policy_text, per_call_cap_usd } = req.body || {};
  if (!['off', 'ask', 'auto', 'policy'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  }
  try {
    await psql(`
      INSERT INTO agent_tool_permissions (agent_name, tool_slug, mode, policy_text, per_call_cap_usd, updated_at)
      VALUES (${q(agent)}, ${q(slug)}, ${q(mode)}, ${q(policy_text || null)},
              ${q(Number(per_call_cap_usd) || null)}, now())
      ON CONFLICT (agent_name, tool_slug) DO UPDATE SET
        mode = EXCLUDED.mode,
        policy_text = EXCLUDED.policy_text,
        per_call_cap_usd = EXCLUDED.per_call_cap_usd,
        updated_at = now();
    `);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/:slug/perms/:agent', async (req, res) => {
  try {
    await psql(`DELETE FROM agent_tool_permissions
                  WHERE tool_slug = ${q(req.params.slug)} AND agent_name = ${q(req.params.agent)};`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/agents/:agent', async (req, res) => {
  try {
    const out = await psql(`
      SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.tool_slug), '[]'::json) FROM (
        SELECT t.slug AS tool_slug, t.name AS tool_name, t.icon, t.kind,
               COALESCE(p.mode, 'off') AS mode, p.policy_text, p.per_call_cap_usd
        FROM tools t
        LEFT JOIN agent_tool_permissions p
               ON p.tool_slug = t.slug AND p.agent_name = ${q(req.params.agent)}
        WHERE t.status = 'available'
      ) r;
    `);
    res.json({ ok: true, agent: req.params.agent, tools: out ? JSON.parse(out) : [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
