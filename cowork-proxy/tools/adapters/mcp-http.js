// cowork-proxy/tools/adapters/mcp-http.js
// =====================================================================
// Adapter for vendor-hosted MCP servers reachable over HTTP. We talk
// the JSON-RPC 2.0 dialect MCP standardised: a POST per request, the
// server returns either a single response or a Server-Sent-Events
// stream. We use the simpler request/response form.
//
// Two ops MCP servers always expose:
//   tools/list  → discovers ops dynamically (cached in tools.ops)
//   tools/call  → invokes an op
//
// On connect we call tools/list and persist the result so the UI can
// show the founder which ops are available.
// =====================================================================

const { psql, q, qJson } = require('../db');
const { decryptSqlExpr } = require('../crypto');

let _rpcId = 1;

async function _rpc(url, key, method, params, extraHeaders) {
  const body = { jsonrpc: '2.0', id: _rpcId++, method, params };
  const headers = { 'content-type': 'application/json', 'accept': 'application/json' };
  if (key) headers['authorization'] = `Bearer ${key}`;
  Object.assign(headers, extraHeaders || {});
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`MCP HTTP ${r.status}: ${text.slice(0, 200)}`);
  // Some MCP servers reply with SSE — strip the 'data: ' prefix and
  // parse the first event (the only one for non-streaming responses).
  let payload = text;
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const m = text.match(/^data:\s*(\{.*\})\s*$/m);
    if (m) payload = m[1];
  }
  let j;
  try { j = JSON.parse(payload); } catch (_) {
    throw new Error(`MCP HTTP non-JSON: ${payload.slice(0, 200)}`);
  }
  if (j.error) throw new Error(`MCP RPC error: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

function _loadSecrets(slug) {
  const out = psql(`
    SELECT ${decryptSqlExpr('secrets_enc')}
    FROM tool_credentials WHERE tool_slug = ${q(slug)};
  `);
  if (!out) return null;
  try { return JSON.parse(out); } catch (_) { return null; }
}

async function discoverOps(toolSlug) {
  const secrets = _loadSecrets(toolSlug);
  if (!secrets || !secrets.mcp_url) {
    throw new Error('mcp_url + api_key required — connect the tool first.');
  }
  const r = await _rpc(secrets.mcp_url, secrets.api_key, 'tools/list', {});
  const ops = (r.tools || []).map(t => ({
    name: t.name,
    description: t.description || '',
    write: /post|create|publish|send|update|delete|reply|schedule/i.test(t.name),
    schema: t.inputSchema || null,
  }));
  // Persist into the tools row so the Agents matrix can render meaningful labels
  psql(`UPDATE tools SET ops = ${qJson(ops)}, updated_at = now() WHERE slug = ${q(toolSlug)};`);
  return ops;
}

async function execute({ tool, op, args }) {
  const secrets = _loadSecrets(tool.slug);
  if (!secrets || !secrets.mcp_url) throw new Error('mcp_url missing — connect the tool first.');
  if (op === 'test' || op === '_test') {
    // tools/list ping
    await _rpc(secrets.mcp_url, secrets.api_key, 'tools/list', {});
    return { output: { ok: true, note: 'tools/list reachable' }, costUsd: 0 };
  }
  const r = await _rpc(secrets.mcp_url, secrets.api_key, 'tools/call', {
    name: op,
    arguments: args || {},
  });
  return {
    output: r.content || r,
    costUsd: 0,            // Vendor's billing is on their side; we don't double-charge.
  };
}

module.exports = { execute, discoverOps };
