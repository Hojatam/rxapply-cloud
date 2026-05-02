// cowork-proxy/n8n-control.js
// =====================================================================
// F4 · n8n workflow management via the n8n REST API.
//
// n8n exposes (since 1.x) a REST API at /api/v1/* gated by an API key
// header `X-N8N-API-KEY`. To enable: in n8n UI → Settings → API → create
// a key. Set it as N8N_API_KEY in the proxy's .env. Without a key, this
// module returns clear 401-style errors so the dashboard can hint at
// what to do.
//
// Routes wired in server.js:
//   GET   /n8n/workflows                       — list with id, name, active, updatedAt
//   GET   /n8n/workflows/:id                   — full workflow JSON
//   PATCH /n8n/workflows/:id/active            — body { active: bool } → activate/deactivate
//   POST  /n8n/workflows/:id/run               — manual execution
//   POST  /n8n/workflows/import                — body { filename } → POST a JSON from n8n-workflows/
//   GET   /n8n/executions?workflow_id=…        — recent executions (last 20)
// =====================================================================

const fs = require('fs');
const path = require('path');

const N8N_URL  = process.env.N8N_URL      || 'http://localhost:5678';
// Read at call time, not module load time — so a .env edit picks up after
// the proxy restarts without leaving a stale empty string in scope (L-7).
const _n8nKey  = () => process.env.N8N_API_KEY || '';
const WF_DIR   = path.resolve(__dirname, '..', 'n8n-workflows');

function _headers() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const k = _n8nKey();
  if (k) h['X-N8N-API-KEY'] = k;
  return h;
}

async function _fetch(p, opts = {}) {
  const url = N8N_URL + p;
  // Node 18+ has global fetch.
  const r = await fetch(url, { ...opts, headers: { ..._headers(), ...(opts.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { ok: r.ok, status: r.status, body };
}

function isAuthConfigured() { return !!_n8nKey(); }

async function listWorkflows({ active = null } = {}) {
  if (!isAuthConfigured()) return { ok: false, error: 'N8N_API_KEY not set in proxy .env', hint: 'Create a key in n8n UI → Settings → API.' };
  const params = new URLSearchParams();
  if (active != null) params.set('active', active ? 'true' : 'false');
  const r = await _fetch(`/api/v1/workflows?${params}`);
  if (!r.ok) return { ok: false, status: r.status, error: (r.body && r.body.message) || `n8n returned ${r.status}` };
  // n8n returns { data: [...], nextCursor: "..." }
  const items = Array.isArray(r.body) ? r.body : (r.body.data || []);
  return {
    ok: true,
    workflows: items.map(w => ({
      id: w.id, name: w.name, active: !!w.active,
      updatedAt: w.updatedAt, createdAt: w.createdAt,
      tags: (w.tags || []).map(t => t.name || t),
      nodeCount: (w.nodes || []).length,
    })),
  };
}

async function getWorkflow(id) {
  if (!isAuthConfigured()) return { ok: false, error: 'N8N_API_KEY not set' };
  const r = await _fetch(`/api/v1/workflows/${encodeURIComponent(id)}`);
  if (!r.ok) return { ok: false, status: r.status, error: (r.body && r.body.message) || `n8n returned ${r.status}` };
  return { ok: true, workflow: r.body };
}

async function setActive(id, active) {
  if (!isAuthConfigured()) return { ok: false, error: 'N8N_API_KEY not set' };
  // n8n exposes activate/deactivate as POST endpoints.
  // (Don't shadow `path` from require('path') above.)
  const urlPath = active ? `/api/v1/workflows/${encodeURIComponent(id)}/activate`
                         : `/api/v1/workflows/${encodeURIComponent(id)}/deactivate`;
  const r = await _fetch(urlPath, { method: 'POST' });
  if (!r.ok) return { ok: false, status: r.status, error: (r.body && r.body.message) || `n8n returned ${r.status}` };
  return { ok: true, id, active };
}

// Convert a host-pointing URL ("host.docker.internal:7777") to a localhost URL
// so the proxy can call its OWN /run-helper without going through Docker DNS.
function _proxyfyUrl(url) {
  return String(url || '').replace(/host\.docker\.internal:7777/g, 'localhost:7777');
}

// Order workflow nodes by walking the connections graph from the trigger.
// Returns the array of {name, node} in execution order, EXCLUDING trigger nodes.
function _orderActionNodes(workflow) {
  const nodes = workflow.nodes || [];
  const conns = workflow.connections || {};
  const byName = Object.fromEntries(nodes.map(n => [n.name, n]));
  const TRIGGERS = new Set([
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.cron',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.formTrigger',
    'n8n-nodes-base.manualTrigger',
  ]);
  const triggers = nodes.filter(n => TRIGGERS.has(n.type));
  const visited = new Set();
  const order = [];
  function walk(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const node = byName[name];
    if (!node) return;
    if (!TRIGGERS.has(node.type)) order.push({ name, node });
    const out = (conns[name] && conns[name].main) || [];
    for (const slot of out) {
      for (const c of (slot || [])) walk(c.node);
    }
  }
  // Start from each trigger; if there are no triggers, start from every node not pointed at.
  if (triggers.length > 0) {
    triggers.forEach(t => walk(t.name));
  } else {
    const pointedAt = new Set();
    for (const slots of Object.values(conns)) {
      for (const slot of (slots.main || [])) {
        for (const c of (slot || [])) pointedAt.add(c.node);
      }
    }
    nodes.forEach(n => { if (!pointedAt.has(n.name)) walk(n.name); });
  }
  return order;
}

// Parse the body of an n8n httpRequest node. n8n stores expressions like
// "={ ... }" — strip the leading "=" then JSON.parse.
function _parseHttpNodeBody(node) {
  const p = node.parameters || {};
  const raw = p.jsonBody || p.body || '';
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('=')) s = s.slice(1).trim();
  // Drop n8n template expressions like {{ JSON.stringify(...) }} — we can't evaluate them
  // without a real n8n runtime, so substitute "{}" inline.
  s = s.replace(/\{\{[^}]*\}\}/g, '{}');
  try { return JSON.parse(s); } catch (_) { return null; }
}

async function runWorkflow(id) {
  if (!isAuthConfigured()) return { ok: false, error: 'N8N_API_KEY not set' };

  const wf = await _fetch(`/api/v1/workflows/${encodeURIComponent(id)}`);
  if (!wf.ok) return { ok: false, status: wf.status, error: (wf.body && wf.body.message) || `n8n returned ${wf.status}` };
  const workflow = wf.body;
  const nodes = workflow.nodes || [];

  // Path A — webhook-triggered: POST the webhook URL through n8n.
  const webhookNode = nodes.find(n =>
    n.type === 'n8n-nodes-base.webhook' || n.type === 'n8n-nodes-base.formTrigger'
  );
  if (webhookNode) {
    const httpMethod = (webhookNode.parameters && webhookNode.parameters.httpMethod) || 'POST';
    const wPath = (webhookNode.parameters && webhookNode.parameters.path) || webhookNode.webhookId;
    if (!wPath) return { ok: false, error: 'webhook node has no path / webhookId' };

    const isActive = !!workflow.active;
    const segment = isActive ? 'webhook' : 'webhook-test';
    const url = `${N8N_URL}/${segment}/${encodeURIComponent(wPath)}`;
    try {
      const r = await fetch(url, {
        method: httpMethod,
        headers: { 'Content-Type': 'application/json' },
        body: httpMethod === 'GET' ? undefined : '{}',
      });
      const text = await r.text();
      let body = null; try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 500) }; }
      if (!r.ok) {
        const hint = !isActive
          ? ` — workflow is INACTIVE: open it in the n8n UI and click "Listen for test event" first`
          : '';
        return { ok: false, status: r.status, error: `webhook ${r.status}${hint}`, url, body };
      }
      return { ok: true, via: 'webhook', url, method: httpMethod, body };
    } catch (e) {
      return { ok: false, error: 'webhook call failed: ' + e.message, url };
    }
  }

  // Path B — cron / schedule / no trigger: simulate by walking the workflow graph
  // and calling /run-helper directly for every httpRequest node that points at our proxy.
  // n8n's public API has no execute endpoint, so we side-step n8n and run the same
  // chain ourselves. This makes the dashboard's "Run" button work for cron workflows too.
  const action = _orderActionNodes(workflow);
  const helperCalls = action.filter(({ node }) =>
    node.type === 'n8n-nodes-base.httpRequest' &&
    /\/run-helper$/.test((node.parameters && node.parameters.url) || '')
  );

  if (helperCalls.length === 0) {
    return {
      ok: false,
      error: 'workflow has no httpRequest nodes calling /run-helper — cannot simulate from the proxy',
      hint: 'Open the workflow in the n8n UI and click "Execute Workflow".',
      n8nUiUrl: `${N8N_URL}/workflow/${encodeURIComponent(id)}`,
    };
  }

  // Execute each helper call sequentially through THIS proxy.
  const PORT = process.env.PORT || 7777;
  const SELF = `http://localhost:${PORT}`;
  const steps = [];
  let allOk = true;
  for (const { name, node } of helperCalls) {
    const body = _parseHttpNodeBody(node);
    if (!body || !body.agent) {
      steps.push({ node: name, ok: false, error: 'could not parse {agent, command} from node body' });
      allOk = false;
      continue;
    }
    try {
      const r = await fetch(`${SELF}/run-helper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: body.agent,
          command: body.command || 'help',
          args: body.args || [],
          stdin: body.stdin || null,
        }),
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (_) { j = { raw: text.slice(0, 300) }; }
      const ok = r.ok && j && j.ok !== false;
      steps.push({
        node: name,
        agent: body.agent,
        command: body.command || 'help',
        ok,
        runId: j && j.runId,
        durationMs: j && j.durationMs,
        outputPreview: j && j.output ? String(j.output).slice(0, 200) : null,
        error: !ok ? (j && (j.error || j.raw)) : null,
      });
      if (!ok) allOk = false;
    } catch (e) {
      steps.push({ node: name, agent: body.agent, ok: false, error: e.message });
      allOk = false;
    }
  }
  return {
    ok: allOk,
    via: 'simulated-cron',
    note: 'cron workflows have no n8n-API execute endpoint — proxy walked the graph and called /run-helper for each step',
    workflowName: workflow.name,
    stepCount: steps.length,
    steps,
  };
}

async function listExecutions({ workflowId = null, limit = 20 } = {}) {
  if (!isAuthConfigured()) return { ok: false, error: 'N8N_API_KEY not set' };
  const params = new URLSearchParams();
  if (workflowId) params.set('workflowId', workflowId);
  params.set('limit', String(limit));
  const r = await _fetch(`/api/v1/executions?${params}`);
  if (!r.ok) return { ok: false, status: r.status, error: (r.body && r.body.message) || `n8n returned ${r.status}` };
  const items = Array.isArray(r.body) ? r.body : (r.body.data || []);
  return {
    ok: true,
    executions: items.map(e => ({
      id: e.id, workflowId: e.workflowId, finished: e.finished,
      mode: e.mode, status: e.status || (e.finished ? 'success' : 'running'),
      startedAt: e.startedAt, stoppedAt: e.stoppedAt,
    })),
  };
}

function libraryList() {
  if (!fs.existsSync(WF_DIR)) return [];
  return fs.readdirSync(WF_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const stat = fs.statSync(path.join(WF_DIR, f));
      return { filename: f, bytes: stat.size, modified: stat.mtime.toISOString() };
    });
}

async function importFromLibrary(filename) {
  if (!isAuthConfigured()) return { ok: false, error: 'N8N_API_KEY not set' };
  if (!/^[\w.-]+\.json$/.test(filename)) return { ok: false, error: 'invalid filename' };
  const fp = path.join(WF_DIR, filename);
  if (!fs.existsSync(fp)) return { ok: false, error: 'file not in n8n-workflows/' };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (e) { return { ok: false, error: 'invalid JSON: ' + e.message }; }

  // n8n POST /workflows rejects read-only fields. Whitelist only the writable ones.
  // Read-only on create: id · versionId · active · tags · triggerCount · pinData · meta
  // · createdAt · updatedAt · shared. Workflow imports always start INACTIVE; user
  // toggles them on from the Workflows panel after sanity-checking the cron expression.
  const body = {
    name: raw.name,
    nodes: raw.nodes || [],
    connections: raw.connections || {},
    settings: raw.settings || {},
  };
  if (raw.staticData) body.staticData = raw.staticData;
  if (!body.name) return { ok: false, error: 'workflow JSON missing required "name" field' };

  const r = await _fetch('/api/v1/workflows', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) return { ok: false, status: r.status, error: (r.body && r.body.message) || `n8n returned ${r.status}` };
  return { ok: true, id: r.body && r.body.id, name: r.body && r.body.name,
           note: 'Imported as inactive — toggle on from the Workflows panel after reviewing.' };
}

module.exports = { isAuthConfigured, listWorkflows, getWorkflow, setActive,
  runWorkflow, listExecutions, libraryList, importFromLibrary, N8N_URL };
