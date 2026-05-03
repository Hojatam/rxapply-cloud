// cowork-proxy/regulatory-watchdog.js
// =====================================================================
// M46 · Regulatory drift watchdog.
//
// On a schedule (Railway cron OR n8n OR manual via UI), check every active
// watchpoint URL: fetch, optionally narrow to a CSS selector, compute a
// stable content hash, compare to last seen. On change, record a drift event
// for founder review and update the watchpoint's last_hash.
//
// No per-watchpoint seeding here. Founder defines watchpoints (CRUD via API
// or by adding KB entries with metadata.watchpoint_url and tagging them as
// regulators).
//
// Public API:
//   listWatchpoints({ country, active })   → []
//   createWatchpoint({ url, ... })          → { id }
//   updateWatchpoint(id, fields)
//   archiveWatchpoint(id)
//   checkAll()                              → { checked, changed, errors }
//   checkOne(id)                            → { changed, hash, error }
//   listDriftEvents({ status, limit })      → []
//   resolveDriftEvent(id, resolution)
// =====================================================================

'use strict';

const crypto = require('crypto');
const { query, queryRows, queryValue, queryReturning, q, qJson } = require('./db');

// ── Helpers ──────────────────────────────────────────────────────────

function _hash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

// Tag-strip + whitespace-normalise so cosmetic page tweaks don't trigger drift.
// Best-effort regex; for higher accuracy add a real HTML parser later.
function _normalize(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');                          // strip tags
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');    // common entities
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function _selectorScope(html, selector) {
  if (!selector) return html;
  // Trivial selector handler (id, class). For robust selector resolution,
  // upgrade to cheerio later. For now we support: '#id' and '.class'.
  const m = selector.match(/^#([\w-]+)$/);
  if (m) {
    const re = new RegExp(`<[^>]+id\\s*=\\s*["']${m[1]}["'][\\s\\S]*?</[a-z][^>]*>`, 'i');
    const found = html.match(re);
    return found ? found[0] : html;
  }
  const c = selector.match(/^\.([\w-]+)$/);
  if (c) {
    const re = new RegExp(`<[^>]+class\\s*=\\s*["'][^"']*\\b${c[1]}\\b[^"']*["'][\\s\\S]*?</[a-z][^>]*>`, 'i');
    const found = html.match(re);
    return found ? found[0] : html;
  }
  return html;
}

function _diffExcerpt(prev, next, max = 2000) {
  // Emit a small textual diff: first 80 chars before/after the first divergence,
  // plus a few word-tokens that are new. Good enough for a "drift detected" preview.
  if (!prev) return `(first capture · ${String(next).slice(0, max)})`;
  const a = String(prev || '');
  const b = String(next || '');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const start = Math.max(0, i - 80);
  const end = Math.min(b.length, i + max);
  const before = a.slice(start, i + 80);
  const after  = b.slice(start, end);
  return [
    `--- diff at byte ${i} ---`,
    `[BEFORE] …${before}…`,
    `[AFTER]  …${after}…`,
  ].join('\n');
}

// ── CRUD ─────────────────────────────────────────────────────────────

async function listWatchpoints({ country = null, active = null } = {}) {
  const conds = [];
  if (country)        conds.push(`country = ${q(country)}`);
  if (active === true)  conds.push(`active = TRUE`);
  if (active === false) conds.push(`active = FALSE`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return await queryRows(`
    SELECT id::text, kb_entry_id::text, label, country, regulator, url, selector,
            last_hash, last_check_at::text, last_change_at::text,
            consecutive_errors, last_error, active, created_at::text
      FROM regulatory_watchpoints ${where}
      ORDER BY country NULLS LAST, regulator NULLS LAST, label NULLS LAST;`);
}

async function createWatchpoint({ url, label = null, country = null, regulator = null,
                                  selector = null, kb_entry_id = null, metadata = {} }) {
  if (!url) throw new Error('url required');
  const id = await queryReturning(`
    INSERT INTO regulatory_watchpoints
      (kb_entry_id, label, country, regulator, url, selector, metadata)
    VALUES (${q(kb_entry_id)}, ${q(label)}, ${q(country)}, ${q(regulator)},
            ${q(url)}, ${q(selector)}, ${qJson(metadata || {})})
    RETURNING id::text;`);
  return { ok: true, id };
}

async function updateWatchpoint(id, fields) {
  const allowed = ['label', 'country', 'regulator', 'url', 'selector', 'active'];
  const sets = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'active') sets.push(`active = ${v ? 'TRUE' : 'FALSE'}`);
    else sets.push(`${k} = ${q(v)}`);
  }
  if (fields && fields.metadata) sets.push(`metadata = ${qJson(fields.metadata)}`);
  if (sets.length === 0) return { ok: false, error: 'no fields to update' };
  sets.push('updated_at = NOW()');
  await query(`UPDATE regulatory_watchpoints SET ${sets.join(', ')} WHERE id = ${q(id)};`);
  return { ok: true };
}

async function archiveWatchpoint(id) {
  await query(`UPDATE regulatory_watchpoints SET active = FALSE, updated_at = NOW() WHERE id = ${q(id)};`);
  return { ok: true };
}

// ── Check ────────────────────────────────────────────────────────────

async function checkOne(watchpointId) {
  const rows = await queryRows(`
    SELECT id::text, url, selector, last_hash, label, country, regulator
      FROM regulatory_watchpoints
     WHERE id = ${q(watchpointId)} AND active = TRUE LIMIT 1;`);
  const wp = rows[0];
  if (!wp) return { ok: false, error: 'watchpoint not found or inactive' };

  let html;
  try {
    const r = await fetch(wp.url, {
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; rxapply-watchdog/1.0; +https://rxapply.com)',
        'accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!r.ok) {
      await query(`UPDATE regulatory_watchpoints
                      SET consecutive_errors = consecutive_errors + 1,
                          last_error = ${q(`HTTP ${r.status}`)},
                          last_check_at = NOW(), updated_at = NOW()
                    WHERE id = ${q(watchpointId)};`);
      return { ok: false, error: `HTTP ${r.status}`, watchpoint_id: watchpointId };
    }
    html = await r.text();
  } catch (e) {
    await query(`UPDATE regulatory_watchpoints
                    SET consecutive_errors = consecutive_errors + 1,
                        last_error = ${q(String(e.message).slice(0, 500))},
                        last_check_at = NOW(), updated_at = NOW()
                  WHERE id = ${q(watchpointId)};`);
    return { ok: false, error: e.message, watchpoint_id: watchpointId };
  }

  const scoped = _selectorScope(html, wp.selector);
  const norm = _normalize(scoped);
  const newHash = _hash(norm);
  const changed = wp.last_hash && wp.last_hash !== newHash;

  // Always update last_check_at + clear error counter on success
  if (changed) {
    // Persist drift event before updating last_hash so we have the prev_hash.
    const excerpt = _diffExcerpt(wp.last_hash ? '(hash only — previous content not retained)' : null, norm.slice(0, 4000));
    await query(`
      INSERT INTO regulatory_drift_events
        (watchpoint_id, prev_hash, new_hash, diff_size_bytes, diff_excerpt)
      VALUES (${q(watchpointId)}, ${q(wp.last_hash)}, ${q(newHash)},
              ${Math.abs(norm.length - 0)}, ${q(excerpt.slice(0, 8000))});`);
    await query(`UPDATE regulatory_watchpoints
                    SET last_hash = ${q(newHash)},
                        last_check_at = NOW(),
                        last_change_at = NOW(),
                        consecutive_errors = 0,
                        last_error = NULL,
                        updated_at = NOW()
                  WHERE id = ${q(watchpointId)};`);
    return { ok: true, changed: true, hash: newHash, watchpoint_id: watchpointId };
  } else if (!wp.last_hash) {
    // First capture
    await query(`UPDATE regulatory_watchpoints
                    SET last_hash = ${q(newHash)},
                        last_check_at = NOW(),
                        consecutive_errors = 0,
                        last_error = NULL,
                        updated_at = NOW()
                  WHERE id = ${q(watchpointId)};`);
    return { ok: true, changed: false, first_capture: true, hash: newHash, watchpoint_id: watchpointId };
  } else {
    await query(`UPDATE regulatory_watchpoints
                    SET last_check_at = NOW(),
                        consecutive_errors = 0,
                        last_error = NULL,
                        updated_at = NOW()
                  WHERE id = ${q(watchpointId)};`);
    return { ok: true, changed: false, hash: newHash, watchpoint_id: watchpointId };
  }
}

async function checkAll() {
  const wps = await queryRows(`
    SELECT id::text FROM regulatory_watchpoints
     WHERE active = TRUE
     ORDER BY last_check_at NULLS FIRST, updated_at ASC LIMIT 200;`);
  const results = [];
  for (const wp of wps) {
    try { results.push(await checkOne(wp.id)); }
    catch (e) { results.push({ ok: false, error: e.message, watchpoint_id: wp.id }); }
    // Be polite to regulator servers — 500ms gap between fetches.
    await new Promise(r => setTimeout(r, 500));
  }
  const checked = results.length;
  const changed = results.filter(r => r.changed).length;
  const errors  = results.filter(r => !r.ok).length;
  return { ok: true, checked, changed, errors, results };
}

// ── Drift events ─────────────────────────────────────────────────────

async function listDriftEvents({ status = null, limit = 100 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const where = status ? `WHERE e.status = ${q(status)}` : '';
  return await queryRows(`
    SELECT e.id::text, e.watchpoint_id::text, e.detected_at::text,
            e.prev_hash, e.new_hash, e.diff_size_bytes, e.diff_excerpt,
            e.status, e.reviewed_at::text, e.reviewed_by, e.resolution_note,
            w.label AS watchpoint_label, w.country, w.regulator, w.url
      FROM regulatory_drift_events e
      LEFT JOIN regulatory_watchpoints w ON w.id = e.watchpoint_id
      ${where}
      ORDER BY e.detected_at DESC LIMIT ${limit};`);
}

async function resolveDriftEvent(id, { status, note = null, by = 'founder' }) {
  if (!['reviewed', 'dismissed', 'kb-updated'].includes(status)) {
    throw new Error('status must be one of: reviewed, dismissed, kb-updated');
  }
  await query(`
    UPDATE regulatory_drift_events
       SET status = ${q(status)}, reviewed_at = NOW(), reviewed_by = ${q(by)},
           resolution_note = ${q(note)}
     WHERE id = ${q(id)} AND status = 'pending';`);
  return { ok: true };
}

async function pendingCount() {
  const v = await queryValue(`SELECT COUNT(*) FROM regulatory_drift_events WHERE status = 'pending';`);
  return parseInt(v, 10) || 0;
}

module.exports = {
  // CRUD
  listWatchpoints, createWatchpoint, updateWatchpoint, archiveWatchpoint,
  // checks
  checkOne, checkAll,
  // drift events
  listDriftEvents, resolveDriftEvent, pendingCount,
};
