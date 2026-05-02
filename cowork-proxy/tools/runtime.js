// cowork-proxy/tools/runtime.js
// =====================================================================
// The single entry point every agent uses to call a tool.
//
//   runtime.execute({agent, tool, op, args, taskContext, requestId})
//      → { ok, output, cost, decision, callId }
//      → or { ok: false, queued: true, callId }   when ask/policy_ask
//      → or { ok: false, error: 'permission_denied' | 'cap_exceeded' | … }
//
// Pipeline:
//   1.  Validate tool + op exist.
//   2.  Load (agent, tool) permission row.
//   3.  Permission gate:
//        off    → reject
//        ask    → queue (returns queued:true), Inbox card created
//        auto   → execute now
//        policy → call policy.evaluate() → recurse with auto|ask
//   4.  Cap check (per-tool monthly_cap_usd, plus global $/mo cap from cost.js).
//   5.  Execute via the matching adapter (./adapters/<conn_method>/<slug>.js).
//   6.  Log to tool_calls, increment monthly_spent_usd, invalidate cost cache.
// =====================================================================

const { psql, q, qJson } = require('./db');
const registry = require('./registry');
const cost = require('../cost');
const permissions = require('../permissions');     // re-use the inbox/queue subsystem

// Lazy-load adapters so missing optional ones (e.g. mcp clients) don't break boot.
const adapters = {
  rest:      require('./adapters/rest'),
  mcp_http:  require('./adapters/mcp-http'),
  mcp_stdio: require('./adapters/mcp-stdio'),
};

// ── Per-(agent,tool) permission lookup ─────────────────────────────
async function getPermission(agent, toolSlug) {
  const out = await psql(`
    SELECT row_to_json(p) FROM (
      SELECT mode, policy_text, per_call_cap_usd
      FROM agent_tool_permissions
      WHERE agent_name = ${q(agent)} AND tool_slug = ${q(toolSlug)}
    ) p;
  `);
  if (!out) return { mode: 'off' };           // unset = off (deny by default)
  try { return JSON.parse(out); } catch (_) { return { mode: 'off' }; }
}

// ── Cap check ──────────────────────────────────────────────────────
async function checkCaps(toolSlug, projectedCostUsd = 0) {
  // Per-tool cap
  const out = await psql(`
    SELECT row_to_json(c) FROM (
      SELECT monthly_cap_usd, monthly_spent_usd FROM tool_credentials
      WHERE tool_slug = ${q(toolSlug)}
    ) c;
  `);
  let toolCap = null;
  if (out) {
    try {
      const c = JSON.parse(out);
      toolCap = { cap: Number(c.monthly_cap_usd) || 0, spent: Number(c.monthly_spent_usd) || 0 };
    } catch (_) {}
  }
  if (toolCap && toolCap.cap > 0 && (toolCap.spent + projectedCostUsd) > toolCap.cap) {
    return { ok: false, reason: 'tool_cap_exceeded', detail: toolCap };
  }
  // Global cap (existing $/mo guard from cost.js)
  if (!(await cost.canSpend(projectedCostUsd))) {
    return { ok: false, reason: 'global_cap_exceeded' };
  }
  return { ok: true };
}

// ── Args redaction ─────────────────────────────────────────────────
// Strip obvious PII before logging. Adapters can override.
const REDACT_KEYS = /^(access_token|api_key|bearer|password|cookie|authorization)$/i;
function redactArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = Array.isArray(args) ? args.slice() : { ...args };
  for (const k of Object.keys(out)) {
    if (REDACT_KEYS.test(k)) out[k] = '***';
    else if (out[k] && typeof out[k] === 'object') out[k] = redactArgs(out[k]);
  }
  return out;
}

// ── Call log helpers ───────────────────────────────────────────────
async function logStart({ agent, toolSlug, op, args, taskContext, requestId, decision, status }) {
  // pg returns just the value for RETURNING — no -tA tag to strip
  // (the legacy split-on-newline workaround is gone in the cloud build).
  const id = await psql(`
    INSERT INTO tool_calls (agent, tool_slug, op, args_redacted, status, decision, task_context, request_id)
    VALUES (${q(agent)}, ${q(toolSlug)}, ${q(op)}, ${qJson(redactArgs(args))},
            ${q(status)}, ${q(decision)}, ${q(taskContext || null)}, ${q(requestId || null)})
    RETURNING id::text;
  `);
  return id;
}
async function logEnd(id, { status, output, costUsd, errorMsg }) {
  const summary = output == null ? null
    : typeof output === 'string' ? output.slice(0, 800)
    : JSON.stringify(output).slice(0, 800);
  await psql(`
    UPDATE tool_calls SET
      status = ${q(status)},
      output_summary = ${q(summary)},
      cost_usd = ${q(Number(costUsd) || 0)},
      error_msg = ${q(errorMsg || null)},
      ended_at = now()
    WHERE id = ${q(id)};
  `);
}

// Bump the monthly_spent_usd column. The view tool_cost_30d is the
// source of truth; this column is just a fast-path counter.
async function bumpSpent(toolSlug, costUsd) {
  if (!costUsd) return;
  await psql(`UPDATE tool_credentials
                SET monthly_spent_usd = COALESCE(monthly_spent_usd, 0) + ${q(Number(costUsd) || 0)},
                    last_used_at = now()
              WHERE tool_slug = ${q(toolSlug)};`);
}

// ── Adapter dispatch ───────────────────────────────────────────────
// We inject `_allow_write:true` for any op the runtime has just decided
// to execute. Adapters that perform irreversible actions (ig-graph
// send_dm/publish_post, future poster tools) check this flag as a
// defense-in-depth check against direct callers that bypass the gate.
async function executeNow({ tool, op, args, agent }) {
  const adapter = adapters[tool.conn_method];
  if (!adapter) {
    throw new Error(`No adapter registered for conn_method=${tool.conn_method}`);
  }
  const opSpec = (tool.ops || []).find(o => o.name === op);
  const isWrite = opSpec ? !!opSpec.write : false;
  const argsForAdapter = isWrite ? { ...(args || {}), _allow_write: true } : (args || {});
  return await adapter.execute({ tool, op, args: argsForAdapter, agent });
}

// ── Public entry point ─────────────────────────────────────────────
async function execute({ agent, tool: toolSlug, op, args, taskContext, requestId, projectedCostUsd = 0 }) {
  const tool = registry.get(toolSlug);
  if (!tool) return { ok: false, error: `unknown_tool:${toolSlug}` };

  // op validation — for REST we know the static list; for MCP it was
  // populated on connect into tools.ops.
  const knownOps = (tool.ops && tool.ops.length)
    ? tool.ops.map(o => o.name)
    : null;
  if (knownOps && !knownOps.includes(op)) {
    return { ok: false, error: `unknown_op:${op}` };
  }

  // Permission gate
  let perm = await getPermission(agent, toolSlug);
  let decision = 'auto';

  if (perm.mode === 'off') {
    return { ok: false, error: 'permission_denied', reason: 'tool is off for this agent' };
  }

  if (perm.mode === 'policy') {
    // Phase 5 wires this. For now, fall back to ask so we never
    // accidentally execute under unevaluated policy.
    let policy;
    try { policy = require('./policy'); } catch (_) { policy = null; }
    if (policy && typeof policy.evaluate === 'function') {
      const r = await policy.evaluate({ agent, tool, op, args, policyText: perm.policy_text, taskContext });
      perm = { ...perm, mode: r.decision };          // 'auto' or 'ask'
      decision = r.decision === 'auto' ? 'policy_auto' : 'policy_ask';
    } else {
      perm = { ...perm, mode: 'ask' };
      decision = 'policy_ask';
    }
  }

  if (perm.mode === 'ask') {
    // Queue an Inbox card. The existing permissions.queue() already
    // talks to agent_actions_pending and counts toward inbox-count.
    const callId = await logStart({
      agent, toolSlug, op, args, taskContext, requestId,
      decision: decision === 'auto' ? 'pending_user' : decision,
      status: decision === 'policy_ask' ? 'policy_ask' : 'pending',
    });
    try {
      await permissions.queue({
        agent,
        action: `tool:${toolSlug}:${op}`,
        payload: { tool: toolSlug, op, args, callId, taskContext },
        preview: `${tool.name} → ${op}: ${JSON.stringify(redactArgs(args)).slice(0, 200)}`,
        estimatedCostUsd: projectedCostUsd,
        triggeredBy: agent,
      });
    } catch (e) {
      // Queue failure shouldn't lose the call log — note the error and continue.
      await logEnd(callId, { status: 'error', errorMsg: `queue_failed: ${e.message}` });
      return { ok: false, error: 'queue_failed', detail: e.message };
    }
    return { ok: false, queued: true, callId, requiresApproval: true };
  }

  // perm.mode === 'auto' (or resolved to it via policy)
  const cap = await checkCaps(toolSlug, projectedCostUsd);
  if (!cap.ok) return { ok: false, error: cap.reason, detail: cap.detail };

  const callId = await logStart({ agent, toolSlug, op, args, taskContext, requestId, decision, status: 'pending' });
  try {
    const result = await executeNow({ tool, op, args, agent });
    const costUsd = Number(result && result.costUsd) || 0;
    await logEnd(callId, { status: 'done', output: result.output, costUsd });
    await bumpSpent(toolSlug, costUsd);
    cost.invalidate();
    return { ok: true, output: result.output, cost: costUsd, decision, callId };
  } catch (e) {
    await logEnd(callId, { status: 'error', errorMsg: (e && e.message || String(e)).slice(0, 500) });
    return { ok: false, error: 'adapter_error', detail: e && e.message };
  }
}

// ── Approve a queued tool call (called by the Inbox approve route) ─
async function executeApproved(callId) {
  const out = await psql(`
    SELECT row_to_json(c) FROM (
      SELECT id, agent, tool_slug, op, args_redacted, task_context
      FROM tool_calls WHERE id = ${q(callId)}
    ) c;
  `);
  if (!out) return { ok: false, error: 'unknown_call' };
  let row;
  try { row = JSON.parse(out); } catch (_) { return { ok: false, error: 'bad_call_row' }; }
  const tool = registry.get(row.tool_slug);
  if (!tool) return { ok: false, error: 'unknown_tool' };

  await psql(`UPDATE tool_calls SET decision = 'user_approved', status = 'pending' WHERE id = ${q(callId)};`);
  try {
    const result = await executeNow({ tool, op: row.op, args: row.args_redacted, agent: row.agent });
    const costUsd = Number(result && result.costUsd) || 0;
    await logEnd(callId, { status: 'done', output: result.output, costUsd });
    await bumpSpent(row.tool_slug, costUsd);
    cost.invalidate();
    return { ok: true, output: result.output, cost: costUsd, callId };
  } catch (e) {
    await logEnd(callId, { status: 'error', errorMsg: e && e.message });
    return { ok: false, error: 'adapter_error', detail: e && e.message };
  }
}

async function rejectCall(callId, byUser = 'founder') {
  await psql(`UPDATE tool_calls
                SET status = 'rejected', decision = 'user_rejected',
                    decided_by = ${q(byUser)}, ended_at = now()
              WHERE id = ${q(callId)};`);
  return { ok: true };
}

module.exports = { execute, executeApproved, rejectCall, getPermission, redactArgs };
