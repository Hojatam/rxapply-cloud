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
const cost = require('./cost');
const storage = require('./storage');

const ANTHROPIC_KEY   = () => process.env.ANTHROPIC_API_KEY || '';
const agentModels = require('./agent-models');

// ASSETS_ROOT is kept for backward-compat (express.static still serves
// /assets/generated for any pre-existing local files), but new drafts +
// renders go through storage.js instead.
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

// ── M61 · Brand templates (codified from 5-yr archive analysis) ─────
// Two templates carry 22% of the brand's output. Each template binds a
// slot schema → preferred model → render-prompt scaffolding. Tarrah
// picks a template; Afshin renders each slide using template + slot
// values. Founders can hand-tune `prefer_model` per template if needed.
const TEMPLATE_REGISTRY = {
  'vertical-workshop-poster': {
    label: 'Vertical workshop poster',
    description: 'Large title + Persian country pill + circular medical icon + 2-4 body bullets + small date pill. The brand\'s most-used template.',
    slot_schema: ['title', 'subtitle', 'country_pill', 'icon', 'body_bullets', 'block_color', 'accent_color', 'date_pill', 'key_number'],
    required_slots: ['title', 'block_color'],
    prefer_model: 'gpt-image-2',
    render_scaffold:
      'Vertical poster, RxApply brand. Solid-fill {block_color} block dominates the layout with the title "{title}" rendered in bold sans-serif Persian/Arabic-supporting type. ' +
      'Small {country_pill_color} pill containing the word "{country_pill}" near the title. ' +
      'A circular {icon} icon callout in brand teal #00a69c sized ~12% of the canvas. ' +
      'Body bullets stacked beneath the title in white-on-block. Small date pill in the lower corner. ' +
      'Teal R-arrow logo on white square placed as an integrated element (not a corner watermark). ' +
      'Mood: {mood}. No clichéd dental imagery (toothbrush/pill stock).',
  },
  'shield-frame-deadline': {
    label: 'Shield-frame deadline poster',
    description: 'Landmark/portrait + flag-color overlay + map background + bold orange deadline pill. For urgent country-specific exam deadlines.',
    slot_schema: ['title', 'country_pill', 'deadline_pill', 'date_pill', 'block_color', 'accent_color', 'icon'],
    required_slots: ['title', 'deadline_pill', 'date_pill'],
    prefer_model: 'gpt-image-2',
    render_scaffold:
      'Vertical poster, RxApply brand, deadline-pressure variant. Country landmark or doctor portrait with subtle flag-color overlay, faint world-map background pattern. ' +
      'Bold orange (#ff7a1a) deadline pill with the text "{deadline_pill}" in upper third. ' +
      'Title "{title}" in {block_color} solid-fill block. ' +
      'Country pill "{country_pill}" near title. Date "{date_pill}" in small pill. ' +
      'Teal R-arrow logo integrated. Tone: urgent but professional, not clickbait.',
  },
  'photoreal-hero-with-block': {
    label: 'Photoreal hero with caption block',
    description: 'Photo of doctor/clinic/student + solid-fill caption block in lower third. Country posts.',
    slot_schema: ['title', 'subtitle', 'country_pill', 'block_color', 'accent_color', 'icon'],
    required_slots: ['title', 'block_color'],
    prefer_model: 'gpt-image-2',
    render_scaffold:
      'Photoreal hero portrait (doctor / dentist / student in clinical or study setting), no clichéd stock dental imagery. ' +
      'Subtle flag-color overlay if country-specific. Lower-third caption: solid {block_color} block with title "{title}" in bold {accent_color} type. ' +
      'Optional country pill "{country_pill}" near title. ' +
      'Teal R-arrow logo integrated. Mood: {mood}.',
  },
  'watercolor-occasion': {
    label: 'Watercolor occasion illustration',
    description: 'Hand-drawn watercolor with bilingual Persian + English title. ONLY for occasion days (Doctor Day, Pharmacist Day, etc.).',
    slot_schema: ['title', 'subtitle', 'block_color', 'accent_color'],
    required_slots: ['title'],
    prefer_model: 'recraft-v3',
    render_scaffold:
      'Hand-drawn watercolor illustration, RxApply brand, occasion-day variant. Soft brush strokes, warm palette anchored on {block_color}. ' +
      'Bilingual title: "{title}" (Persian, large) and English equivalent (smaller). ' +
      'No photoreal elements. Subtle teal R-arrow watermark. ' +
      'Mood: warm, celebratory, restrained — not flashy.',
  },
};

function getTemplate(templateId) {
  return TEMPLATE_REGISTRY[templateId] || null;
}

function listTemplates() {
  return Object.entries(TEMPLATE_REGISTRY).map(([id, t]) => ({
    id, label: t.label, description: t.description,
    required_slots: t.required_slots, prefer_model: t.prefer_model,
  }));
}

// Render a template scaffold by substituting {slot} tokens with values
// from the slide's slots. Missing slots are dropped (sentence-aware).
function renderTemplatePrompt(templateId, slots = {}) {
  const t = TEMPLATE_REGISTRY[templateId];
  if (!t) return null;
  const ctx = {
    ...slots,
    country_pill: slots.country_pill || '',
    country_pill_color: slots.country_pill_color || slots.accent_color || '#ff7a1a',
    icon: slots.icon || 'tooth',
    block_color: slots.block_color || '#1c3a52',
    accent_color: slots.accent_color || '#00a69c',
    mood: slots.mood || 'calm, authoritative',
    title: slots.title || '',
    subtitle: slots.subtitle || '',
    deadline_pill: slots.deadline_pill || '',
    date_pill: slots.date_pill || '',
  };
  return t.render_scaffold.replace(/\{(\w+)\}/g, (_, k) => String(ctx[k] != null ? ctx[k] : ''));
}

// ── Model registry ────────────────────────────────────────────────────
// Each entry: {
//   label, provider, envKey, costEst (USD per render),
//   sizeMap: {dim → api-size}, notes (shown in UI)
// }

const MODEL_REGISTRY = {
  // M59 · OpenAI's current flagship (released 2026-04-21). #1 on Image
  // Arena, state-of-the-art multilingual text rendering (Persian/Arabic),
  // accepts reference images for style conditioning, supports a Thinking
  // mode that produces N consistent panels in one call (carousel mode).
  'gpt-image-2': {
    label: 'GPT Image 2 (flagship)',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    costEst: 0.19,                         // high-quality default
    apiModelId: 'gpt-image-2',             // sent to /v1/images/generations
    qualityDefault: 'high',
    supportsReferenceImages: true,
    supportsThinkingMode: true,            // multi-panel consistent generation
    sizeMap: {
      '1080x1080': '1024x1024',
      '1280x720':  '1536x1024',
      '1920x600':  '1536x1024',            // closest valid; provider will downscale
      '600x200':   '1024x1024',
    },
    notes: 'OpenAI flagship (2026). Best multilingual typography. Accepts reference images. Use for IG slides, posters, covers.',
  },
  'gpt-image-1': {
    label: 'GPT Image 1',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    costEst: 0.05,
    apiModelId: 'gpt-image-1',
    sizeMap: {
      '1080x1080': '1024x1024',
      '1280x720':  '1536x1024',
      '1920x600':  '1536x1024',
      '600x200':   '1024x1024',
    },
    notes: 'OpenAI prior-gen image model. Kept for fallback / cost control.',
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

// pg-backed DB client (cloud build).
const { query, queryValue, queryReturning, q: _q } = require('./db');

// Cache image_model_defaults so getModelDefaults stays sync (called on
// every render path). Refreshed on each setModelDefault.
let _imgDefaultsCache = null;
async function _refreshImgDefaults() {
  try {
    const raw = await queryValue(`SELECT image_model_defaults FROM dashboard_settings WHERE id = 1;`);
    _imgDefaultsCache = raw ? JSON.parse(raw) : {};
  } catch (_) {
    _imgDefaultsCache = _imgDefaultsCache || {};
  }
}

// ── Per-kind model defaults ────────────────────────────────────────────

function getModelDefaults() {
  if (_imgDefaultsCache) return _imgDefaultsCache;
  _refreshImgDefaults().catch(() => {});
  return _imgDefaultsCache || {};
}

async function setModelDefault(kind, modelKey) {
  if (!KIND_SPECS[kind]) return { ok: false, error: `unknown kind: ${kind}` };
  if (modelKey && !MODEL_REGISTRY[modelKey]) return { ok: false, error: `unknown model: ${modelKey}` };
  try {
    const current = getModelDefaults();
    if (modelKey) current[kind] = modelKey;
    else delete current[kind];
    await query(`UPDATE dashboard_settings
                    SET image_model_defaults = ${_q(JSON.stringify(current))}::jsonb, updated_at = NOW()
                  WHERE id = 1;`);
    await _refreshImgDefaults();
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
  if (!(await cost.canSpend(0.01))) return { ok: false, error: 'monthly cap reached', cost: await cost.snapshot() };

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
  // Cloud build: SVG drafts go to object storage. The DB column stores the
  // storage key (not a fs path); the dashboard uses storage.urlFor() to
  // resolve it to a fetchable URL (R2 CDN if R2_PUBLIC_URL set, /storage
  // proxy otherwise).
  const draftKey = storage.KEYS.DRAFT(id);
  await storage.put({ key: draftKey, body: Buffer.from(svg, 'utf-8'), contentType: 'image/svg+xml' });
  const draftRel = draftKey;

  const sql = `
    INSERT INTO media_library (id, kind, topic, language, prompt, draft_path, dimensions, draft_cost_usd, metadata)
    VALUES (${_q(id)}, ${_q(kind)}, ${_q(topic)}, ${_q(language || 'en')}, ${_q(prompt)},
            ${_q(draftRel)}, ${_q(KIND_SPECS[kind].dim)}, ${draftCost.toFixed(6)},
            ${_q(JSON.stringify({ model: draftModel, input_tokens: inputTokens, output_tokens: outputTokens }))}::jsonb);
  `;
  try { await query(sql); }
  catch (e) { return { ok: false, error: 'DB insert failed: ' + e.message.slice(0, 200), id, draftRel }; }

  // K2 · Episodic memory of this draft. Tags include the kind so Afshin
  // can prefer past examples of the same kind on next call.
  try {
    await agentMemory.write({
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

async function _renderOpenAI(row, modelKey, model, apiKey, prompt, opts = {}) {
  const size = model.sizeMap[row.dimensions] || '1024x1024';
  const apiModelId = model.apiModelId || (modelKey === 'dall-e-3' ? 'dall-e-3' : modelKey);
  const isGptImage = apiModelId === 'gpt-image-1' || apiModelId === 'gpt-image-2';

  const body = {
    model: apiModelId,
    prompt,
    n: 1,
    size,
  };
  // gpt-image-2 supports quality tiers (low|medium|high|auto). Default 'high'
  // for the flagship — your brand demands it; cost is irrelevant per founder.
  if (apiModelId === 'gpt-image-2') {
    body.quality = opts.quality || model.qualityDefault || 'high';
    // M63 · Thinking mode for multi-slide consistency (carousel renders).
    // When the orchestrator passes panels:N, the model produces N visually
    // consistent panels in one call (same palette, fonts, characters).
    if (opts.panels && opts.panels > 1) body.partial_images = opts.panels;
  }
  if (apiModelId === 'dall-e-3') body.response_format = 'url';  // dall-e-3 returns URL by default

  // M62 · Reference-image conditioning — when the orchestrator hands us
  // top-ranked brand exemplars, switch to the /edits endpoint so the model
  // sees "look like this" rather than generating from prompt alone.
  // Only gpt-image-2 supports high-fidelity image input on /edits cleanly.
  const refs = Array.isArray(opts.referenceImages) ? opts.referenceImages.filter(Boolean) : [];
  const useEdits = apiModelId === 'gpt-image-2' && refs.length > 0;

  let r;
  if (useEdits) {
    if (typeof FormData === 'undefined') {
      return { ok: false, error: 'OpenAI edits endpoint requires Node 18+ (FormData missing)' };
    }
    const fd = new FormData();
    fd.append('model', apiModelId);
    fd.append('prompt', prompt);
    fd.append('size', size);
    fd.append('n', '1');
    fd.append('quality', body.quality);
    // Attach up to 3 reference images (as Blobs) — gpt-image-2 supports
    // multiple via repeated 'image[]' fields per the 2026 docs.
    for (let i = 0; i < Math.min(refs.length, 3); i++) {
      const ref = refs[i];
      if (!ref || !ref.buffer || !ref.contentType) continue;
      const blob = new Blob([ref.buffer], { type: ref.contentType });
      fd.append('image[]', blob, ref.filename || `ref_${i}.png`);
    }
    r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      body: fd,
    });
  } else {
    r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (!r.ok) return { ok: false, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const j = await r.json();
  // gpt-image-2 thinking mode returns multiple panels in j.data[]
  if (opts.panels && opts.panels > 1 && Array.isArray(j.data) && j.data.length > 1) {
    return { ok: true, panels: j.data.map(d => ({ b64: d.b64_json || null, url: d.url || null })) };
  }
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

// ── M62 · Brand reference-image loader ───────────────────────────────
// Pulls top-K visual references from brand_exemplars (already populated
// from the analyzer's 75 visual references upload) ranked by topic-tag
// overlap × importance, fetches them as buffers, and returns them in
// the shape _renderOpenAI's `referenceImages` opt expects.
async function _loadReferenceImages({ topicTags = [], platform = null, language = null, max = 3 } = {}) {
  try {
    const { queryRows } = require('./db');
    const conds = ["enabled = TRUE", "kind = 'design_brief'"];
    if (platform) conds.push(`(platform = '${platform.replace(/'/g, "''")}' OR platform IS NULL)`);
    if (language) conds.push(`(language = '${language.replace(/'/g, "''")}' OR language IS NULL)`);
    const rows = await queryRows(`
      SELECT id::text, body, topic_tags, importance, outcome
        FROM brand_exemplars WHERE ${conds.join(' AND ')}
       ORDER BY importance DESC, updated_at DESC LIMIT 50;`);
    if (!rows || rows.length === 0) return [];

    // Score: importance + topic overlap + winner bonus
    const tags = Array.isArray(topicTags) ? topicTags.map(t => String(t).toLowerCase()) : [];
    const scored = rows.map(r => {
      const rTags = Array.isArray(r.topic_tags) ? r.topic_tags.map(t => String(t).toLowerCase()) : [];
      const overlap = rTags.filter(t => tags.includes(t)).length;
      const winnerBonus = r.outcome === 'top_engagement' ? 0.5 : 0;
      return { ...r, _score: (Number(r.importance) || 3) + overlap * 1.5 + winnerBonus };
    }).sort((a, b) => b._score - a._score).slice(0, max);

    // Each exemplar's body has a "URL: <url>" line — extract and fetch.
    const out = [];
    for (const ex of scored) {
      const m = String(ex.body || '').match(/URL:\s*(\S+)/);
      if (!m) continue;
      let url = m[1];
      // Resolve relative storage paths to absolute if needed
      if (url.startsWith('/storage/')) {
        const base = process.env.PUBLIC_BASE_URL || '';
        if (base) url = base.replace(/\/+$/, '') + url;
      }
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await r.arrayBuffer());
        if (buffer.length < 200 || buffer.length > 20 * 1024 * 1024) continue;
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        out.push({ buffer, contentType: ct, filename: `ref_${ex.id.slice(0, 8)}.${ext}` });
      } catch (_) { /* skip this ref, keep going */ }
    }
    return out;
  } catch (_) { return []; }
}

// ── Render: dispatcher ────────────────────────────────────────────────

async function generateRender({ mediaId, prompt, modelKey, referenceImages = null, panels = null, quality = null, topicTags = null }) {
  // Fetch the DB row first to get kind + approval status.
  const rowSql = `SELECT row_to_json(r) FROM (SELECT id::text, kind, topic, language, draft_path, approved, dimensions FROM media_library WHERE id = ${_q(mediaId)}) r;`;
  let row;
  try { row = JSON.parse(await queryValue(rowSql)); } catch (e) { return { ok: false, error: 'media not found' }; }
  if (!row) return { ok: false, error: 'media not found' };
  if (!row.approved) return { ok: false, error: 'draft must be approved before render' };

  // Resolve model: explicit arg → per-kind default → text-heavy fallback (gpt-image-2)
  // M59 · Text-heavy kinds default to gpt-image-2 (the 2026 flagship —
  // best multilingual typography). Older fallback chain stays in place.
  const defaults = getModelDefaults();
  const TEXT_HEAVY_KINDS = new Set(['ig_carousel_slide', 'telegram_cover', 'youtube_thumb', 'web_banner', 'email_header_ravi']);
  const fallback = TEXT_HEAVY_KINDS.has(row.kind) ? 'gpt-image-2' : 'gpt-image-1';
  const resolvedKey = modelKey || defaults[row.kind] || fallback;
  const model = MODEL_REGISTRY[resolvedKey];
  if (!model) return { ok: false, error: `unknown model key: ${resolvedKey}` };

  const apiKey = process.env[model.envKey];
  if (!apiKey) return { ok: false, error: `${model.envKey} not set — add to .env and restart proxy`, model_needed: model.envKey };

  if (!(await cost.canSpend(model.costEst))) return { ok: false, error: 'monthly cap reached', cost: await cost.snapshot() };

  const renderPrompt = prompt || buildRenderPrompt(row);

  // M62 · Auto-load brand reference images if caller didn't pass any AND
  // the model supports them. Topic tags default to keywords from the
  // media row's topic if not provided. Falls through silently on failure.
  let resolvedRefs = Array.isArray(referenceImages) ? referenceImages : [];
  if (resolvedRefs.length === 0 && model.supportsReferenceImages) {
    try {
      const tags = Array.isArray(topicTags) && topicTags.length
        ? topicTags
        : String(row.topic || '').split(/\s+/).filter(w => w.length >= 4).slice(0, 5).map(s => s.toLowerCase());
      resolvedRefs = await _loadReferenceImages({
        topicTags: tags, language: row.language || null, max: 3,
      });
    } catch (_) { /* non-fatal */ }
  }

  // Dispatch to provider
  let result;
  try {
    switch (model.provider) {
      case 'openai':
      case 'openai_dalle3':
        result = await _renderOpenAI(row, resolvedKey, model, apiKey, renderPrompt, {
          referenceImages: resolvedRefs, panels, quality,
        });
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

  // Save the rendered image to object storage. The provider may give us
  // a buffer, a base64 string, or a URL we need to fetch ourselves.
  let buf;
  if (result.buffer) {
    buf = result.buffer;
  } else if (result.b64) {
    buf = Buffer.from(result.b64, 'base64');
  } else if (result.url) {
    const ir = await fetch(result.url);
    buf = Buffer.from(await ir.arrayBuffer());
  } else {
    return { ok: false, error: 'provider returned no image data' };
  }
  const renderKey = storage.KEYS.RENDER(mediaId);
  await storage.put({ key: renderKey, body: buf, contentType: 'image/png' });
  const renderRel = renderKey;
  const renderCost = model.costEst;

  const sql = `
    UPDATE media_library
    SET render_path = ${_q(renderRel)}, render_cost_usd = ${renderCost},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${_q(JSON.stringify({ render_model: resolvedKey }))}::jsonb
    WHERE id = ${_q(mediaId)};
  `;
  try { await query(sql); }
  catch (e) { return { ok: false, error: 'DB update failed: ' + e.message.slice(0, 200), render_path: renderRel }; }

  return { ok: true, id: mediaId, render_path: renderRel, render_cost_usd: renderCost,
           model: resolvedKey, model_label: model.label };
}

// ── Gallery ──────────────────────────────────────────────────────────

async function gallery({ kind = null, approved = null, limit = 50 } = {}) {
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
  try {
    const rows = JSON.parse(await queryValue(sql));
    // Resolve storage keys to URLs the dashboard can fetch directly. For
    // legacy on-disk paths (`assets/generated/...`) we leave them alone —
    // express.static still serves them. For storage keys (`media/...`)
    // we hand back the URL the storage backend exposes.
    return rows.map(r => ({
      ...r,
      draft_url:  r.draft_path  ? _resolveAssetUrl(r.draft_path)  : null,
      render_url: r.render_path ? _resolveAssetUrl(r.render_path) : null,
    }));
  } catch (_) { return []; }
}

// Decide if a stored path is a legacy on-disk asset (starts with
// "assets/generated/") or a new storage key. Legacy assets are served
// by express.static at the same path; new keys go through storage.urlFor().
function _resolveAssetUrl(p) {
  if (!p) return null;
  if (p.startsWith('http://') || p.startsWith('https://')) return p;
  if (p.startsWith('assets/generated/')) return '/' + p;
  return storage.urlFor(p);
}

async function approve(mediaId, approved = true) {
  const sql = `
    UPDATE media_library SET approved = ${approved ? 'TRUE' : 'FALSE'},
                              approved_at = ${approved ? 'NOW()' : 'NULL'}
    WHERE id = ${_q(mediaId)} RETURNING id::text;
  `;
  try { return { ok: true, id: await queryReturning(sql) }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

async function archive(mediaId) {
  try { await query(`UPDATE media_library SET archived = true WHERE id = ${_q(mediaId)};`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

module.exports = {
  generateDraft, generateRender, gallery, approve, archive,
  listModels, getKindDefaults, setModelDefault, getModelDefaults,
  KIND_SPECS, MODEL_REGISTRY,
  // M61 · template registry
  TEMPLATE_REGISTRY, getTemplate, listTemplates, renderTemplatePrompt,
  // M62 · expose reference loader for orchestrator + tests
  _loadReferenceImages,
  hasOpenAI: () => !!process.env.OPENAI_API_KEY,
  hasAnthropic: () => !!process.env.ANTHROPIC_API_KEY,
  ASSETS_ROOT,
};
