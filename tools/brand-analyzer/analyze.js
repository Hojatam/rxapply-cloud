#!/usr/bin/env node
// tools/brand-analyzer/analyze.js
// =====================================================================
// Local CLI · Brand Voice Archive analyzer.
// See README.md for full usage. Run with --help for the flag list.
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// Tiny .env loader (no dotenv dep needed).
(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] != null) continue;          // never overwrite existing
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
})();
const parsers   = require('./parsers');
const pipelines = require('./pipelines');

// ── CLI parsing ──────────────────────────────────────────────────────
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
Usage: node analyze.js [flags]

Inputs (at least one required):
  --telegram <folder>           Telegram channel export folder
  --instagram <zip-or-folder>   Instagram archive (.zip or extracted folder)
  --instagram-csv <path>        Optional: Meta Business Suite CSV with engagement
  --ig-fetch                    Use IG Graph API instead of an archive
  --ig-token <token>            IG long-lived access token (with --ig-fetch)
  --ig-account-id <id>          IG Business Account ID (with --ig-fetch)
  --ig-limit <N>                Max posts to fetch via Graph (default 200)

Output:
  --output <folder>             Where to write results (default: ./output)

Models:
  --text-model <id>             Text analyzer (default: claude-opus-4-5-20251020)
  --vision-model <id>           Vision analyzer (default: claude-opus-4-5-20251020)
  --embed-model <id>            Embedding model (default: text-embedding-3-large)

Behavior:
  --max-images <N>              Cap vision analyses (default 200; ~\$0.02/img)
  --exemplars-per-lang <N>      Top N per platform per language (default 30)
  --dry-run                     Parse + summarise only, no LLM calls
  --resume                      Reuse cached LLM results (.cache/)
  --help                        Show this help

Set ANTHROPIC_API_KEY + OPENAI_API_KEY in .env (see .env.example).
`.trim();

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const outDir = path.resolve(args.output || './output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'style_references'), { recursive: true });

  const textModel   = args['text-model']   || 'claude-opus-4-5-20251020';
  const visionModel = args['vision-model'] || 'claude-opus-4-5-20251020';
  const embedModel  = args['embed-model']  || 'text-embedding-3-large';
  const maxImages   = parseInt(args['max-images'] || 200, 10);
  const exemplarsPerLang = parseInt(args['exemplars-per-lang'] || 30, 10);
  const dryRun      = !!args['dry-run'];

  if (!dryRun) {
    if (!process.env.ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set in .env'); process.exit(1); }
    if (!process.env.OPENAI_API_KEY)    { console.error('ERROR: OPENAI_API_KEY not set in .env');    process.exit(1); }
  }

  // ── 1. Ingest ─────────────────────────────────────────────────────
  const allPosts = [];

  if (args.telegram) {
    process.stdout.write(`[1/6] Parsing Telegram export from ${args.telegram} ... `);
    const tg = parsers.parseTelegramExport(args.telegram);
    console.log(`${tg.length} posts`);
    allPosts.push(...tg);
  }

  if (args['ig-fetch']) {
    process.stdout.write(`[1/6] Fetching Instagram via Graph API ... `);
    const ig = await parsers.fetchInstagramViaGraph({
      token: args['ig-token'] || process.env.IG_LONG_LIVED_TOKEN,
      accountId: args['ig-account-id'] || process.env.IG_BUSINESS_ACCOUNT_ID,
      limit: parseInt(args['ig-limit'] || 200, 10),
    });
    console.log(`${ig.length} posts`);
    allPosts.push(...ig);
  } else if (args.instagram) {
    process.stdout.write(`[1/6] Parsing Instagram archive from ${args.instagram} ... `);
    let ig = await parsers.parseInstagramArchive(args.instagram);
    console.log(`${ig.length} posts`);
    if (args['instagram-csv']) {
      const before = ig.filter(p => p.engagement).length;
      ig = parsers.mergeEngagementCsv(ig, args['instagram-csv']);
      const after = ig.filter(p => p.engagement).length;
      console.log(`      merged ${after - before} posts with CSV engagement metrics`);
    }
    allPosts.push(...ig);
  }

  if (allPosts.length === 0) {
    console.error('No posts ingested. Pass --telegram and/or --instagram (or --ig-fetch). See --help.');
    process.exit(1);
  }

  // Group counts
  const byPlatformLang = {};
  for (const p of allPosts) {
    const k = `${p.platform}:${p.language}`;
    byPlatformLang[k] = (byPlatformLang[k] || 0) + 1;
  }
  console.log(`[ok] ingested ${allPosts.length} posts:`,
    Object.entries(byPlatformLang).map(([k, n]) => `${k}=${n}`).join(' · '));

  // Flat CSV dump for spot-checking
  const csvPath = path.join(outDir, 'posts.csv');
  fs.writeFileSync(csvPath, _toCsv(allPosts));
  console.log(`[ok] wrote ${csvPath}`);

  if (dryRun) { console.log('\n[--dry-run] stopped before LLM calls.'); return; }

  // ── 2. Text pattern analysis (per platform per language) ──────────
  console.log(`\n[2/6] Text pattern analysis (model=${textModel})`);
  const patterns = {};
  for (const [k, n] of Object.entries(byPlatformLang)) {
    const [platform, language] = k.split(':');
    const subset = allPosts.filter(p => p.platform === platform && p.language === language);
    process.stdout.write(`      ${k} (${n} posts) ... `);
    const result = await pipelines.analyzeTextPatterns({
      posts: subset, platform, language, model: textModel, outDir,
    });
    patterns[k] = result;
    console.log('ok');
  }
  fs.writeFileSync(path.join(outDir, 'brand_voice_profile.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), n_posts: allPosts.length, patterns }, null, 2));
  console.log(`[ok] wrote brand_voice_profile.json`);

  // ── 3. Pick exemplars (last-N per group + engagement-ranked) ──────
  console.log(`\n[3/6] Picking exemplars (last ${exemplarsPerLang} per platform/lang + engagement-ranked)`);
  const exemplars = [];
  for (const k of Object.keys(byPlatformLang)) {
    const [platform, language] = k.split(':');
    const subset = allPosts.filter(p => p.platform === platform && p.language === language);
    // Last-N (by post_date)
    const lastN = pipelines.pickLastN(subset, exemplarsPerLang);
    // Engagement-ranked top-N (no overlap with lastN)
    const ranked = pipelines.rankPostsByEngagement(subset);
    const lastIds = new Set(lastN.map(p => p.id));
    const topByEngagement = ranked.filter(p => !lastIds.has(p.id)).slice(0, exemplarsPerLang);
    for (const p of lastN) exemplars.push({
      id: p.id, platform, language, caption: p.caption, hashtags: p.hashtags,
      post_date: p.post_date, engagement: p.engagement || null,
      importance: 5, source: 'last-30',
    });
    for (const p of topByEngagement) exemplars.push({
      id: p.id, platform, language, caption: p.caption, hashtags: p.hashtags,
      post_date: p.post_date, engagement: p.engagement || null,
      importance: 4, source: 'engagement-top',
    });
  }
  fs.writeFileSync(path.join(outDir, 'exemplars.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), exemplars }, null, 2));
  console.log(`[ok] wrote exemplars.json (${exemplars.length} items)`);

  // ── 4. Voice fingerprint embedding ────────────────────────────────
  console.log(`\n[4/6] Voice fingerprint embedding (model=${embedModel})`);
  const fingerprint = await pipelines.buildVoiceFingerprint({
    posts: allPosts, perPlatform: exemplarsPerLang, total: 60, outDir, embedModel,
  });
  fs.writeFileSync(path.join(outDir, 'voice_fingerprint.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), ...fingerprint }, null, 2));
  console.log(`[ok] wrote voice_fingerprint.json (${fingerprint.cluster.length} cluster paragraphs · ${fingerprint.centroid_dim}-dim)`);

  // ── 5. Vision analysis ────────────────────────────────────────────
  console.log(`\n[5/6] Vision analysis (model=${visionModel}, max=${maxImages})`);
  const imagesToAnalyze = [];
  for (const p of allPosts) {
    for (const ip of (p.image_paths || [])) {
      imagesToAnalyze.push({ post_id: p.id, platform: p.platform, language: p.language, image_path: ip, engagement: p.engagement, post_date: p.post_date });
    }
  }
  // Prioritise: engagement-ranked + last-N (so the cap hits the most-representative)
  const ranked = pipelines.rankPostsByEngagement(allPosts.filter(p => p.image_paths && p.image_paths.length));
  const idOrder = new Map(ranked.map((p, i) => [p.id, i]));
  imagesToAnalyze.sort((a, b) => (idOrder.get(a.post_id) ?? 9999) - (idOrder.get(b.post_id) ?? 9999));
  const imagesCap = imagesToAnalyze.slice(0, maxImages);
  console.log(`      analyzing ${imagesCap.length} of ${imagesToAnalyze.length} images`);

  const visionResults = [];
  let i = 0;
  for (const img of imagesCap) {
    i++;
    process.stdout.write(`      [${i}/${imagesCap.length}] ${path.basename(img.image_path)} ... `);
    try {
      const r = await pipelines.analyzeImageOne({ imagePath: img.image_path, model: visionModel, outDir });
      if (r) {
        visionResults.push({ ...r, post_id: img.post_id, platform: img.platform, language: img.language, image_path: img.image_path });
        console.log('ok');
      } else {
        console.log('skipped (file missing)');
      }
    } catch (e) {
      console.log(`ERR: ${e.message.slice(0, 100)}`);
    }
  }

  const visualProfile = pipelines.aggregateVisualProfile(visionResults);
  fs.writeFileSync(path.join(outDir, 'visual_style_profile.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), aggregate: visualProfile, samples: visionResults }, null, 2));
  console.log(`[ok] wrote visual_style_profile.json`);

  // ── 6. Style references — copy top-50 images for the library ───────
  console.log(`\n[6/6] Copying top-50 style references`);
  const refDir = path.join(outDir, 'style_references');
  const topRefs = visionResults.slice(0, 50);
  for (let j = 0; j < topRefs.length; j++) {
    const src = topRefs[j].image_path;
    if (!fs.existsSync(src)) continue;
    const ext = path.extname(src) || '.jpg';
    const dst = path.join(refDir, `${String(j + 1).padStart(2, '0')}-${topRefs[j].platform}-${topRefs[j].post_id}${ext}`);
    fs.copyFileSync(src, dst);
  }
  console.log(`[ok] copied ${topRefs.length} reference images to ${refDir}`);

  // ── Done ──────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`✓ Brand voice archive ready in ${outDir}`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  • brand_voice_profile.json     — structural patterns per platform/lang`);
  console.log(`  • exemplars.json                — ${exemplars.length} top exemplars`);
  console.log(`  • voice_fingerprint.json        — embedding cluster of canonical voice`);
  console.log(`  • visual_style_profile.json     — palette + layouts + motifs`);
  console.log(`  • style_references/             — top-50 reference images`);
  console.log(`  • posts.csv                     — flat dump for spot-checking`);
  console.log(`\nNext: review brand_voice_profile.json — does it match your sense of the brand?`);
  console.log(`Then upload with:  node upload.js --to https://rxapply.com --token <YOUR_TOKEN>`);
}

// ── Helpers ──────────────────────────────────────────────────────────
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
