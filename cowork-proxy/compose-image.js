// cowork-proxy/compose-image.js
// =====================================================================
// M32/M33 · Image generation for the Compose orchestrator.
//
// Routes through AFSHIN: every cover image creates a `media_library` row
// (owner_agent='afshin', approved=true) so it appears in:
//   • Designs tab (gallery view filters media_library)
//   • Afshin's Train tab "Recent runs" via the agent_runs row written here
//   • Overview cost rollup via agent_runs.cost_usd_actual
//
// Public API:
//   generateCover({ prompt, runId, lang, recipeId, topic })
//     → { ok, url, mediaId, model, cost_usd, error }
//
// On failure (no API key, billing block, prompt rejected) returns
// { ok: false, error } — never throws. The orchestrator marks the
// renderer stage failed with the error visible in the pipeline UI.
// =====================================================================

'use strict';

const crypto = require('crypto');
const storage = require('./storage');
const cost    = require('./cost');
const logWriter = require('./log-writer');
const { query, q, qJson } = require('./db');

const OPENAI_IMAGE_MODEL = 'gpt-image-1';
// Approx cost per image at 1024x1024 standard quality (May 2026).
const COST_PER_IMAGE_USD = 0.04;

// Map compose recipes to media_library.kind values (which are CHECK-constrained
// in the schema). Falls back to 'custom' for anything else.
function _kindFor(recipeId) {
  switch (recipeId) {
    case 'telegram':   return 'telegram_cover';
    case 'facebook':   return 'web_banner';
    case 'x-thread':   return 'web_banner';
    case 'email':      return 'email_header_ravi';
    case 'ig':         return 'ig_carousel_slide';
    case 'seo-article':return 'web_banner';
    default:           return 'custom';
  }
}

async function generateCover({ prompt, runId, lang = 'en', recipeId = null, topic = '' }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' };
  if (!prompt || !prompt.trim()) return { ok: false, error: 'empty image prompt' };

  // Spend gate
  try {
    if (!(await cost.canSpend(COST_PER_IMAGE_USD))) {
      return { ok: false, error: 'monthly cost cap reached' };
    }
  } catch (_) { /* non-fatal */ }

  const t0 = Date.now();
  const mediaId = crypto.randomUUID();
  const kind = _kindFor(recipeId);
  const dimensions = '1024x1024';

  // 1. Insert media_library row up front so the run appears in Designs even if the OpenAI call fails.
  try {
    await query(`
      INSERT INTO media_library (id, kind, topic, language, prompt, owner_agent, approved, approved_at, dimensions, metadata)
      VALUES (${q(mediaId)}, ${q(kind)}, ${q(topic || '(compose)')}, ${q(lang)},
              ${q(String(prompt).slice(0, 4000))}, 'afshin', true, NOW(), ${q(dimensions)},
              ${qJson({ source: 'compose', compose_run_id: runId, recipe: recipeId })});
    `);
  } catch (e) {
    return { ok: false, error: `media_library insert failed: ${e.message.slice(0, 200)}` };
  }

  // 2. Open an Afshin agent_runs row so the work shows up in Afshin's history.
  let agentRunId = null;
  try {
    const r = await logWriter.recordRunStart({
      agent: 'afshin',
      command: `compose-image:${recipeId || 'unknown'}`,
      args: [topic, lang],
    });
    agentRunId = r.runId;
  } catch (_) { /* non-fatal */ }

  // 3. Call OpenAI Images API.
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
        size: dimensions,
        n: 1,
      }),
    });
  } catch (e) {
    if (agentRunId) await logWriter.recordRunEnd({ runId: agentRunId, agent: 'afshin', status: 'fail', error: e.message, durationMs: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: `OpenAI fetch error: ${e.message}`, mediaId };
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    if (agentRunId) await logWriter.recordRunEnd({ runId: agentRunId, agent: 'afshin', status: 'fail', error: `OpenAI ${r.status}: ${txt.slice(0, 200)}`, durationMs: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: `OpenAI ${r.status}: ${txt.slice(0, 300)}`, mediaId };
  }
  const j = await r.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) {
    if (agentRunId) await logWriter.recordRunEnd({ runId: agentRunId, agent: 'afshin', status: 'fail', error: 'OpenAI returned no image data', durationMs: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: 'OpenAI returned no image data', mediaId };
  }
  const buf = Buffer.from(b64, 'base64');

  // 4. Upload to R2 using the standard render-key convention so the dashboard's
  //    existing image-serving works without changes.
  const renderKey = storage.KEYS.RENDER(mediaId);
  try {
    await storage.put({ key: renderKey, body: buf, contentType: 'image/png' });
  } catch (e) {
    if (agentRunId) await logWriter.recordRunEnd({ runId: agentRunId, agent: 'afshin', status: 'fail', error: `R2 upload failed: ${e.message.slice(0, 200)}`, durationMs: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: `R2 upload failed: ${e.message}`, mediaId };
  }

  // 5. Update media_library with render path + cost.
  try {
    await query(`
      UPDATE media_library
         SET render_path     = ${q(renderKey)},
             render_cost_usd = ${COST_PER_IMAGE_USD},
             metadata        = COALESCE(metadata, '{}'::jsonb) || ${qJson({ render_model: OPENAI_IMAGE_MODEL })}::jsonb
       WHERE id = ${q(mediaId)};
    `);
  } catch (e) { /* non-fatal — buffer is already in R2 */ }

  const url = (storage.urlFor ? storage.urlFor(renderKey) : null) || `/storage/${renderKey}`;

  // 6. Close Afshin's agent_runs row.
  if (agentRunId) {
    try {
      await logWriter.recordRunEnd({
        runId: agentRunId,
        agent: 'afshin',
        status: 'success',
        parsedOutput: { mediaId, render_path: renderKey, url, cost_usd: COST_PER_IMAGE_USD },
        costUsd: COST_PER_IMAGE_USD,
        durationMs: Date.now() - t0,
      });
    } catch (_) { /* non-fatal */ }
  }

  return {
    ok: true,
    url,
    mediaId,
    key: renderKey,
    model: OPENAI_IMAGE_MODEL,
    size: dimensions,
    bytes: buf.length,
    cost_usd: COST_PER_IMAGE_USD,
    agent_run_id: agentRunId,
  };
}

module.exports = { generateCover };
