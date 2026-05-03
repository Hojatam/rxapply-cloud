#!/usr/bin/env node
// tools/brand-analyzer/parse-archive.js
// =====================================================================
// Pure-parsing pre-pass for the Claude-Code-driven workflow.
// =====================================================================
//
// Reads Telegram + Instagram archives, normalises into one JSON file
// (`archive-input.json`) and copies all images into one flat folder
// (`archive-input-images/`) with predictable names.
//
// NO LLM CALLS. No API costs. Pure JavaScript.
//
// Then you open Claude Code in this folder and tell it:
//   "Run the brand analysis using INSTRUCTIONS.md"
// — Claude reads archive-input.json, looks at images directly, writes
// the 5 output JSONs. Your Max-plan subscription, zero API cost.
// =====================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const parsers = require('./parsers');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}

const HELP = `
Usage: node parse-archive.js [flags]

  --telegram <folder>            Telegram channel export folder (with result.json + photos/)
  --instagram <zip-or-folder>    Instagram archive (.zip or extracted folder)
  --instagram-csv <path>         Optional: Meta Business Suite CSV with engagement
  --output <folder>              Output folder (default: ./output)
  --max-images <N>               Cap how many images to copy (default: 200; the most-engaged + last-N are prioritised)
  --help                         Show this help

Run this BEFORE opening Claude Code. Then in Claude Code: "Run the brand analysis using INSTRUCTIONS.md".
`.trim();

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const outDir = path.resolve(args.output || './output');
  const imagesOutDir = path.join(outDir, 'archive-input-images');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(imagesOutDir, { recursive: true });

  const allPosts = [];

  // ── Ingest ──────────────────────────────────────────────────────
  if (args.telegram) {
    process.stdout.write(`[1/3] Parsing Telegram from ${args.telegram} ... `);
    const tg = parsers.parseTelegramExport(args.telegram);
    console.log(`${tg.length} posts`);
    allPosts.push(...tg);
  }

  if (args.instagram) {
    process.stdout.write(`[1/3] Parsing Instagram from ${args.instagram} ... `);
    let ig = await parsers.parseInstagramArchive(args.instagram);
    console.log(`${ig.length} posts`);
    if (args['instagram-csv']) {
      ig = parsers.mergeEngagementCsv(ig, args['instagram-csv']);
      console.log(`      merged engagement CSV`);
    }
    allPosts.push(...ig);
  }

  if (allPosts.length === 0) {
    console.error('No posts ingested. Pass --telegram and/or --instagram.\n' + HELP);
    process.exit(1);
  }

  // Group counts
  const byPlatformLang = {};
  for (const p of allPosts) {
    const k = `${p.platform}:${p.language}`;
    byPlatformLang[k] = (byPlatformLang[k] || 0) + 1;
  }
  console.log(`[ok] ${allPosts.length} posts:`,
    Object.entries(byPlatformLang).map(([k, n]) => `${k}=${n}`).join(' · '));

  // ── Engagement-rank to prioritise images for copying ────────────
  console.log(`\n[2/3] Copying images (capped at ${args['max-images'] || 200}) ...`);
  const ranked = _rankByEngagement(allPosts);
  const cap = parseInt(args['max-images'] || 200, 10);

  // Last-30 per (platform, lang) — these are the "current desired tone" anchors
  const lastByGroup = {};
  for (const p of allPosts) {
    const k = `${p.platform}:${p.language}`;
    if (!lastByGroup[k]) lastByGroup[k] = [];
    lastByGroup[k].push(p);
  }
  const lastIds = new Set();
  for (const arr of Object.values(lastByGroup)) {
    arr.sort((a, b) => new Date(b.post_date || 0) - new Date(a.post_date || 0));
    for (const p of arr.slice(0, 30)) lastIds.add(p.id);
  }

  // Final priority order: last-30 first, then engagement-ranked
  const ordered = [];
  for (const p of allPosts) if (lastIds.has(p.id)) ordered.push(p);
  for (const p of ranked) if (!lastIds.has(p.id)) ordered.push(p);

  const imageManifest = [];
  let copied = 0;
  for (const p of ordered) {
    if (copied >= cap) break;
    for (const src of (p.image_paths || [])) {
      if (copied >= cap) break;
      if (!fs.existsSync(src)) continue;
      const ext = path.extname(src).toLowerCase() || '.jpg';
      const safeId = String(p.id).replace(/[^a-z0-9-]/gi, '_');
      const dst = path.join(imagesOutDir, `${String(copied + 1).padStart(3, '0')}-${safeId}${ext}`);
      try {
        fs.copyFileSync(src, dst);
        imageManifest.push({
          file: path.basename(dst),
          post_id: p.id,
          platform: p.platform,
          language: p.language,
          post_date: p.post_date,
          source_path: src,
        });
        copied++;
      } catch (e) {
        // skip unreadable files
      }
    }
  }
  console.log(`[ok] copied ${copied} images to ${imagesOutDir}`);

  // ── Local palette extraction (free, no LLM) ─────────────────────
  console.log(`\n[3/4] Extracting color palette from copied images (local, no LLM)...`);
  const palette = await _extractPalette(imageManifest.map(m => path.join(imagesOutDir, m.file)).slice(0, 100));
  const paletteOutPath = path.join(outDir, 'palette.json');
  fs.writeFileSync(paletteOutPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    method: 'node-vibrant local extraction',
    n_images: palette.n_images,
    palette: palette.top,
    note: 'This is the dominant color palette extracted locally from the top-N images. Cowork (text-only) reads this directly when building visual_style_profile.json.',
  }, null, 2));
  console.log(`[ok] wrote ${paletteOutPath} (${palette.top.length} colors)`);

  // ── Write archive-input.json ────────────────────────────────────
  console.log(`\n[4/4] Writing archive-input.json ...`);
  const archiveInput = {
    generated_at: new Date().toISOString(),
    counts: {
      total: allPosts.length,
      by_platform_lang: byPlatformLang,
      images_copied: copied,
    },
    posts: allPosts.map(p => ({
      id: p.id,
      platform: p.platform,
      language: p.language,
      post_date: p.post_date,
      caption: p.caption,
      hashtags: p.hashtags,
      engagement: p.engagement || null,
      image_files: (p.image_paths || []).filter(ip => fs.existsSync(ip)).map(ip => {
        // For each post, point to the copied image (if it was within the cap)
        const m = imageManifest.find(img => img.source_path === ip);
        return m ? m.file : null;
      }).filter(Boolean),
    })),
    images_manifest: imageManifest,
  };
  const inputPath = path.join(outDir, 'archive-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(archiveInput, null, 2));
  console.log(`[ok] wrote ${inputPath}`);

  // CSV dump for spot-checking
  const csvPath = path.join(outDir, 'posts.csv');
  fs.writeFileSync(csvPath, _toCsv(allPosts));

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`✓ Archive parsed. Now open Claude Cowork (Claude Desktop) and:`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  1. Open Claude Desktop, switch to the Cowork tab`);
  console.log(`  2. Grant access to this folder: ${path.resolve(outDir, '..')}`);
  console.log(`  3. Tell Cowork: "Run the brand analysis using INSTRUCTIONS.md"`);
  console.log(``);
  console.log(`Cowork will read archive-input.json + posts.csv + palette.json (text only)`);
  console.log(`and write the 4 output JSONs. Cost: zero API tokens — uses your Max plan.`);
  console.log(``);
  console.log(`Optional (for layout/logo/motif analysis, ~$0.20):`);
  console.log(`  node vision-fallback.js`);
}

// ── Palette extraction via node-vibrant ─────────────────────────────
async function _extractPalette(imagePaths) {
  let Vibrant;
  try {
    Vibrant = require('node-vibrant');
  } catch (_) {
    console.log('[warn] node-vibrant not installed — skipping palette extraction. Run npm install.');
    return { n_images: 0, top: [] };
  }
  const bucket = {};
  let processed = 0;
  for (const ip of imagePaths) {
    if (!fs.existsSync(ip)) continue;
    try {
      const palette = await Vibrant.from(ip).getPalette();
      for (const swatch of Object.values(palette)) {
        if (!swatch) continue;
        const hex = swatch.getHex().toLowerCase();
        // Quantize to 4-bit per channel so similar colors merge.
        const r = Math.round(parseInt(hex.slice(1, 3), 16) / 16) * 16;
        const g = Math.round(parseInt(hex.slice(3, 5), 16) / 16) * 16;
        const b = Math.round(parseInt(hex.slice(5, 7), 16) / 16) * 16;
        const key = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
        const weight = swatch.getPopulation();
        bucket[key] = (bucket[key] || 0) + weight;
      }
      processed++;
    } catch (e) {
      // skip unreadable
    }
  }
  const top = Object.entries(bucket)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([color, weight]) => ({ color, weight }));
  return { n_images: processed, top };
}

function _rankByEngagement(posts) {
  return posts.slice().map(p => {
    const e = p.engagement || {};
    let score = 0;
    if (typeof e.saved === 'number' || typeof e.likes === 'number') {
      score = Math.log1p((e.saved || 0) * 8 + (e.comments || 0) * 4 + (e.likes || 0) + (e.reach || 0) * 0.5);
    } else if (typeof e.views === 'number') {
      score = Math.log1p(e.views);
    }
    return { ...p, _s: score };
  }).sort((a, b) => {
    if (b._s !== a._s) return b._s - a._s;
    return new Date(b.post_date || 0) - new Date(a.post_date || 0);
  });
}

function _toCsv(posts) {
  const cols = ['id', 'platform', 'language', 'post_date', 'word_count', 'hashtag_count', 'engagement', 'caption'];
  const rows = [cols.join(',')];
  for (const p of posts) {
    const wc = (p.caption || '').split(/\s+/).filter(Boolean).length;
    const e = p.engagement ? JSON.stringify(p.engagement) : '';
    const cap = (p.caption || '').replace(/"/g, '""').replace(/\r?\n/g, ' ').slice(0, 800);
    rows.push([p.id, p.platform, p.language, p.post_date || '', wc, (p.hashtags || []).length, `"${e.replace(/"/g, '""')}"`, `"${cap}"`].join(','));
  }
  return rows.join('\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
