// cowork-proxy/canva.js
// =====================================================================
// M103 · Canva Connect API client.
//
// Surface (every method returns { ok, ... } — never throws):
//   hasToken()                                  → bool
//   getToken()                                  → string | null   (env > db row)
//   ping()                                      → { ok, latency_ms, count?, error? }
//   listBrandTemplates({ brandId, query })      → { ok, items, next? }
//   getBrandTemplate(id)                        → { ok, template, dataset }
//   uploadAsset({ buffer, mimeType, name })     → { ok, asset_id, url }
//   autofillFromTemplate({ templateId, data })  → { ok, job_id }     (async)
//   pollAutofill(jobId, { maxMs })              → { ok, design_id, urls, thumbnail_url }
//   getDesign(designId)                         → { ok, design }
//   resize({ designId, presets, custom })       → { ok, results }    (Magic Resize)
//   exportDesign({ designId, format })          → { ok, url, bytes }
//
// Token resolution order:
//   1. process.env.CANVA_API_TOKEN
//   2. canva_settings.api_token (single-row config in DB)
// Resolved fresh on each call so a token rotated through the dashboard
// takes effect without restart.
//
// All HTTP errors come back as { ok:false, code, error } so callers
// can branch on missing-token vs network vs API-rejection without
// try/catch noise.
// =====================================================================

'use strict';

const { queryValue, query, q } = require('./db');

const BASE_URL = 'https://api.canva.com/rest/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

// ── Token resolution ─────────────────────────────────────────────────

let _cachedDbToken = null;
let _cachedDbTokenAt = 0;
const TOKEN_CACHE_MS = 5_000;

async function _resolveToken() {
  if (process.env.CANVA_API_TOKEN) return process.env.CANVA_API_TOKEN;
  // Fall back to the single-row settings table; cache briefly so we
  // don't hit the DB on every call inside a tight loop (autofill polls).
  if (Date.now() - _cachedDbTokenAt < TOKEN_CACHE_MS && _cachedDbToken !== null) {
    return _cachedDbToken;
  }
  try {
    const v = await queryValue(`SELECT api_token FROM canva_settings WHERE id = 1;`);
    _cachedDbToken    = v || '';
    _cachedDbTokenAt  = Date.now();
    return _cachedDbToken || null;
  } catch (_) {
    return null;
  }
}

function hasToken() {
  if (process.env.CANVA_API_TOKEN) return true;
  // Synchronous best-effort using cached value
  return !!_cachedDbToken;
}

async function hasTokenAsync() {
  const t = await _resolveToken();
  return !!t;
}

// ── Low-level HTTP ───────────────────────────────────────────────────

async function _withTimeout(promise, label, ms = DEFAULT_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function _req({ method = 'GET', path, body = null, query: qParams = null, mimeOverride = null, raw = false }) {
  const token = await _resolveToken();
  if (!token) return { ok: false, code: 'NO_TOKEN', error: 'CANVA_API_TOKEN not set (env or DB)' };

  let url = `${BASE_URL}${path}`;
  if (qParams && Object.keys(qParams).length) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(qParams)) {
      if (v != null) usp.set(k, String(v));
    }
    url += `?${usp.toString()}`;
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };
  let bodyInit = null;
  if (body != null) {
    if (body instanceof Buffer) {
      headers['Content-Type'] = mimeOverride || 'application/octet-stream';
      bodyInit = body;
    } else if (typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(body);
    } else {
      bodyInit = body;
    }
  }

  let r;
  try {
    r = await _withTimeout(fetch(url, { method, headers, body: bodyInit }), `canva.${method} ${path}`);
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: e.message };
  }

  if (raw) return { ok: r.ok, status: r.status, response: r };

  let json = null;
  try { json = await r.json(); } catch (_) { /* may be empty */ }

  if (!r.ok) {
    const apiCode = json && (json.code || (json.error && json.error.code)) || `HTTP_${r.status}`;
    const apiMsg  = json && (json.message || (json.error && json.error.message)) || r.statusText;
    return { ok: false, code: apiCode, status: r.status, error: apiMsg, body: json };
  }
  return { ok: true, status: r.status, body: json };
}

// ── Public API surface ───────────────────────────────────────────────

async function ping() {
  const t0 = Date.now();
  const r = await _req({ path: '/brand-templates', query: { limit: 1 } });
  if (!r.ok) return { ok: false, latency_ms: Date.now() - t0, code: r.code, error: r.error };
  const items = (r.body && r.body.items) || [];
  return { ok: true, latency_ms: Date.now() - t0, count_first_page: items.length };
}

async function listBrandTemplates({ brandId = null, query: qStr = null, continuation = null, limit = 50 } = {}) {
  const params = { limit };
  if (brandId)     params.brand_id = brandId;
  if (qStr)        params.query    = qStr;
  if (continuation) params.continuation = continuation;
  const r = await _req({ path: '/brand-templates', query: params });
  if (!r.ok) return r;
  const body = r.body || {};
  return { ok: true, items: body.items || [], continuation: body.continuation || null };
}

async function getBrandTemplate(id) {
  const r = await _req({ path: `/brand-templates/${encodeURIComponent(id)}` });
  if (!r.ok) return r;
  const tpl = (r.body && r.body.brand_template) || r.body || null;
  // Try to pull the dataset (autofill slot definitions) — separate endpoint
  const ds = await _req({ path: `/brand-templates/${encodeURIComponent(id)}/dataset` });
  return {
    ok: true,
    template: tpl,
    dataset: ds.ok ? (ds.body && ds.body.dataset) : null,
    dataset_error: ds.ok ? null : ds.error,
  };
}

// Asset upload uses a separate URL prefix per Canva docs but we keep
// it all under our normal _req path-rewrite for simplicity. Canva
// returns a job that the design references; for autofill we just need
// the asset_id which appears on the job result.
async function uploadAsset({ buffer, mimeType, name }) {
  if (!buffer || !buffer.length) return { ok: false, code: 'BAD_INPUT', error: 'empty buffer' };
  const token = await _resolveToken();
  if (!token) return { ok: false, code: 'NO_TOKEN', error: 'CANVA_API_TOKEN not set' };

  // Canva expects raw bytes with metadata in a header
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': mimeType || 'application/octet-stream',
    'Asset-Upload-Metadata': JSON.stringify({ name_base64: Buffer.from(name || 'rxapply-asset', 'utf8').toString('base64') }),
  };
  let r;
  try {
    r = await _withTimeout(fetch(`${BASE_URL}/asset-uploads`, {
      method: 'POST', headers, body: buffer,
    }), 'canva.uploadAsset');
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: e.message };
  }
  let json = null; try { json = await r.json(); } catch (_) {}
  if (!r.ok) {
    return { ok: false, code: 'UPLOAD_FAILED', status: r.status, error: (json && (json.message || json.error && json.error.message)) || r.statusText };
  }
  // Canva returns a job; for small images it usually completes synchronously.
  const job = (json && json.job) || json;
  const asset = job && job.asset;
  if (asset && asset.id) {
    return { ok: true, asset_id: asset.id, url: asset.thumbnail && asset.thumbnail.url || null };
  }
  // Job not yet finished — poll briefly. Caller can retry.
  return { ok: true, asset_id: null, job_id: job && job.id, raw: json };
}

async function autofillFromTemplate({ templateId, data, title = null }) {
  if (!templateId) return { ok: false, code: 'BAD_INPUT', error: 'templateId required' };
  const r = await _req({
    method: 'POST', path: '/autofills',
    body: { brand_template_id: templateId, title: title || undefined, data: data || {} },
  });
  if (!r.ok) return r;
  const job = r.body && r.body.job;
  if (!job) return { ok: false, code: 'NO_JOB', error: 'autofill response missing job', body: r.body };
  return { ok: true, job_id: job.id, status: job.status, raw: job };
}

async function pollAutofill(jobId, { maxMs = 60000, intervalMs = 1500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await _req({ path: `/autofills/${encodeURIComponent(jobId)}` });
    if (!r.ok) return r;
    const job = r.body && r.body.job;
    if (!job) return { ok: false, code: 'NO_JOB_BODY', error: 'autofill poll missing job' };
    if (job.status === 'success') {
      const result = job.result || {};
      const design = result.design || {};
      return {
        ok: true,
        design_id: design.id || result.design_id,
        urls: design.urls || {},
        thumbnail_url: design.thumbnail && design.thumbnail.url,
        raw: job,
      };
    }
    if (job.status === 'failed') {
      return { ok: false, code: 'AUTOFILL_FAILED', error: (job.error && job.error.message) || 'autofill failed', raw: job };
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return { ok: false, code: 'AUTOFILL_TIMEOUT', error: `autofill did not complete within ${maxMs}ms` };
}

async function getDesign(designId) {
  const r = await _req({ path: `/designs/${encodeURIComponent(designId)}` });
  if (!r.ok) return r;
  return { ok: true, design: r.body && r.body.design };
}

// Magic Resize. Canva's API exposes this as a synchronous resize for
// preset platforms, OR a custom width/height pair. We accept either
// and return one row per requested target.
async function resize({ designId, presets = [], custom = [] }) {
  if (!designId) return { ok: false, code: 'BAD_INPUT', error: 'designId required' };
  const targets = [];
  for (const p of presets) targets.push({ preset: p });
  for (const c of custom) {
    if (c && c.width_px && c.height_px) {
      targets.push({ width: c.width_px, height: c.height_px, name: c.name || null });
    }
  }
  if (!targets.length) return { ok: false, code: 'BAD_INPUT', error: 'no targets' };

  const results = [];
  for (const t of targets) {
    const body = t.preset
      ? { preset: t.preset }
      : { custom_size: { width: t.width, height: t.height } };
    const r = await _req({
      method: 'POST',
      path: `/designs/${encodeURIComponent(designId)}/resizes`,
      body,
    });
    if (!r.ok) {
      results.push({ ok: false, target: t, error: r.error, code: r.code });
      continue;
    }
    const job = r.body && r.body.job;
    // Resize is also async; poll briefly
    let final = null;
    if (job && job.id) {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const pr = await _req({ path: `/designs/${encodeURIComponent(designId)}/resizes/${encodeURIComponent(job.id)}` });
        if (!pr.ok) { final = { ok: false, error: pr.error }; break; }
        const j = pr.body && pr.body.job;
        if (!j) break;
        if (j.status === 'success') {
          final = { ok: true, design: j.result && j.result.design };
          break;
        }
        if (j.status === 'failed') {
          final = { ok: false, error: (j.error && j.error.message) || 'resize failed' };
          break;
        }
        await new Promise(res => setTimeout(res, 1200));
      }
    }
    results.push({ ok: !!(final && final.ok), target: t, design: final && final.design, error: final && !final.ok ? final.error : null });
  }
  return { ok: true, results };
}

async function exportDesign({ designId, format = 'png', size = null }) {
  if (!designId) return { ok: false, code: 'BAD_INPUT', error: 'designId required' };
  const body = { design_id: designId, format: { type: format } };
  if (size) body.format.size = size;
  const r = await _req({ method: 'POST', path: '/exports', body });
  if (!r.ok) return r;
  const job = r.body && r.body.job;
  if (!job) return { ok: false, code: 'NO_JOB', error: 'export response missing job' };

  // Poll to completion
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const pr = await _req({ path: `/exports/${encodeURIComponent(job.id)}` });
    if (!pr.ok) return pr;
    const j = pr.body && pr.body.job;
    if (j && j.status === 'success') {
      const urls = (j.urls || []).map(u => u.url || u);
      return { ok: true, urls, raw: j };
    }
    if (j && j.status === 'failed') {
      return { ok: false, code: 'EXPORT_FAILED', error: (j.error && j.error.message) || 'export failed' };
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  return { ok: false, code: 'EXPORT_TIMEOUT', error: 'export did not complete within 90s' };
}

// ── Settings helpers (one-row config) ────────────────────────────────

async function getSettings() {
  try {
    const v = await queryValue(`SELECT row_to_json(s) FROM (SELECT * FROM canva_settings WHERE id = 1) s;`);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return { error: e.message };
  }
}

async function patchSettings(patch) {
  const cols = ['api_token', 'default_brand_id', 'autofill_async', 'poll_max_ms', 'preferred_export_format', 'notes'];
  const sets = [];
  for (const c of cols) {
    if (Object.prototype.hasOwnProperty.call(patch, c)) {
      const v = patch[c];
      if (v === null) sets.push(`${c} = NULL`);
      else if (typeof v === 'boolean' || typeof v === 'number') sets.push(`${c} = ${v}`);
      else sets.push(`${c} = ${q(String(v))}`);
    }
  }
  if (!sets.length) return { ok: false, error: 'nothing to update' };
  sets.push(`updated_at = now()`);
  await query(`UPDATE canva_settings SET ${sets.join(', ')} WHERE id = 1;`);
  // Bust the token cache so the next call picks up the new value.
  _cachedDbToken = null;
  _cachedDbTokenAt = 0;
  return { ok: true };
}

module.exports = {
  hasToken, hasTokenAsync,
  ping,
  listBrandTemplates, getBrandTemplate,
  uploadAsset,
  autofillFromTemplate, pollAutofill,
  getDesign,
  resize,
  exportDesign,
  getSettings, patchSettings,
};
