// cowork-proxy/compose-image.js
// =====================================================================
// M37/M38 · Multi-provider image generation for the Compose orchestrator.
//
// Routes through AFSHIN: every cover image creates a `media_library` row
// (owner_agent='afshin', approved=true) so it appears in Designs tab,
// Afshin's Train tab, and the Overview cost rollup.
//
// Supported providers (May 2026 lineup):
//   • openai/gpt-image-1       — strong instruction-following, in-image text;       $0.04/image
//   • recraft/recraft-v3       — brand graphics, palette adherence, vector option;  $0.04/image
//   • ideogram/ideogram-v3     — best for typography in image (1-3 word headlines); $0.075/image
//   • bfl/flux-pro-1.1         — photorealism, hero shots, no on-image text;        $0.04/image
//   • bfl/flux-pro-1.1-ultra   — 4MP, photorealism premium tier;                    $0.06/image
//
// Provider selection priority:
//   1. run.options.image_model   (founder UI override)
//   2. design stage.recommended_model  (Afshin's pick from the design stage)
//   3. recipe.default_image_model
//   4. RECRAFT_API_KEY set ? recraft/recraft-v3 : openai/gpt-image-1
//
// Models fail gracefully — if the chosen provider's API key isn't set,
// we surface a clear error in the image stage and leave the rest of the
// run untouched.
// =====================================================================

'use strict';

const crypto = require('crypto');
const storage = require('./storage');
const cost    = require('./cost');
const logWriter = require('./log-writer');
const { query, q, qJson } = require('./db');

// ── Provider registry ────────────────────────────────────────────────
// Each entry: { label, provider, env_key, cost_usd, supports_text, supports_url_response }
const MODEL_REGISTRY = {
  'openai/gpt-image-1': {
    label: 'GPT Image 1',
    provider: 'openai',
    env_key: 'OPENAI_API_KEY',
    cost_usd: 0.04,
    supports_text: true,        // good with on-image text
    notes: 'Strong instruction-following, in-image text near-perfect, cohesive editorial scenes',
  },
  'recraft/recraft-v3': {
    label: 'Recraft V3',
    provider: 'recraft',
    env_key: 'RECRAFT_API_KEY',
    cost_usd: 0.04,
    supports_text: true,
    notes: 'Best for branded graphics — palette locking, repeatable look, vector-friendly',
  },
  'ideogram/ideogram-v3': {
    label: 'Ideogram 3.0',
    provider: 'ideogram',
    env_key: 'IDEOGRAM_API_KEY',
    cost_usd: 0.075,
    supports_text: true,
    notes: 'Highest text accuracy in image (~90-95%); best when cover has a 1-3 word headline',
  },
  'bfl/flux-pro-1.1': {
    label: 'Flux Pro 1.1',
    provider: 'bfl',
    env_key: 'BFL_API_KEY',
    cost_usd: 0.04,
    supports_text: false,
    notes: 'Best photorealism for hero shots; weak at on-image text',
  },
  'bfl/flux-pro-1.1-ultra': {
    label: 'Flux Pro 1.1 Ultra',
    provider: 'bfl',
    env_key: 'BFL_API_KEY',
    cost_usd: 0.06,
    supports_text: false,
    notes: 'Photoreal premium tier, 4MP output',
  },
};

// Listed for the UI / API. Filters out models whose env key isn't set.
function listAvailableModels() {
  return Object.entries(MODEL_REGISTRY)
    .map(([id, m]) => ({ id, ...m, available: !!process.env[m.env_key] }));
}

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

// Pick the model id for this run. Order: option > design suggestion > recipe default > best available.
function _pickModel({ runOption, designSuggestion, recipeDefault }) {
  const tryList = [runOption, designSuggestion, recipeDefault];
  for (const t of tryList) {
    if (t && MODEL_REGISTRY[t] && process.env[MODEL_REGISTRY[t].env_key]) return t;
  }
  // Best available: prefer Recraft for brand graphics, fall back to OpenAI.
  for (const candidate of ['recraft/recraft-v3', 'openai/gpt-image-1', 'ideogram/ideogram-v3', 'bfl/flux-pro-1.1']) {
    if (process.env[MODEL_REGISTRY[candidate].env_key]) return candidate;
  }
  return null;
}

// ── Provider implementations ─────────────────────────────────────────

async function _genOpenAI(prompt, size, apiKey) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: String(prompt).slice(0, 4000),
      size, n: 1,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('OpenAI returned no image data');
  return Buffer.from(b64, 'base64');
}

async function _genRecraft(prompt, size, apiKey) {
  const [w, h] = size.split('x').map(Number);
  const r = await fetch('https://external.api.recraft.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: String(prompt).slice(0, 4000),
      style: 'digital_illustration',
      size: { width: w, height: h },
      model: 'recraftv3',
      n: 1,
    }),
  });
  if (!r.ok) throw new Error(`Recraft ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const url = ((j.data || [])[0] || {}).url;
  if (!url) throw new Error('Recraft returned no image URL');
  const ir = await fetch(url);
  if (!ir.ok) throw new Error(`Recraft URL fetch ${ir.status}`);
  return Buffer.from(await ir.arrayBuffer());
}

async function _genIdeogram(prompt, size, apiKey, referenceUrls = []) {
  // Ideogram V3 uses multipart/form-data. Supports up to 3 style_reference_images.
  const form = new FormData();
  form.append('prompt', String(prompt).slice(0, 4000));
  form.append('aspect_ratio', size === '1024x1024' ? 'ASPECT_1_1' : 'ASPECT_1_1');
  form.append('rendering_speed', 'DEFAULT');
  form.append('model', 'V_3');
  form.append('num_images', '1');
  // M56 batch B — fetch each reference URL and attach as a Blob so Ideogram
  // can use it for style transfer. Cap at 3 (Ideogram's max).
  if (Array.isArray(referenceUrls) && referenceUrls.length) {
    for (const url of referenceUrls.slice(0, 3)) {
      try {
        const ir = await fetch(url);
        if (ir.ok) {
          const ab = await ir.arrayBuffer();
          const ct = ir.headers.get('content-type') || 'image/jpeg';
          form.append('style_reference_images', new Blob([ab], { type: ct }), 'reference.jpg');
        }
      } catch (_) { /* skip unreachable refs */ }
    }
  }
  const r = await fetch('https://api.ideogram.ai/v1/ideogram-v3/generate', {
    method: 'POST',
    headers: { 'Api-Key': apiKey },
    body: form,
  });
  if (!r.ok) throw new Error(`Ideogram ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const url = ((j.data || [])[0] || {}).url;
  if (!url) throw new Error('Ideogram returned no image URL');
  const ir = await fetch(url);
  if (!ir.ok) throw new Error(`Ideogram URL fetch ${ir.status}`);
  return Buffer.from(await ir.arrayBuffer());
}

async function _genFlux(prompt, size, apiKey, modelId) {
  // Black Forest Labs API: async — submit, then poll for the result.
  const isUltra = modelId === 'bfl/flux-pro-1.1-ultra';
  const endpoint = isUltra
    ? 'https://api.bfl.ai/v1/flux-pro-1.1-ultra'
    : 'https://api.bfl.ai/v1/flux-pro-1.1';
  const [w, h] = size.split('x').map(Number);

  const submit = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: String(prompt).slice(0, 4000),
      width: isUltra ? undefined : w,
      height: isUltra ? undefined : h,
      aspect_ratio: isUltra ? '1:1' : undefined,
      output_format: 'png',
      safety_tolerance: 2,
    }),
  });
  if (!submit.ok) throw new Error(`Flux submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const submitJson = await submit.json();
  const id = submitJson.id;
  if (!id) throw new Error('Flux returned no job id');

  // Poll up to 60 s.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetch(`https://api.bfl.ai/v1/get_result?id=${encodeURIComponent(id)}`, {
      headers: { 'x-key': apiKey },
    });
    if (!poll.ok) throw new Error(`Flux poll ${poll.status}`);
    const pj = await poll.json();
    if (pj.status === 'Ready' && pj.result && pj.result.sample) {
      const ir = await fetch(pj.result.sample);
      if (!ir.ok) throw new Error(`Flux result fetch ${ir.status}`);
      return Buffer.from(await ir.arrayBuffer());
    }
    if (pj.status === 'Error' || pj.status === 'Failed' || pj.status === 'Content Moderated') {
      throw new Error(`Flux job ${pj.status}: ${JSON.stringify(pj).slice(0, 300)}`);
    }
  }
  throw new Error('Flux timed out (60s)');
}

// ── Public API ───────────────────────────────────────────────────────

async function generateCover({
  prompt,
  runId,
  lang = 'en',
  recipeId = null,
  topic = '',
  // M38 — model selection
  runOption = null,        // run.options.image_model
  designSuggestion = null, // design stage's recommended_model
  recipeDefault = null,    // recipe.default_image_model
  size = '1024x1024',
  referenceUrls = [],      // M56 batch B — brand visual reference URLs (when available)
}) {
  if (!prompt || !prompt.trim()) return { ok: false, error: 'empty image prompt' };

  // Pick a model
  const modelId = _pickModel({ runOption, designSuggestion, recipeDefault });
  if (!modelId) {
    const required = Object.values(MODEL_REGISTRY).map(m => m.env_key).join(' / ');
    return { ok: false, error: `no image-gen API key set. Need one of: ${required}` };
  }
  const model = MODEL_REGISTRY[modelId];
  const apiKey = process.env[model.env_key];

  // Spend gate
  try {
    if (!(await cost.canSpend(model.cost_usd))) {
      return { ok: false, error: 'monthly cost cap reached' };
    }
  } catch (_) { /* non-fatal */ }

  const t0 = Date.now();
  const mediaId = crypto.randomUUID();
  const kind = _kindFor(recipeId);
  const dimensions = size;

  // 1. Insert media_library row first so the run appears in Designs even if the API call fails.
  try {
    await query(`
      INSERT INTO media_library (id, kind, topic, language, prompt, owner_agent, approved, approved_at, dimensions, metadata)
      VALUES (${q(mediaId)}, ${q(kind)}, ${q(topic || '(compose)')}, ${q(lang)},
              ${q(String(prompt).slice(0, 4000))}, 'afshin', true, NOW(), ${q(dimensions)},
              ${qJson({ source: 'compose', compose_run_id: runId, recipe: recipeId, model_id: modelId })});
    `);
  } catch (e) {
    return { ok: false, error: `media_library insert failed: ${e.message.slice(0, 200)}` };
  }

  // 2. Open an Afshin agent_runs row.
  let agentRunId = null;
  try {
    const r = await logWriter.recordRunStart({
      agent: 'afshin',
      command: `compose-image:${recipeId || '?'}:${modelId}`,
      args: [topic, lang],
    });
    agentRunId = r.runId;
  } catch (_) { /* non-fatal */ }

  // 3. Call the chosen provider.
  // referenceUrls → forwarded to providers that support image refs (Ideogram supports
  // multipart style_reference_images; Recraft supports custom-style via separate endpoint
  // — for now we anchor descriptively in the prompt, image-to-image lands later). Other
  // providers ignore the URLs (they're already embedded in the prompt as anchors).
  let buf;
  try {
    if (model.provider === 'openai')   buf = await _genOpenAI(prompt, size, apiKey);
    else if (model.provider === 'recraft')  buf = await _genRecraft(prompt, size, apiKey);
    else if (model.provider === 'ideogram') buf = await _genIdeogram(prompt, size, apiKey, referenceUrls);
    else if (model.provider === 'bfl')      buf = await _genFlux(prompt, size, apiKey, modelId);
    else throw new Error(`unsupported provider: ${model.provider}`);
  } catch (e) {
    if (agentRunId) await logWriter.recordRunEnd({ runId: agentRunId, agent: 'afshin', status: 'fail', error: e.message, durationMs: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: `${modelId}: ${e.message}`, mediaId, model_id: modelId };
  }

  // 4. Upload to R2 using the standard render-key.
  const renderKey = storage.KEYS.RENDER(mediaId);
  try {
    await storage.put({ key: renderKey, body: buf, contentType: 'image/png' });
  } catch (e) {
    if (agentRunId) await logWriter.recordRunEnd({ runId: agentRunId, agent: 'afshin', status: 'fail', error: `R2 upload failed: ${e.message.slice(0, 200)}`, durationMs: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: `R2 upload failed: ${e.message}`, mediaId, model_id: modelId };
  }

  // 5. Update media_library with render path + cost.
  try {
    await query(`
      UPDATE media_library
         SET render_path     = ${q(renderKey)},
             render_cost_usd = ${model.cost_usd},
             metadata        = COALESCE(metadata, '{}'::jsonb) || ${qJson({ render_model: modelId, model_label: model.label })}::jsonb
       WHERE id = ${q(mediaId)};
    `);
  } catch (_) { /* non-fatal */ }

  const url = (storage.urlFor ? storage.urlFor(renderKey) : null) || `/storage/${renderKey}`;

  // 6. Close Afshin's agent_runs row.
  if (agentRunId) {
    try {
      await logWriter.recordRunEnd({
        runId: agentRunId,
        agent: 'afshin',
        status: 'success',
        parsedOutput: { mediaId, render_path: renderKey, url, cost_usd: model.cost_usd, model: modelId },
        costUsd: model.cost_usd,
        durationMs: Date.now() - t0,
      });
    } catch (_) { /* non-fatal */ }
  }

  return {
    ok: true,
    url,
    mediaId,
    key: renderKey,
    model: modelId,
    model_label: model.label,
    size: dimensions,
    bytes: buf.length,
    cost_usd: model.cost_usd,
    agent_run_id: agentRunId,
  };
}

module.exports = { generateCover, listAvailableModels, MODEL_REGISTRY };
