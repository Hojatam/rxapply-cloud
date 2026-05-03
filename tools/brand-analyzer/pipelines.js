// tools/brand-analyzer/pipelines.js
// =====================================================================
// Multi-modal analysis pipelines. All called from analyze.js.
// Every LLM call is cached on disk (output/.cache/<sha>.json) so a
// resumed run skips redundant calls.
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

let _anthropic, _openai;
function _getAnthropic() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}
function _getOpenAI() {
  if (!_openai) {
    const OpenAI = require('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// ── Cache helpers ────────────────────────────────────────────────────
function _cacheKey(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p));
  return h.digest('hex').slice(0, 24);
}
function _cacheGet(dir, key) {
  const p = path.join(dir, '.cache', `${key}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function _cacheSet(dir, key, value) {
  const cdir = path.join(dir, '.cache');
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, `${key}.json`), JSON.stringify(value));
}
function _stripJsonFences(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    const lines = s.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    s = lines.join('\n');
  }
  if (!s.startsWith('{') && !s.startsWith('[')) {
    const i = Math.min(...['{','['].map(c => { const k = s.indexOf(c); return k < 0 ? Infinity : k; }));
    if (i !== Infinity) s = s.slice(i);
  }
  return s;
}

// ── Engagement-weighted ranking ──────────────────────────────────────
//
// Score = log(1 + likes + 4*comments + 8*saves + 0.5*reach) when we have IG
// metrics, log(1 + views) for Telegram, recency-only otherwise. We log-scale
// because raw counts have power-law distributions.
function rankPostsByEngagement(posts) {
  return posts.map(p => {
    const e = p.engagement || {};
    let score = 0;
    if (typeof e.saved === 'number' || typeof e.likes === 'number') {
      const sat = (e.saved || 0) * 8 + (e.comments || 0) * 4 + (e.likes || 0) + (e.reach || 0) * 0.5 + (e.impressions || 0) * 0.2;
      score = Math.log1p(sat);
    } else if (typeof e.views === 'number') {
      score = Math.log1p(e.views);
    } else {
      score = 0;  // no metrics → ranked by recency below
    }
    return { ...p, _engagement_score: score };
  }).sort((a, b) => {
    if (b._engagement_score !== a._engagement_score) return b._engagement_score - a._engagement_score;
    // Tie-break: most recent first
    return new Date(b.post_date || 0).getTime() - new Date(a.post_date || 0).getTime();
  });
}

function pickLastN(posts, n = 30) {
  return posts.slice().sort((a, b) =>
    new Date(b.post_date || 0).getTime() - new Date(a.post_date || 0).getTime()
  ).slice(0, n);
}

// ── Text pattern analysis ────────────────────────────────────────────
// Calls Claude Opus 4.7 with a batch of captions, returns structured patterns.

const TEXT_ANALYZER_SYSTEM = `You are a brand-voice analyst. You receive a batch of captions from
ONE platform in ONE language. Extract STRUCTURED voice patterns. Be precise; cite frequencies; do
NOT invent patterns that aren't actually present.

OUTPUT FORMAT — return ONLY this JSON:

{
  "platform": "<echoed>",
  "language": "<echoed>",
  "n_samples": <number>,
  "openers": {
    "templates": [
      { "shape": "<like 'Question + you-pronoun', 'Did you know X?', 'Today we...'>",
        "example": "<one short sample>", "frequency": <int> }
    ]
  },
  "body_shapes": [
    { "shape": "<problem→solution | question→answer | list | story arc | data+insight | testimonial | …>",
      "frequency": <int> }
  ],
  "ctas": {
    "templates": [
      { "form": "<like 'soft question', 'imperative', 'DM me', 'save this'>",
        "example": "<one short sample>", "frequency": <int> }
    ],
    "always_present": <bool>
  },
  "length_stats": {
    "word_count": { "mean": <num>, "p25": <num>, "p75": <num>, "p95": <num> },
    "line_breaks_per_100w": <num>
  },
  "emoji": {
    "density_per_100w": <num>,
    "favorites": ["<top emoji>", "<...up to 15>"]
  },
  "hashtags": {
    "count_distribution": { "mean": <num>, "p25": <num>, "p75": <num> },
    "language_mix_pct": { "fa": <num>, "en": <num>, "ar": <num>, "other": <num> },
    "favorites": ["#<top tag>", "<...up to 20>"]
  },
  "punctuation_tics": ["<like 'em-dash often', 'ellipses for trailing thought', 'short sentences for emphasis'>"],
  "favored_phrases": ["<phrase recurring 3+ times>"],
  "voice_signature_words": ["<n-grams that strongly identify this brand vs. generic content>"],
  "banned_or_avoided": ["<tones/phrases the brand never uses based on what's MISSING from samples>"]
}`;

async function analyzeTextPatterns({ posts, platform, language, model, outDir }) {
  // Cap input for context window — sample up to 80 captions per (platform, lang)
  const sampled = posts.slice(0, 80);
  if (sampled.length === 0) return null;

  const cacheKey = _cacheKey(['text-pattern', platform, language, model, sampled.map(p => p.id)]);
  const hit = _cacheGet(outDir, cacheKey);
  if (hit) return hit;

  const captions = sampled.map((p, i) => `[${i + 1}] ${p.caption.slice(0, 1500)}`).join('\n\n---\n\n');
  const userPrompt = `Platform: ${platform}\nLanguage: ${language}\nSamples: ${sampled.length}\n\n${captions}\n\nReturn the JSON now.`;

  const client = _getAnthropic();
  const r = await client.messages.create({
    model,
    max_tokens: 3500,
    system: TEXT_ANALYZER_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const parsed = JSON.parse(_stripJsonFences(text));
  _cacheSet(outDir, cacheKey, parsed);
  return parsed;
}

// ── Vision analysis (per image) ──────────────────────────────────────
// Sends one image + a tight prompt, gets back structured art-direction JSON.

const VISION_ANALYZER_SYSTEM = `You are a brand-visual analyst. You receive one image. Describe it
in art-direction terms. Be concrete; reference what is actually visible.

OUTPUT FORMAT — return ONLY this JSON:

{
  "style": "<illustration | photoreal | minimal-vector | mixed-media | data-viz | quote-card | poster | meme>",
  "layout": "<hero | carousel-slide | grid | split | list | stack | quote | infographic>",
  "subject": "<short — people | places | object | abstract | data | scene>",
  "dominant_colors": ["<#rrggbb>", "<...up to 4>"],
  "accent_colors": ["<#rrggbb>", "<...up to 2>"],
  "typography": {
    "present": <bool>,
    "weight": "<heavy | medium | light | mixed>",
    "size_relative_to_canvas": "<tiny | small | medium | large | hero>",
    "position": "<top | center | bottom | left | right | overlaid | split>"
  },
  "logo": {
    "present": <bool>,
    "position": "<TL | TR | BL | BR | center | none>",
    "size_pct": <num>,
    "opacity": "<solid | semi | watermark | none>"
  },
  "brand_pattern_motifs": ["<recurring graphic element observed: lines, frame, geometric shapes, etc.>"],
  "mood": "<one or two adjectives>"
}`;

async function analyzeImageOne({ imagePath, model, outDir }) {
  if (!fs.existsSync(imagePath)) return null;
  const buf = fs.readFileSync(imagePath);
  // Keep cache key bound to file SHA so re-runs reuse results.
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const cacheKey = _cacheKey(['vision', sha, model]);
  const hit = _cacheGet(outDir, cacheKey);
  if (hit) return hit;

  // Limit size for the LLM. Resize done lazily via base64 (we trust the model
  // to accept reasonable sizes). For very large images you can pre-shrink
  // with sharp; we keep zero compile-time deps.
  const ext = (path.extname(imagePath).slice(1) || 'jpeg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const b64 = buf.toString('base64');

  const client = _getAnthropic();
  let parsed;
  try {
    const r = await client.messages.create({
      model,
      max_tokens: 1200,
      system: VISION_ANALYZER_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: 'Analyze this brand image. Return the JSON.' },
        ],
      }],
    });
    const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    parsed = JSON.parse(_stripJsonFences(text));
  } catch (e) {
    parsed = { error: e.message.slice(0, 300) };
  }
  _cacheSet(outDir, cacheKey, parsed);
  return parsed;
}

// ── Aggregate visual style profile ───────────────────────────────────
function aggregateVisualProfile(visionResults) {
  const valid = visionResults.filter(v => v && !v.error);
  if (valid.length === 0) return { error: 'no successful vision analyses' };

  // Histogram of colors (4-bit quantized) so we can find brand palette.
  const colorBucket = {};
  function bumpColor(hex, weight) {
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) return;
    const c = hex.replace('#', '').toLowerCase();
    const r = Math.round(parseInt(c.slice(0, 2), 16) / 16) * 16;
    const g = Math.round(parseInt(c.slice(2, 4), 16) / 16) * 16;
    const b = Math.round(parseInt(c.slice(4, 6), 16) / 16) * 16;
    const key = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    colorBucket[key] = (colorBucket[key] || 0) + (weight || 1);
  }
  function tally(arr) {
    const out = {};
    for (const x of arr) if (x) out[x] = (out[x] || 0) + 1;
    return out;
  }

  for (const v of valid) {
    (v.dominant_colors || []).forEach(c => bumpColor(c, 2));
    (v.accent_colors   || []).forEach(c => bumpColor(c, 1));
  }
  const palette = Object.entries(colorBucket)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([color, count]) => ({ color, weight: count }));

  return {
    n_images: valid.length,
    n_failures: visionResults.length - valid.length,
    palette,
    style_distribution: tally(valid.map(v => v.style)),
    layout_distribution: tally(valid.map(v => v.layout)),
    typography_present_pct: Math.round(100 * valid.filter(v => v.typography && v.typography.present).length / valid.length),
    logo_position_distribution: tally(valid.map(v => v.logo && v.logo.position)),
    logo_present_pct: Math.round(100 * valid.filter(v => v.logo && v.logo.present).length / valid.length),
    motif_frequency: (function () {
      const all = [];
      for (const v of valid) for (const m of (v.brand_pattern_motifs || [])) all.push(String(m).toLowerCase());
      return tally(all);
    })(),
  };
}

// ── Voice fingerprint embeddings ─────────────────────────────────────
async function embedTexts(texts, model = 'text-embedding-3-large') {
  const client = _getOpenAI();
  // Batch up to 100 inputs per call.
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100).map(t => String(t).slice(0, 8000));
    const r = await client.embeddings.create({ model, input: batch });
    for (const item of (r.data || [])) out.push(item.embedding);
  }
  return out;
}

// Compute centroid + score each text by cosine similarity to centroid.
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
function _centroid(vectors) {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const c = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) c[i] += v[i];
  for (let i = 0; i < dim; i++) c[i] /= vectors.length;
  return c;
}
async function buildVoiceFingerprint({ posts, perPlatform = 30, total = 60, outDir, embedModel = 'text-embedding-3-large' }) {
  // Last-N per (platform, language) — these match the user's "current desired tone".
  const recentByGroup = {};
  for (const p of posts) {
    if (!p.caption || p.caption.length < 30) continue;     // skip tiny captions
    const k = `${p.platform}:${p.language}`;
    if (!recentByGroup[k]) recentByGroup[k] = [];
    recentByGroup[k].push(p);
  }
  const recents = [];
  for (const [, arr] of Object.entries(recentByGroup)) {
    arr.sort((a, b) => new Date(b.post_date || 0) - new Date(a.post_date || 0));
    recents.push(...arr.slice(0, perPlatform));
  }

  const captions = recents.map(p => p.caption);
  if (captions.length === 0) return { vectors: [], centroid: [], cluster: [] };

  const cacheKey = _cacheKey(['embed', embedModel, captions]);
  const hit = _cacheGet(outDir, cacheKey);
  let vectors;
  if (hit) {
    vectors = hit;
  } else {
    vectors = await embedTexts(captions, embedModel);
    _cacheSet(outDir, cacheKey, vectors);
  }

  const centroid = _centroid(vectors);
  // Pick the `total` closest to centroid as the canonical voice cluster.
  const scored = recents.map((p, i) => ({ post: p, vector: vectors[i], score: _cosine(vectors[i], centroid) }));
  scored.sort((a, b) => b.score - a.score);
  const cluster = scored.slice(0, total).map(s => ({
    id: s.post.id,
    platform: s.post.platform,
    language: s.post.language,
    caption: s.post.caption,
    similarity_to_centroid: Number(s.score.toFixed(4)),
    post_date: s.post.post_date,
  }));
  return {
    embed_model: embedModel,
    n_inputs: captions.length,
    centroid_dim: centroid.length,
    cluster,
    centroid,         // float[]; the brand-voice center
  };
}

module.exports = {
  rankPostsByEngagement,
  pickLastN,
  analyzeTextPatterns,
  analyzeImageOne,
  aggregateVisualProfile,
  buildVoiceFingerprint,
  embedTexts,
};
