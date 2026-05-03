#!/usr/bin/env node
// tools/brand-analyzer/vision-fallback.js
// =====================================================================
// OPTIONAL · Vision analysis using OpenAI gpt-4o-mini (cheap).
//
// Cowork (Claude Desktop) doesn't currently view images. To get
// layout / logo-placement / motif analysis, run this script ONCE.
// Cost: ~$0.001 per image · 200 images = ~$0.20 total.
//
// Output: visual_style_samples.json (raw per-image data)
// Cowork's INSTRUCTIONS.md picks this up and aggregates it into the
// final visual_style_profile.json.
//
// Run AFTER parse-archive.js, BEFORE / DURING Cowork analysis.
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tiny .env loader
(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || process.env[m[1]] != null) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    }
  }
  return args;
}

const HELP = `
Usage: node vision-fallback.js [flags]

  --output <folder>      Output folder (default: ./output)
  --max-images <N>       Cap images to analyze (default: 200, ~\$0.20 total)
  --model <id>           OpenAI vision model (default: gpt-4o-mini)
  --help                 Show this help

Reads images from output/archive-input-images/ and writes
output/visual_style_samples.json. Resumable via on-disk cache.

Set OPENAI_API_KEY in .env first.
`.trim();

const VISION_PROMPT = `You are a brand-visual analyst. Describe this image in art-direction terms.

Return ONLY this JSON (no prose):

{
  "style": "illustration | photoreal | minimal-vector | mixed-media | data-viz | quote-card | poster | meme",
  "layout": "hero | carousel-slide | grid | split | list | stack | quote | infographic",
  "subject": "<short — people | places | object | abstract | data | scene>",
  "dominant_colors": ["#rrggbb", "<...up to 4>"],
  "accent_colors": ["#rrggbb", "<...up to 2>"],
  "typography": {
    "present": true,
    "weight": "heavy | medium | light | mixed",
    "size_relative_to_canvas": "tiny | small | medium | large | hero",
    "position": "top | center | bottom | left | right | overlaid | split"
  },
  "logo": {
    "present": true,
    "position": "TL | TR | BL | BR | center | none",
    "size_pct": 8,
    "opacity": "solid | semi | watermark | none"
  },
  "brand_pattern_motifs": ["<recurring graphic element>"],
  "mood": "<one or two adjectives>"
}

Be concrete. Reference what's actually visible. If logo is absent, say so.`;

function _cacheKey(imagePath, model) {
  const buf = fs.readFileSync(imagePath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return `${sha}-${model}`;
}

function _stripJsonFences(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    const lines = s.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    s = lines.join('\n');
  }
  if (!s.startsWith('{')) {
    const i = s.indexOf('{');
    if (i >= 0) s = s.slice(i);
  }
  return s;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('ERROR: OPENAI_API_KEY not set in .env'); process.exit(1); }

  const outDir = path.resolve(args.output || './output');
  const imagesDir = path.join(outDir, 'archive-input-images');
  if (!fs.existsSync(imagesDir)) {
    console.error(`ERROR: ${imagesDir} not found. Run parse-archive.js first.`);
    process.exit(1);
  }

  const cacheDir = path.join(outDir, '.cache-vision');
  fs.mkdirSync(cacheDir, { recursive: true });

  const model = args.model || 'gpt-4o-mini';
  const max   = parseInt(args['max-images'] || 200, 10);
  const files = fs.readdirSync(imagesDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).slice(0, max);
  console.log(`Analyzing ${files.length} images with ${model} (~\$${(files.length * 0.001).toFixed(2)} total)...`);

  // Load images_manifest if it exists, to map filename → post metadata
  let manifest = [];
  const inputPath = path.join(outDir, 'archive-input.json');
  if (fs.existsSync(inputPath)) {
    try { manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8')).images_manifest || []; }
    catch (_) {}
  }

  const samples = [];
  let i = 0;
  for (const f of files) {
    i++;
    const imagePath = path.join(imagesDir, f);
    const cacheKey = _cacheKey(imagePath, model);
    const cachePath = path.join(cacheDir, `${cacheKey}.json`);

    // Cached?
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      samples.push(cached);
      process.stdout.write(`  [${i}/${files.length}] ${f} (cached)\n`);
      continue;
    }

    process.stdout.write(`  [${i}/${files.length}] ${f} ... `);

    const buf = fs.readFileSync(imagePath);
    const ext = (path.extname(f).slice(1) || 'jpeg').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

    let parsed;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        console.log(`ERR ${r.status}: ${t.slice(0, 100)}`);
        continue;
      }
      const j = await r.json();
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      parsed = JSON.parse(_stripJsonFences(text));
    } catch (e) {
      console.log(`ERR: ${e.message.slice(0, 100)}`);
      continue;
    }

    const meta = manifest.find(m => m.file === f) || {};
    const sample = { file: f, ...parsed, post_id: meta.post_id || null, platform: meta.platform || null, language: meta.language || null };
    fs.writeFileSync(cachePath, JSON.stringify(sample));
    samples.push(sample);
    console.log('ok');
  }

  // Write the samples; Cowork will aggregate into visual_style_profile.json
  const outPath = path.join(outDir, 'visual_style_samples.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    method: `${model} via OpenAI Vision`,
    n_samples: samples.length,
    samples,
  }, null, 2));
  console.log(`\n✓ wrote ${outPath}`);
  console.log(`  Cowork's INSTRUCTIONS.md will read this and produce visual_style_profile.json.`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
