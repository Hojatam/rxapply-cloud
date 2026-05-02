// cowork-proxy/compose-image.js
// =====================================================================
// M32 · Image generation for the Compose orchestrator.
//
// Single-provider, single-model: OpenAI's gpt-image-1. Kept tight on
// purpose — afshin-router has the multi-provider/full-feature path; this
// module exists for the inline-cover use case during a Compose run, where
// we just want a square cover image from a brief.
//
// Public API:
//   generateCover({ prompt, runId, lang, size = '1024x1024' })
//     → { ok, url, key, model, cost_usd, error }
//
// The image is uploaded to R2 under:
//   compose-runs/<run_id>/cover-<lang>-<timestamp>.png
//
// On failure (no API key, billing issue, prompt rejection) returns
// { ok: false, error } — never throws. The orchestrator marks the
// stage failed and continues.
// =====================================================================

'use strict';

const storage = require('./storage');
const cost    = require('./cost');

const OPENAI_IMAGE_MODEL = 'gpt-image-1';
// Approx cost per image at 1024x1024 standard quality (May 2026).
// Used for the spend cap; actual billing comes from OpenAI.
const COST_PER_IMAGE_USD = 0.04;

async function generateCover({ prompt, runId, lang = 'en', size = '1024x1024' }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' };
  if (!prompt || !prompt.trim()) return { ok: false, error: 'empty image prompt' };

  // Spend gate
  try {
    if (!(await cost.canSpend(COST_PER_IMAGE_USD))) {
      return { ok: false, error: 'monthly cost cap reached' };
    }
  } catch (_) { /* cost module optional */ }

  // Call OpenAI Images API.
  let r;
  try {
    r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt: String(prompt).slice(0, 4000),
        size,
        n: 1,
        // gpt-image-1 returns base64 by default and that's what we want
        // (no signed-URL expiry race when uploading to R2).
      }),
    });
  } catch (e) {
    return { ok: false, error: `OpenAI fetch error: ${e.message}` };
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, error: `OpenAI ${r.status}: ${txt.slice(0, 300)}` };
  }
  const j = await r.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) return { ok: false, error: 'OpenAI returned no image data' };
  const buf = Buffer.from(b64, 'base64');

  // Upload to R2.
  const ts = Date.now();
  const key = `compose-runs/${runId}/cover-${lang}-${ts}.png`;
  let url = null;
  try {
    await storage.put({ key, body: buf, contentType: 'image/png' });
    // Storage.url() resolves to either media.rxapply.com (public-domain'd
    // R2 bucket) or the local public-storage path in dev.
    url = (storage.urlFor ? storage.urlFor(key) : null) || `/storage/${key}`;
  } catch (e) {
    return { ok: false, error: `R2 upload failed: ${e.message}` };
  }

  return {
    ok: true,
    url,
    key,
    model: OPENAI_IMAGE_MODEL,
    size,
    bytes: buf.length,
    cost_usd: COST_PER_IMAGE_USD,
  };
}

module.exports = { generateCover };
