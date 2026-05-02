// cowork-proxy/services.js
// =====================================================================
// F3 · Service control. The dashboard's "Services" panel reaches in
// via GET /services + POST /services/:name/:action.
//
// Four services we manage:
//   1. Supabase — controlled by the `supabase` CLI (start/stop). The
//      CLI manages a stack of containers (db, gotrue, kong, etc.).
//   2. n8n — single container named `n8n`. docker start/stop.
//   3. mailhog — single container named `mailhog`. docker start/stop.
//   4. cowork-proxy — itself. Refuses self-stop (would kill the proxy
//      mid-request). User must Ctrl+C in the terminal. We can do
//      "soft restart" via process.exit if a watchdog script is detected.
//
// Status detection:
//   - supabase: `supabase status` returns running/stopped + URLs.
//   - n8n / mailhog: `docker inspect` for container state.
//   - cowork-proxy: trivially "up" — we're answering the request.
//
// The user's source of truth is `start-proxy.bat`. We do NOT alter
// that flow. F3 is additive — the dashboard becomes a convenience
// layer on top of the existing batch files.
// =====================================================================

const { spawnSync } = require('child_process');
const path = require('path');

// Local Supabase anon key (default for `supabase start`). Used only to
// satisfy PostgREST's apikey requirement on the health probe — without it,
// the probe gets HTTP 401 even when the service is fully healthy (H-1).
// This is the public anon key from local supabase, NOT a secret.
const SUPABASE_LOCAL_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Container names match the ones started by setup2-fixed.bat (n8n-test, mailhog-test).
// MailHog Web UI is on host port 8125 because Windows reserves 7932-8031 for Hyper-V.
const SERVICES = {
  supabase:      { kind: 'supabase-cli', healthUrl: 'http://localhost:54321/rest/v1/',
                   healthHeaders: { apikey: SUPABASE_LOCAL_ANON_KEY }, healthyStatuses: [200] },
  n8n:           { kind: 'docker', container: 'n8n-test',     healthUrl: 'http://localhost:5678/healthz', healthyStatuses: [200] },
  mailhog:       { kind: 'docker', container: 'mailhog-test', healthUrl: 'http://localhost:8125/api/v2/messages?limit=1', healthyStatuses: [200] },
  'cowork-proxy':{ kind: 'self' },
};

function _docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 30_000, ...opts });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), code: r.status };
}

function _supabaseCli(arg) {
  // We expect the supabase CLI to be on PATH (the user already runs `supabase start`).
  const r = spawnSync('supabase', [arg], { encoding: 'utf-8', timeout: 90_000, shell: process.platform === 'win32' });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), code: r.status };
}

function dockerInspect(container) {
  const r = _docker(['inspect', '-f', '{{.State.Status}}|{{.State.Running}}|{{.State.StartedAt}}', container]);
  if (!r.ok) return { exists: false, status: 'absent' };
  const [status, running, startedAt] = r.stdout.split('|');
  return { exists: true, status, running: running === 'true', startedAt };
}

function supabaseStatus() {
  // `supabase status` exit 0 if running, non-zero otherwise.
  const r = _supabaseCli('status');
  return { running: r.ok, raw: r.stdout.slice(0, 500) };
}

async function checkHealth(url, headers = null, healthyStatuses = null) {
  if (!url) return { reachable: null };
  // Use a 2s fetch via http module to avoid bringing in a dep.
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    const opts = headers ? { headers } : {};
    const req = proto.get(url, opts, (res) => {
      const status = res.statusCode;
      // If healthyStatuses is provided, "reachable" requires status in that set.
      // Otherwise any HTTP response (the host answered) counts as reachable.
      const reachable = healthyStatuses ? healthyStatuses.includes(status) : true;
      resolve({ reachable, status });
      res.resume();
    });
    req.on('error', () => resolve({ reachable: false }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ reachable: false }); });
  });
}

async function getStatus(serviceName) {
  const cfg = SERVICES[serviceName];
  if (!cfg) return { name: serviceName, error: 'unknown service' };
  const out = { name: serviceName, kind: cfg.kind };
  if (cfg.kind === 'self') {
    out.running = true;
    out.note = 'this is the proxy answering';
  } else if (cfg.kind === 'docker') {
    Object.assign(out, dockerInspect(cfg.container));
    out.running = !!out.running;
    out.container = cfg.container;
  } else if (cfg.kind === 'supabase-cli') {
    Object.assign(out, supabaseStatus());
  }
  if (cfg.healthUrl) {
    Object.assign(out, { healthUrl: cfg.healthUrl,
      ...(await checkHealth(cfg.healthUrl, cfg.healthHeaders || null, cfg.healthyStatuses || null)) });
  }
  return out;
}

async function statusAll() {
  const out = {};
  for (const k of Object.keys(SERVICES)) {
    out[k] = await getStatus(k);
  }
  return out;
}

function action(serviceName, act) {
  const cfg = SERVICES[serviceName];
  if (!cfg) return { ok: false, error: 'unknown service' };
  if (!['start', 'stop', 'restart'].includes(act)) return { ok: false, error: 'invalid action' };

  if (cfg.kind === 'self') {
    return { ok: false, error: 'cowork-proxy cannot stop or restart itself from within. Use Ctrl+C in the proxy terminal then re-run start-proxy.bat.' };
  }

  if (cfg.kind === 'docker') {
    if (act === 'start')   return _docker(['start',   cfg.container]);
    if (act === 'stop')    return _docker(['stop',    cfg.container]);
    if (act === 'restart') return _docker(['restart', cfg.container]);
  }

  if (cfg.kind === 'supabase-cli') {
    if (act === 'start') return _supabaseCli('start');
    if (act === 'stop')  return _supabaseCli('stop');
    if (act === 'restart') {
      const s1 = _supabaseCli('stop');
      if (!s1.ok) return s1;
      return _supabaseCli('start');
    }
  }
  return { ok: false, error: 'unsupported' };
}

module.exports = { SERVICES, getStatus, statusAll, action };
