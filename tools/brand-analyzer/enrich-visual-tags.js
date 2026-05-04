#!/usr/bin/env node
// tools/brand-analyzer/enrich-visual-tags.js
// =====================================================================
// M73 · Enrich brand_exemplars topic_tags from visual_style_profile.json
//
// The 75 visual references uploaded in M56 batch B got generic tags:
//   ["visual-reference", "top-engagement", "instagram"]
//
// This script derives RICHER tags from each sample's metadata in
// visual_style_profile.json (style, layout, subject, mood, brand_pattern_motifs)
// and PATCHes each brand_exemplar's topic_tags. Result: a "Canada NDEB
// deadline" Compose run actually retrieves Canada-deadline-poster
// references instead of just the top-3 winners.
//
// Tag families derived:
//   country-{germany|usa|canada|australia|uk|saudi|uae|denmark|iran|france|...}
//   template-{photoreal-hero|infographic-poster|workshop-poster|deadline-poster|watercolor-occasion|...}
//   mood-{urgent|occasion|authoritative|warm|clinical|hopeful|professional}
//   subject-{doctor|student|clinic|cityscape|product|landmark|...}
//
// Generic tags (visual-reference, top-engagement, instagram) are PRESERVED.
//
// Usage:
//   node enrich-visual-tags.js \
//     --to https://rxapply.com \
//     --token <RXAPPLY_AUTH_TOKEN> \
//     --csrf-token <RXAPPLY_CSRF_TOKEN> \
//     --analysis-dir C:/Users/Hojat/OneDrive/Desktop/brand-analysis/output
//   --dry-run         show derived tags without writing
//   --limit N         only process first N exemplars
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

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
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

// ── Tag derivation ────────────────────────────────────────────────────

const COUNTRY_PATTERNS = [
  { tag: 'country-germany',   re: /\b(germany|german|deutschland|آلمان)\b/i },
  { tag: 'country-usa',       re: /\b(usa|u\.s\.|america|american|آمریکا|آمريكا|united states)\b/i },
  { tag: 'country-canada',    re: /\b(canada|canadian|کانادا)\b/i },
  { tag: 'country-australia', re: /\b(australia|australian|استرالیا)\b/i },
  { tag: 'country-uk',        re: /\b(uk|britain|british|england|english|انگلستان|انگلیس)\b/i },
  { tag: 'country-iran',      re: /\b(iran|iranian|persian|ایران|ایرانی)\b/i },
  { tag: 'country-saudi',     re: /\b(saudi|عربستان)\b/i },
  { tag: 'country-uae',       re: /\b(uae|emirates|dubai|امارات)\b/i },
  { tag: 'country-denmark',   re: /\b(denmark|danish|دانمارک)\b/i },
  { tag: 'country-france',    re: /\b(france|french|فرانسه)\b/i },
  { tag: 'country-norway',    re: /\b(norway|norwegian|نروژ)\b/i },
  { tag: 'country-sweden',    re: /\b(sweden|swedish|سوئد)\b/i },
];

const TEMPLATE_PATTERNS = [
  { tag: 'template-deadline-poster',     re: /\b(deadline|shield-frame|orange.{0,10}deadline|deadline.{0,10}callout)\b/i },
  { tag: 'template-workshop-poster',     re: /\b(workshop|event-promo|templated.{0,10}workshop|vertical-poster)\b/i },
  { tag: 'template-photoreal-hero',      re: /\bphotoreal-hero\b/i },
  { tag: 'template-photoreal-cityscape', re: /\bphotoreal-cityscape\b/i },
  { tag: 'template-photoreal-portrait',  re: /\bphotoreal-portrait\b/i },
  { tag: 'template-infographic-poster',  re: /\binfographic-poster\b/i },
  { tag: 'template-watercolor-occasion', re: /\bwatercolor-illustration\b/i },
  { tag: 'template-graphic-card',        re: /\bgraphic-(question-)?card\b/i },
  { tag: 'template-product-shot',        re: /\bminimalist-product-shot\b/i },
  { tag: 'template-photoreal-with-overlay', re: /\bphotoreal-with-(bold-)?overlay\b/i },
  { tag: 'template-collage',             re: /\b(split-photo-collage|newsy-collage)\b/i },
  { tag: 'template-documentary',         re: /\bdocumentary-photo\b/i },
];

const MOOD_PATTERNS = [
  { tag: 'mood-urgent',         re: /\b(urgent|deadline.{0,10}pressure|urgency)\b/i },
  { tag: 'mood-occasion',       re: /\b(occasion|celebratory|greeting|day|festive)\b/i },
  { tag: 'mood-authoritative',  re: /\bauthoritative\b/i },
  { tag: 'mood-warm',           re: /\b(warm|optimistic|hopeful)\b/i },
  { tag: 'mood-clinical',       re: /\bclinical\b/i },
  { tag: 'mood-professional',   re: /\bprofessional\b/i },
  { tag: 'mood-calm',           re: /\bcalm\b/i },
  { tag: 'mood-newsy',          re: /\b(newsy|news)\b/i },
];

const SUBJECT_PATTERNS = [
  { tag: 'subject-doctor',     re: /\b(doctor|دکتر|physician|dentist|دندانپزشک|white coat|stethoscope)\b/i },
  { tag: 'subject-student',    re: /\b(student|studying|دانشجو|laptop|book)\b/i },
  { tag: 'subject-clinic',     re: /\b(clinic|دفتر|office|operatory)\b/i },
  { tag: 'subject-cityscape',  re: /\b(cityscape|skyline|tourist|landmark|statue|building)\b/i },
  { tag: 'subject-product',    re: /\b(product|tool|object|spread)\b/i },
  { tag: 'subject-flag',       re: /\b(flag)\b/i },
  { tag: 'subject-portrait',   re: /\b(portrait|female|male)\b/i },
  { tag: 'subject-event',      re: /\b(event|workshop|seminar|conference)\b/i },
];

function deriveTags(sample) {
  if (!sample) return [];
  const search = [
    sample.style || '',
    sample.layout || '',
    sample.subject || '',
    sample.mood || '',
    Array.isArray(sample.brand_pattern_motifs) ? sample.brand_pattern_motifs.join(' ') : '',
  ].join(' || ');

  const tags = new Set();
  for (const fams of [COUNTRY_PATTERNS, TEMPLATE_PATTERNS, MOOD_PATTERNS, SUBJECT_PATTERNS]) {
    for (const { tag, re } of fams) {
      if (re.test(search)) tags.add(tag);
    }
  }
  return Array.from(tags);
}

// ── Main ──────────────────────────────────────────────────────────────

const HELP = `
Usage: node enrich-visual-tags.js [flags]

  --to <url>              Control-plane base URL (default $RXAPPLY_BASE_URL or https://rxapply.com)
  --token <token>         Auth token (default $RXAPPLY_FOUNDER_TOKEN or RXAPPLY_AUTH_TOKEN)
  --csrf-token <token>    CSRF token (default $RXAPPLY_CSRF_TOKEN)
  --analysis-dir <dir>    Path to brand-analysis/output (default C:/Users/Hojat/OneDrive/Desktop/brand-analysis/output)
  --limit N               Only process first N exemplars
  --dry-run               Print tags that would be written, don't PATCH
  --help                  Show this help
`.trim();

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const baseUrl  = (args.to || process.env.RXAPPLY_BASE_URL || 'https://rxapply.com').replace(/\/+$/, '');
  const token    = args.token || process.env.RXAPPLY_FOUNDER_TOKEN || process.env.RXAPPLY_AUTH_TOKEN;
  const csrfTok  = args['csrf-token'] || process.env.RXAPPLY_CSRF_TOKEN;
  const outDir   = path.resolve(args['analysis-dir'] || 'C:/Users/Hojat/OneDrive/Desktop/brand-analysis/output');

  if (!args['dry-run'] && !token) { console.error('ERROR: --token required (or set RXAPPLY_AUTH_TOKEN).\n' + HELP); process.exit(1); }

  // Load samples
  const vspPath = path.join(outDir, 'visual_style_profile.json');
  if (!fs.existsSync(vspPath)) { console.error(`ERROR: ${vspPath} not found`); process.exit(1); }
  const vsp = JSON.parse(fs.readFileSync(vspPath, 'utf8'));
  const samples = vsp.samples || [];
  const sampleByPostId = {};
  for (const s of samples) if (s.post_id) sampleByPostId[s.post_id] = s;
  console.log(`Loaded ${samples.length} samples from visual_style_profile.json`);

  // Fetch exemplars
  console.log(`Fetching design_brief exemplars from ${baseUrl} ...`);
  const r = await fetch(`${baseUrl}/brand/exemplars?kind=design_brief&limit=200`);
  if (!r.ok) { console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  const j = await r.json();
  const exemplars = (j.items || []).filter(e => Array.isArray(e.topic_tags) && e.topic_tags.includes('visual-reference'));
  console.log(`Found ${exemplars.length} design_brief visual-reference exemplars`);

  let limit = args.limit ? parseInt(args.limit, 10) : exemplars.length;
  let touched = 0, skipped = 0, failed = 0;

  for (const ex of exemplars.slice(0, limit)) {
    // Source ref looks like "01-instagram-ig-1728410472.jpg" or "W01-instagram-ig-1620507585.jpg"
    const ref = ex.source_ref || '';
    const m = ref.match(/^[Ww]?\d+-([a-z]+)-([a-zA-Z0-9_-]+)\./);
    const postId = m ? m[2] : null;
    const sample = postId ? sampleByPostId[postId] : null;

    if (!sample) {
      skipped++;
      continue;
    }

    const newTags = deriveTags(sample);
    if (newTags.length === 0) {
      skipped++;
      continue;
    }

    // Merge with existing tags (preserve generic tags, dedup)
    const merged = Array.from(new Set([...(ex.topic_tags || []), ...newTags])).sort();

    // Skip if no actual change
    const existing = (ex.topic_tags || []).slice().sort();
    if (JSON.stringify(merged) === JSON.stringify(existing)) {
      skipped++;
      continue;
    }

    process.stdout.write(`  ${ref.slice(0, 36).padEnd(36)} (${(sample.mood || '').slice(0, 30).padEnd(30)}) → +[${newTags.join(', ')}] ... `);

    if (args['dry-run']) {
      console.log('DRY-RUN');
      touched++;
      continue;
    }

    // PATCH the exemplar
    const headers = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' };
    if (csrfTok) headers['x-csrf-token'] = csrfTok;
    try {
      const pr = await fetch(`${baseUrl}/brand/exemplars/${ex.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ topic_tags: merged }),
      });
      const pt = await pr.text();
      if (!pr.ok) {
        console.log(`FAIL HTTP ${pr.status}: ${pt.slice(0, 120)}`);
        failed++;
        continue;
      }
      console.log(`OK`);
      touched++;
    } catch (e) {
      console.log(`FAIL ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`✓ ${touched} updated · ${skipped} skipped · ${failed} failed`);
  console.log(`══════════════════════════════════════════════════════`);
  if (args['dry-run']) console.log('[--dry-run] no changes were written.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
