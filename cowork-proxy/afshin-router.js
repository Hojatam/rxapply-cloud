// cowork-proxy/afshin-router.js
// =====================================================================
// F8 · Afshin design pipeline — multi-provider image generation.
//
// Two modes:
//   1. DRAFT (cheap, fast) — Claude generates SVG layout matching the
//      requested kind + topic. Saved to assets/generated/drafts/<id>.svg.
//      Cost: ~$0.005 per draft.
//   2. RENDER (paid, frontier) — chosen image-gen API produces the final
//      raster PNG. Saved to assets/generated/renders/<id>.png.
//      Provider is resolved: explicit arg > per-kind default > gpt-image-1.
//      Only fires after a draft is approved AND the provider key is set.
//
// MODEL_REGISTRY covers:
//   gpt-image-1, dall-e-3 (OpenAI)
//   stability-sd3 (Stability AI)
//   ideogram-v2 (Ideogram)
//   flux-schnell, flux-dev (Replicate / fal.ai)
//   recraft-v3 (Recraft.ai)
//
// Both modes record to media_library. Render is gated by F9 cap.
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const cost = require('./cost');

const PG_CONTAINER    = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';
const ANTHROPIC_KEY   = () => process.env.ANTHROPIC_API_KEY || '';
const agentModels = require('./agent-models');

const ASSETS_ROOT = path.resolve(__dirname, '..', 'assets', 'generated');
const DRAFTS_DIR  = path.join(ASSETS_ROOT, 'drafts');
const RENDERS_DIR = path.join(ASSETS_ROOT, 'renders');

// ── Kind specifications ───────────────────────────────────────────────

const KIND_SPECS = {
  ig_carousel_slide:  { dim: '1080x1080', label: 'IG Carousel Slide' },
  telegram_cover:     { dim: '1280x720',  label: 'Telegram Cover' },
  youtube_thumb:      { dim: '1280x720',  label: 'YouTube Thumbnail' },
  web_banner:         { dim: '1920x600',  label: 'Web Banner' },
  email_header_ravi:  { dim: '600x200',   label: 'Email Header (Ravi)' },
  custom:             { dim: '1080x1080', label: 'Custom' },
};

// ── Model registry ────────────────────────────────────────────────────
// Each entry: {
//   label, provider, envKey, costEst (USD per render),
//   sizeMap: {dim → api-size}, notes (shown in UI)
// }

const MODEL_REGISTRY = {
  'gpt-image-1': {
    label: 'GPT Image 1',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    costEst: 0.05,
    sizeMap: {
      '1080x1080': '1024x1024',
      '1280x720':  '1536x1024',
      '1920x600':  '1536x1024',
      '600x200':   '1024x1024',
    },
    notes: 'OpenAI flagship image model. High quality, reliable.',
  },
  'dall-e-3': {
    label: 'DALL·E 3',
    provider: 'openai_dalle3',
    envKey: 'OPENAI_API_KEY',
    costEst: 0.04,
    sizeMap: {
      '1080x1080': '1024x1024',
      '1280x720':  '1792x1024',
      '1920x600':  '1792x1024',
      '600x200':   '1024x1024',
    },
    notes: 'OpenAI DALL·E 3. Strong prompt adherence. Same API key as GPT Image 1.',
  },
  'stability-sd3': {
    label: 'Stable Diffusion 3 (Stability AI)',
    provider: 'stability',
    envKey: 'STABILITY_API_KEY',
    costEst: 0.035,
    sizeMap: {
      '1080x1080': '1024x1024',
      '1280x720':  '1344x768',
      '1920x600':  '1344x768',
      '600x200':   '1024x1024',
    },
    notes: 'Stability AI SD3. Good for artistic styles. Needs STABILITY_API_KEY.',
  },
  'ideogram-v2': {
    label: 'Ideogram v2',
    provider: 'ideogram',
    envKey: 'IDEOGRAM_API_KEY',
    costEst: 0.08,
    sizeMap: {
      '1080x1080': 'RESOLUTION_1024_1024',
      '1280x720':  'RESOLUTION_1344_768',
      '1920x600':  'RESOLUTION_1344_768',
      '600x200':   'RESOLUTION_1024_1024',
    },
    notes: 'Ideogram v2. Excellent at text rendering in images. Needs IDEOGRAM_API_KEY.',
  },
  'flux-schnell': {
    label: 'Flux Schnell (Replicate)',
    provider: 'replicate',
    envKey: 'REPLICATE_API_TOKEN',
    costEst: 0.003,
    modelId: 'black-forest-labs/flux-schnell',
    sizeMap: {
      '1080x1080': { width: 1024, height: 1024 },
      '1280x720':  { width: 1360, height: 768 },
      '1920x600':  { width: 1360, height: 768 },
      '600x200':   { width: 1024, height: 1024 },
    },
    notes: 'Fastest Flux model via Replicate. Very cheap (~$0.003). Needs REPLICATE_API_TOKEN.',
  },
  'flux-dev': {
    label: 'Flux Dev (Replicate)',
    provider: 'replicate',
    envKey: 'REPLICATE_API_TOKEN',
    costEst: 0.025,
    modelId: 'black-forest-labs/flux-dev',
    sizeMap: {
      '1080x1080': { width: 1024, height: 1024 },
      '1280x720':  { width: 1360, height: 768 },
      '1920x600':  { width: 1360, height: 768 },
      '600x200':   { width: 1024, height: 1024 },
    },
    notes: 'Flux Dev via Replicate. Higher quality than Schnell. Needs REPLICATE_API_TOKEN.',
  },
  'recraft-v3': {
    label: 'Recraft v3',
    provider: 'recraft',
    envKey: 'RECRAFT_API_KEY',
    costEst: 0.04,
    sizeMap: {
      '1080x1080': '1024x1024',
      '1280x720':  '1280x720',
      '1920x600':  '1024x1024',
      '600x200':   '1024x1024',
    },
    notes: 'Recraft v3. Exceptional brand/logo work. Needs RECRAFT_API_KEY.',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

function _ensureDirs() {
  [ASSETS_ROOT, DRAFTS_DIR, RENDERS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function _psql(script) {
  const r = spawnSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: script, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`psql (${r.status}): ${(r.stderr || '').slice(0, 500)}`);
  return (r.stdout || '').trim();
}

function _q(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── Per-kind model defaults ────────────────────────────────────────────

function getModelDefaults() {
  try {
    const raw = _psql(`SELECT image_model_defaults FROM dashboard_settings WHERE id = 1;`);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function setModelDefault(kind, modelKey) {
  if (!KIND_SPECS[kind]) return { ok: false, error: `unknown kind: ${kind}` };
  if (modelKey && !MODEL_REGISTRY[modelKey]) return { ok: false, error: `unknown model: ${modelKey}` };
  try {
    const current = getModelDefaults();
    if (modelKey) current[kind] = modelKey;
    else delete current[kind];
    const sql = `UPDATE dashboard_settings SET image_model_defaults = '${JSON.stringify(current).replace(/'/g,"''")}'::jsonb, updated_at = NOW() WHERE id = 1;`;
    _psql(sql);
    return { ok: true, kind, model_key: modelKey || null };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

function listModels() {
  const defaults = getModelDefaults();
  return Object.entries(MODEL_REGISTRY).map(([key, m]) => ({
    key,
    label: m.label,
    provider: m.provider,
    envKey: m.envKey,
    keySet: !!(process.env[m.envKey]),
    costEst: m.costEst,
    notes: m.notes,
  }));
}

function getKindDefaults() {
  const defaults = getModelDefaults();
  return Object.keys(KIND_SPECS).map(k => ({
    kind: k,
    label: KIND_SPECS[k].label,
    defaultModel: defaults[k] || null,
    fallback: 'gpt-image-1',
  }));
}

// ── Draft: Claude → SVG ──────────────────────────────────────────────

const brandProfile = require('./brand-profile');
const agentMemory = require('./agent-memory');
const KB = require('./knowledge-base');

function buildDraftPrompt({ kind, topic, language = 'en', notes = '' }) {
  const spec = KIND_SPECS[kind] || KIND_SPECS.custom;
  // Pull live brand context — palette, voice, visual rules — from the
  // central profile. Editing brand-profile.set() once (via Settings) updates
  // every Afshin draft generation on next call. No code redeploy needed.
  const brandBlock = brandProfile.renderAsPromptBlock();
  // K2 · Afshin remembers past briefs and visual corrections.
  const memoryBlock = agentMemory.renderAsBlock('afshin', {
    limit: 6,
    queryKeywords: String(topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5),
  });
  // K6 · KB grounding so on-image text uses verified facts (exam names,
  // institution names, dates) rather than hallucinated ones.
  const detectedCountry = KB.detectCountry(`${topic} ${notes}`);
  const kbBlock = KB.renderAsBlock({ country: detectedCountry, query: topic, limit: 4 });
  return [
    `You are designing an SVG mock for a ${kind} (${spec.dim}).`,
    `Topic: ${topic}`,
    `Language: ${language}`,
    notes ? `Additional notes: ${notes}` : '',
    ``,
    brandBlock,
    kbBlock || '',
    memoryBlock || '',
    ``,
    `Output requirements:`,
    `1. Output ONLY the SVG markup, no prose, no markdown fences.`,
    `2. Start with <svg ... viewBox="0 0 ${spec.dim.replace('x', ' ')}" xmlns="http://www.w3.org/2000/svg">`,
    `3. End with </svg>`,
    `4. Include the topic as the prominent text element.`,
    `5. Self-contained — no <image> tags pointing to external URLs.`,
    `6. Apply the brand visual rules above (geometric, type-led, neg space, no clichéd dental imagery).`,
  ].filter(Boolean).join('\n');
}

async function generateDraft({ kind, topic, language, notes }) {
  const key = ANTHROPIC_KEY();
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  if (!KIND_SPECS[kind]) return { ok: false, error: `unknown kind: ${kind}` };
  if (!topic) return { ok: false, error: 'topic required' };
  if (!cost.canSpend(0.01)) return { ok: false, error: 'monthly cap reached', cost: cost.snapshot() };

  _ensureDirs();
  const prompt = buildDraftPrompt({ kind, topic, language, notes });

  // Resolve model for the 'afshin' agent — per-agent override → env → default.
  const { id: draftModel } = agentModels.resolveModel('afshin');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: draftModel, max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let svg = text.trim();
  const m = /<svg[\s\S]*<\/svg>/.exec(svg);
  if (!m) return { ok: false, error: 'model output did not contain valid SVG', preview: svg.slice(0, 300) };
  svg = m[0];

  const inputTokens  = (j.usage && j.usage.input_tokens)  || 0;
  const outputTokens = (j.usage && j.usage.output_tokens) || 0;
  const draftCost    = agentModels.calcCost(draftModel, inputTokens, outputTokens);

  const id       = crypto.randomUUID();
  const draftRel = path.join('assets', 'generated', 'drafts', `${id}.svg`).replace(/\\/g, '/');
  const draftAbs = path.join(DRAFTS_DIR, `${id}.svg`);
  fs.writeFileSync(draftAbs, svg, 'utf-8');

  const sql = `
    INSERT INTO media_library (id, kind, topic, language, prompt, draft_path, dimensions, draft_cost_usd, metadata)
    VALUES (${_q(id)}, ${_q(kind)}, ${_q(topic)}, ${_q(language || 'en')}, ${_q(prompt)},
            ${_q(draftRel)}, ${_q(KIND_SPECS[kind].dim)}, ${draftCost.toFixed(6)},
            '${JSON.stringify({ model: draftModel, input_tokens: inputTokens, output_tokens: outputTokens })}'::jsonb);
  `;
  try { _psql(sql); }
  catch (e) { return { ok: false, error: 'DB insert failed: ' + e.message.slice(0, 200), id, draftRel }; }

  // K2 · Episodic memory of this draft. Tags include the kind so Afshin
  // can prefer past examples of the same kind on next call.
  try {
    agentMemory.write({
      agent: 'afshin', type: 'episodic',
      content: agentMemory.summarizeForEpisodic({
        agent: 'afshin', action: 'draft',
        output: { summary: `${kind} ${KIND_SPECS[kind].dim} draft for "${(topic||'').slice(0,80)}"` },
        costUsd: draftCost,
        topic,
      }),
      tags: ['design', kind].filter(Boolean),
      importance: 2, source: 'auto',
    });
  } catch (_) { /* non-fatal */ }

  return { ok: true, id, draft_path: draftRel, draft_cost_usd: draftCost,
           dimensions: KIND_SPECS[kind].dim, model: draftModel };
}

// ── Render prompt builder ─────────────────────────────────────────────

function buildRenderPrompt(row) {
  return [
    `A ${(row.kind || '').replace(/_/g, ' ')} for the RxApply brand. Topic: ${row.topic}.`,
    `Style: clean, professional, calm. Indigo (#4f46e5) primary, slate text on white background.`,
    `No stock dental imagery. Geometric, modern, type-led composition.`,
    `Dimensions target: ${row.dimensions}. Language of any text: ${row.language || 'en'}.`,
  ].join(' ');
}

// ── Provider implementations ──────────────────────────────────────────

async function _renderOpenAI(row, modelKey, model, apiKey, prompt) {
  const size = model.sizeMap[row.dimensions] || '1024x1024';
  const isGptImage1 = modelKey === 'gpt-image-1';
  const body = {
    model: isGptImage1 ? 'gpt-image-1' : 'dall-e-3',
    prompt,
    n: 1,
    size,
  };
  if (!isGptImage1) body.response_format = 'url';  // dall-e-3 returns URL by default

  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const j = await r.json();
  const datum = (j.data || [])[0];
  if (!datum) return { ok: false, error: 'no image returned by OpenAI' };
  return { ok: true, b64: datum.b64_json || null, url: datum.url || null };
}

async function _renderStability(row, model, apiKey, prompt) {
  // L-8: native FormData requires Node 18+. The proxy package.json should
  // declare engines.node ">=18". On older Node this throws ReferenceError.
  if (typeof FormData === 'undefined') {
    return { ok: false, error: 'Stability provider requires Node 18+ (native FormData missing)' };
  }
  const dim = row.dimensions || '1080x1080';
  const [w, h] = dim.split('x').map(Number);
  // Use multipart/form-data for Stability AI
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('output_format', 'png');
  // Stability AI SD3 size constraints: closest valid
  formData.append('aspect_ratio', w > h ? '16:9' : w < h ? '9:16' : '1:1');

  const r = await fetch(model.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Accept': 'image/*',
    },
    body: formData,
  });
  if (!r.ok) return { ok: false, error: `Stability AI ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const buf = Buffer.from(await r.arrayBuffer());
  return { ok: true, buffer: buf };
}

async function _renderIdeogram(row, model, apiKey, prompt) {
  const resolution = model.sizeMap[row.dimensions] || 'RESOLUTION_1024_1024';
  const r = await fetch(model.endpoint, {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_request: {
        prompt,
        resolution,
        model: 'V_2',
        magic_prompt_option: 'AUTO',
      },
    }),
  });
  if (!r.ok) return { ok: false, error: `Ideogram ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const j = await r.json();
  const img = ((j.data || [])[0] || {});
  if (!img.url) return { ok: false, error: 'no image URL from Ideogram' };
  return { ok: true, url: img.url };
}

async function _renderReplicate(row, model, apiKey, prompt) {
  const sizeSpec = model.sizeMap[row.dimensions] || { width: 1024, height: 1024 };
  // Create prediction
  const createR = await fetch(`https://api.replicate.com/v1/models/${model.modelId}/predictions`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        prompt,
        width: sizeSpec.width,
        height: sizeSpec.height,
        num_outputs: 1,
        output_format: 'png',
      },
    }),
  });
  if (!createR.ok) return { ok: false, error: `Replicate ${createR.status}: ${(await createR.text()).slice(0, 300)}` };
  let pred = await createR.json();
  // Poll until succeeded or failed. H-6: cold starts on Replicate's free
  // tier routinely take 90–180s for Flux models, so the original 60s cap
  // was almost guaranteed to time out on first run. 60 iterations × 3s
  // = 180s ceiling; if still pending we surface that explicitly so the
  // user knows the prediction is still running on Replicate's side.
  const pollUrl = pred.urls && pred.urls.get;
  if (!pollUrl) return { ok: false, error: 'Replicate did not return poll URL' };
  let timedOut = true;
  for (let i = 0; i < 60; i++) {
    await new Promise(res => setTimeout(res, 3000));
    const pollR = await fetch(pollUrl, { headers: { 'Authorization': 'Bearer ' + apiKey } });
    pred = await pollR.json();
    if (pred.status === 'succeeded') { timedOut = false; break; }
    if (pred.status === 'failed') return { ok: false, error: 'Replicate prediction failed: ' + (pred.error || '') };
  }
  const url = (pred.output || [])[0];
  if (!url) {
    return { ok: false, error: timedOut
      ? `Replicate still processing after 180s — try again shortly (prediction id ${pred.id || '?'} continues on their side)`
      : 'Replicate produced no output' };
  }
  return { ok: true, url };
}

async function _renderRecraft(row, model, apiKey, prompt) {
  const size = model.sizeMap[row.dimensions] || '1024x1024';
  const [w, h] = size.split('x').map(Number);
  const r = await fetch(model.endpoint, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      style: 'digital_illustration',
      size: { width: w, height: h },
      n: 1,
    }),
  });
  if (!r.ok) return { ok: false, error: `Recraft ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const j = await r.json();
  const url = ((j.data || [])[0] || {}).url;
  if (!url) return { ok: false, error: 'no image URL from Recraft' };
  return { ok: true, url };
}

// ── Render: dispatcher ────────────────────────────────────────────────

async function generateRender({ mediaId, prompt, modelKey }) {
  // Fetch the DB row first to get kind + approval status.
  const rowSql = `SELECT row_to_json(r) FROM (SELECT id::text, kind, topic, language, draft_path, approved, dimensions FROM media_library WHERE id = ${_q(mediaId)}) r;`;
  let row;
  try { row = JSON.parse(_psql(rowSql)); } catch (e) { return { ok: false, error: 'media not found' }; }
  if (!row) return { ok: false, error: 'media not found' };
  if (!row.approved) return { ok: false, error: 'draft must be approved before render' };

  // Resolve model: explicit arg → per-kind default → gpt-image-1
  const defaults = getModelDefaults();
  const resolvedKey = modelKey || defaults[row.kind] || 'gpt-image-1';
  const model = MODEL_REGISTRY[resolvedKey];
  if (!model) return { ok: false, error: `unknown model key: ${resolvedKey}` };

  const apiKey = process.env[model.envKey];
  if (!apiKey) return { ok: false, error: `${model.envKey} not set — add to .env and restart proxy`, model_needed: model.envKey };

  if (!cost.canSpend(model.costEst)) return { ok: false, error: 'monthly cap reached', cost: cost.snapshot() };

  const renderPrompt = prompt || buildRenderPrompt(row);

  // Dispatch to provider
  let result;
  try {
    switch (model.provider) {
      case 'openai':
      case 'openai_dalle3':
        result = await _renderOpenAI(row, resolvedKey, model, apiKey, renderPrompt);
        break;
      case 'stability':
        result = await _renderStability(row, model, apiKey, renderPrompt);
        break;
      case 'ideogram':
        result = await _renderIdeogram(row, model, apiKey, renderPrompt);
        break;
      case 'replicate':
        result = await _renderReplicate(row, model, apiKey, renderPrompt);
        break;
      case 'recraft':
        result = await _renderRecraft(row, model, apiKey, renderPrompt);
        break;
      default:
        return { ok: false, error: `unsupported provider: ${model.provider}` };
    }
  } catch (e) {
    return { ok: false, error: `render error (${model.provider}): ${e.message}` };
  }

  if (!result.ok) return result;

  // Save the image file.
  _ensureDirs();
  const renderAbs = path.join(RENDERS_DIR, `${mediaId}.png`);
  if (result.buffer) {
    fs.writeFileSync(renderAbs, result.buffer);
  } else if (result.b64) {
    fs.writeFileSync(renderAbs, Buffer.from(result.b64, 'base64'));
  } else if (result.url) {
    const ir = await fetch(result.url);
    const buf = Buffer.from(await ir.arrayBuffer());
    fs.writeFileSync(renderAbs, buf);
  } else {
    return { ok: false, error: 'provider returned no image data' };
  }

  const renderRel = path.join('assets', 'generated', 'renders', `${mediaId}.png`).replace(/\\/g, '/');
  const renderCost = model.costEst;

  const sql = `
    UPDATE media_library
    SET render_path = ${_q(renderRel)}, render_cost_usd = ${renderCost},
        metadata = COALESCE(metadata, '{}'::jsonb) || '{"render_model": "${resolvedKey}"}'::jsonb
    WHERE id = ${_q(mediaId)};
  `;
  try { _psql(sql); }
  catch (e) { return { ok: false, error: 'DB update failed: ' + e.message.slice(0, 200), render_path: renderRel }; }

  return { ok: true, id: mediaId, render_path: renderRel, render_cost_usd: renderCost,
           model: resolvedKey, model_label: model.label };
}

// ── Gallery ──────────────────────────────────────────────────────────

function gallery({ kind = null, approved = null, limit = 50 } = {}) {
  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const where = ['archived = false'];
  if (kind) where.push(`kind = ${_q(kind)}`);
  if (approved === true)  where.push('approved = true');
  if (approved === false) where.push('approved = false');
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json)
    FROM (SELECT id::text, kind, topic, language, draft_path, render_path,
                 dimensions, approved, draft_cost_usd, render_cost_usd,
                 metadata, used_by, created_at::text
          FROM media_library WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC LIMIT ${limit}) s;
  `;
  try { return JSON.parse(_psql(sql)); } catch (_) { return []; }
}

function approve(mediaId, approved = true) {
  const sql = `
    UPDATE media_library SET approved = ${approved ? 'TRUE' : 'FALSE'},
                              approved_at = ${approved ? 'NOW()' : 'NULL'}
    WHERE id = ${_q(mediaId)} RETURNING id::text;
  `;
  try { return { ok: true, id: _psql(sql) }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

function archive(mediaId) {
  const sql = `UPDATE media_library SET archived = true WHERE id = ${_q(mediaId)};`;
  try { _psql(sql); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

module.exports = {
  generateDraft, generateRender, gallery, approve, archive,
  listModels, getKindDefaults, setModelDefault, getModelDefaults,
  KIND_SPECS, MODEL_REGISTRY,
  hasOpenAI: () => !!process.env.OPENAI_API_KEY,
  hasAnthropic: () => !!process.env.ANTHROPIC_API_KEY,
  ASSETS_ROOT,
};
