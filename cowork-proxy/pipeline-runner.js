// cowork-proxy/pipeline-runner.js
// =====================================================================
// F6 · Visual pipeline editor backend.
//
// Handles:
//   - Save / load / list / delete pipeline graphs (stored as JSON files
//     in /pipelines/ dir AND mirrored to the DB pipelines table).
//   - Run a pipeline: topologically sorts Drawflow nodes, executes each
//     agent node by calling the run-helper, streams progress via SSE.
//
// Pipeline graph format matches the Drawflow export:
//   { drawflow: { Home: { data: { "1": { id, name, data, inputs, outputs, pos_x, pos_y } } } } }
//
// Node types understood by the runner:
//   agent      — runs a helper: data.agent (string), data.args (string)
//   conditional— branches on a JS expression: data.condition
//   transform  — transforms the carry object: data.expression (JS)
//   output     — terminal sink, collects the carry value
// =====================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync, spawn } = require('child_process');
const { query, q, qJson } = require('./db');

// ── Sandboxed eval helper (H-5) ───────────────────────────────────────
// Runs user-supplied JS expressions in a vm context with NO access to
// require, process, global, fs, child_process, etc. Only `carry` is in
// scope. Throws on syntax error; returns the expression's value.
function _safeEval(expr, carry, asBoolean = false) {
  const ctx = vm.createContext(Object.create(null));
  ctx.carry = carry;
  const src = asBoolean ? `(!!(${expr}))` : `(${expr})`;
  // 1s wall-clock cap so a runaway expression can't hang the run loop.
  return vm.runInContext(src, ctx, { timeout: 1000, displayErrors: false });
}

const PG_CONTAINER  = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';
const AGENTS_DIR    = path.resolve(__dirname, '..', 'agents');
const PYTHON_BIN    = process.env.PYTHON_BIN || 'python';
const PIPELINES_DIR = path.resolve(__dirname, '..', 'pipelines');

function _ensurePipelinesDir() {
  if (!fs.existsSync(PIPELINES_DIR)) fs.mkdirSync(PIPELINES_DIR, { recursive: true });
}

function _safeName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9 _\-]{0,79}$/.test(name);
}

function _slug(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
}

// ── Save ──────────────────────────────────────────────────────────────
// Cloud build note: in Railway the local filesystem is volatile (resets
// on each deploy). A future hardening will flip the source of truth from
// disk to DB for pipelines. For now we keep the dual-write so local dev
// of the cloud build still works the same way.

async function savePipeline({ name, description, graphData }) {
  if (!name || !_safeName(name)) return { ok: false, error: 'name must be 1–80 chars, alphanumeric/space/_/-' };
  if (!graphData || typeof graphData !== 'object') return { ok: false, error: 'graphData required (Drawflow export JSON)' };

  _ensurePipelinesDir();
  const slug = _slug(name);
  const filePath = path.join(PIPELINES_DIR, `${slug}.json`);

  // Count nodes
  const nodes = Object.values((graphData.drawflow && graphData.drawflow.Home && graphData.drawflow.Home.data) || {});
  const nodeCount = nodes.length;

  const payload = { name, description: description || '', graphData, savedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

  // Mirror to DB (idempotent upsert).
  try {
    await query(`
      INSERT INTO pipelines (name, description, graph_data, node_count, updated_at)
      VALUES (${q(name)}, ${q(description || '')}, ${qJson(graphData)}, ${nodeCount}, NOW())
      ON CONFLICT (name) DO UPDATE
        SET description = ${q(description || '')},
            graph_data  = ${qJson(graphData)},
            node_count  = ${nodeCount},
            updated_at  = NOW();
    `);
  } catch (_) { /* DB sync optional — file is the source of truth */ }

  return { ok: true, name, slug, nodeCount, filePath };
}

// ── Load ──────────────────────────────────────────────────────────────

function loadPipeline(name) {
  _ensurePipelinesDir();
  const slug = _slug(name);
  const filePath = path.join(PIPELINES_DIR, `${slug}.json`);
  if (!fs.existsSync(filePath)) return { ok: false, error: `pipeline "${name}" not found` };
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { ok: true, ...payload };
  } catch (e) {
    return { ok: false, error: 'corrupt pipeline file: ' + e.message };
  }
}

// ── List ──────────────────────────────────────────────────────────────

function listPipelines() {
  _ensurePipelinesDir();
  const files = fs.readdirSync(PIPELINES_DIR).filter(f => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(PIPELINES_DIR, f), 'utf-8'));
      const nodes = Object.values((raw.graphData && raw.graphData.drawflow && raw.graphData.drawflow.Home && raw.graphData.drawflow.Home.data) || {});
      items.push({
        name: raw.name,
        description: raw.description || '',
        nodeCount: nodes.length,
        savedAt: raw.savedAt,
        slug: _slug(raw.name),
      });
    } catch (_) { /* skip corrupt files */ }
  }
  items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return items;
}

// ── Delete ──────────────────────────────────────────────────────────

async function deletePipeline(name) {
  _ensurePipelinesDir();
  const slug = _slug(name);
  const filePath = path.join(PIPELINES_DIR, `${slug}.json`);
  if (!fs.existsSync(filePath)) return { ok: false, error: 'not found' };
  fs.unlinkSync(filePath);
  try { await query(`DELETE FROM pipelines WHERE name = ${q(name)};`); } catch (_) {}
  return { ok: true };
}

// ── Topological sort ──────────────────────────────────────────────────

function topologicalSort(nodes) {
  // Build adjacency: for each node collect which nodeIds it must wait for.
  const inDegree = {};
  const deps = {};  // nodeId → [nodeId, ...]  (predecessors)
  const succ  = {};  // nodeId → [nodeId, ...]  (successors)

  for (const [id] of Object.entries(nodes)) {
    inDegree[id] = 0;
    deps[id] = [];
    succ[id]  = [];
  }

  for (const [id, node] of Object.entries(nodes)) {
    for (const inp of Object.values(node.inputs || {})) {
      for (const conn of (inp.connections || [])) {
        const fromId = String(conn.node);
        if (succ[fromId]) {
          succ[fromId].push(id);
          deps[id].push(fromId);
          inDegree[id]++;
        }
      }
    }
  }

  // Kahn's algorithm
  const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
  const order = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    order.push(cur);
    for (const next of (succ[cur] || [])) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  if (order.length < Object.keys(nodes).length) {
    throw new Error('cycle detected in pipeline graph');
  }
  return order;
}

// ── Run ──────────────────────────────────────────────────────────────
// Writes progress to `emit(event, data)` callback (SSE adapter).

async function runPipeline({ name, graphData: inlineGraph }, emit) {
  let graphData = inlineGraph;
  if (!graphData && name) {
    const loaded = loadPipeline(name);
    if (!loaded.ok) { emit('error', { message: loaded.error }); return; }
    graphData = loaded.graphData;
  }
  if (!graphData) { emit('error', { message: 'no graph provided' }); return; }

  const home = graphData.drawflow && graphData.drawflow.Home && graphData.drawflow.Home.data;
  if (!home || Object.keys(home).length === 0) {
    emit('error', { message: 'pipeline graph is empty' });
    return;
  }

  let order;
  try { order = topologicalSort(home); }
  catch (e) { emit('error', { message: e.message }); return; }

  emit('start', { nodeCount: order.length, order });

  // ── Branch tracking (B-1 fix) ────────────────────────────────────────
  // A node executes only if at least one of its incoming connections came
  // from a "live" output port. Conditionals mark only the chosen output
  // as live; the other branch's downstream nodes get skipped automatically.
  // Non-conditional nodes mark all their outputs live after running.
  const liveEdges = new Set();           // "<fromNodeId>:<outputPortName>"
  const skipped   = new Set();           // node ids that won't run
  const runResult = new Map();           // nodeId -> { output } for incoming-merge

  function _isLive(nodeId) {
    if (skipped.has(nodeId)) return false;
    const node = home[nodeId];
    const inputs = node.inputs || {};
    // No incoming connections => it's a source, always runs.
    let hasAnyConn = false;
    for (const inp of Object.values(inputs)) {
      for (const conn of (inp.connections || [])) {
        hasAnyConn = true;
        // conn.node = predecessor id, conn.input = predecessor's output port name (e.g. "output_1")
        if (liveEdges.has(`${conn.node}:${conn.input}`)) return true;
      }
    }
    return !hasAnyConn;
  }

  function _markAllOutputsLive(nodeId) {
    const node = home[nodeId];
    const outputs = node.outputs || {};
    for (const portName of Object.keys(outputs)) {
      liveEdges.add(`${nodeId}:${portName}`);
    }
  }

  // carry = data passed from node to node (output of previous node)
  let carry = {};
  const results = {};

  for (const nodeId of order) {
    const node = home[nodeId];
    const nodeType = node.name;
    const nodeData = node.data || {};

    if (!_isLive(nodeId)) {
      skipped.add(nodeId);
      emit('step', { nodeId, nodeType, status: 'skipped', reason: 'inactive branch' });
      continue;
    }

    emit('step', { nodeId, nodeType, agent: nodeData.agent, status: 'running' });

    try {
      if (nodeType === 'agent') {
        const agentName = nodeData.agent || '';
        const args      = nodeData.args  || '';
        if (!agentName) { emit('step', { nodeId, nodeType, status: 'skipped', reason: 'no agent selected' }); continue; }

        // Distinguish between missing directory vs. missing script (L-6)
        const agentDir = path.join(AGENTS_DIR, agentName);
        const agentScript = path.join(agentDir, `${agentName}.py`);
        if (!fs.existsSync(agentDir)) {
          emit('step', { nodeId, nodeType, agent: agentName, status: 'fail',
                         error: `agent directory not found: ${agentDir}` });
          carry = { error: `agent dir missing: ${agentName}` };
          continue;
        }
        if (!fs.existsSync(agentScript)) {
          emit('step', { nodeId, nodeType, agent: agentName, status: 'fail',
                         error: `agent script not found: ${agentScript}` });
          carry = { error: `agent script missing: ${agentName}` };
          continue;
        }

        // Run python helper ASYNCHRONOUSLY (C-1) so SSE events can flush
        // to the client between steps. spawnSync would block the entire
        // event loop and hold every emit() in the socket buffer.
        const cmdArgs = [agentScript];
        if (args) cmdArgs.push(...args.split(/\s+/).filter(Boolean));
        const r = await new Promise((resolve) => {
          const child = spawn(PYTHON_BIN, cmdArgs, {
            cwd: agentDir,
            // PYTHONIOENCODING fixes Windows cp1252 stdout crashes when
            // helpers print non-ASCII characters (≥, →, Farsi, Arabic).
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          });
          let out = '', err = '';
          const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 120000);
          child.stdout.on('data', d => { out += d.toString('utf-8'); });
          child.stderr.on('data', d => { err += d.toString('utf-8'); });
          child.on('error', (e) => { clearTimeout(killTimer); resolve({ status: -1, stdout: out, stderr: e.message }); });
          child.on('close', (code) => { clearTimeout(killTimer); resolve({ status: code, stdout: out, stderr: err }); });
        });
        const stdout = (r.stdout || '').trim();
        const stderr = (r.stderr || '').trim();
        let output;
        try { output = JSON.parse(stdout); } catch (_) { output = { raw: stdout }; }
        carry = output;
        results[nodeId] = { agent: agentName, output, stderr: stderr.slice(0, 500) };
        if (r.status === 0) _markAllOutputsLive(nodeId);
        emit('step', { nodeId, nodeType, agent: agentName, status: r.status === 0 ? 'success' : 'fail',
                       output, stderr: stderr.slice(0, 200) });

      } else if (nodeType === 'conditional') {
        // Evaluate condition expression in a vm sandbox (H-5) — no access
        // to require/process/global; only `carry` is in scope; 1s timeout.
        // B-1 fix: actually branch — mark only the chosen output as live.
        // Drawflow convention: output_1 = true branch, output_2 = false branch.
        const cond = nodeData.condition || 'true';
        let result;
        try { result = !!_safeEval(cond, carry, true); }
        catch (e) { result = false; }
        const livePort = result ? 'output_1' : 'output_2';
        liveEdges.add(`${nodeId}:${livePort}`);
        carry = { ...carry, _branch: result ? 'true' : 'false' };
        emit('step', { nodeId, nodeType, condition: cond, result,
                       livePort, status: 'success' });

      } else if (nodeType === 'transform') {
        const expr = nodeData.expression || 'carry';
        try {
          carry = _safeEval(expr, carry, false);
          _markAllOutputsLive(nodeId);
          emit('step', { nodeId, nodeType, status: 'success', carry });
        } catch (e) {
          emit('step', { nodeId, nodeType, status: 'fail', error: e.message });
        }

      } else if (nodeType === 'output') {
        results['_output'] = carry;
        emit('step', { nodeId, nodeType, status: 'success', value: carry });

      } else {
        emit('step', { nodeId, nodeType, status: 'skipped', reason: `unknown node type: ${nodeType}` });
      }
    } catch (e) {
      emit('step', { nodeId, nodeType, status: 'fail', error: e.message });
    }
  }

  emit('done', { results });
}

module.exports = { savePipeline, loadPipeline, listPipelines, deletePipeline, runPipeline, PIPELINES_DIR };
