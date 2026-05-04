#!/usr/bin/env node
// tools/brand-analyzer/upload-visual-references.js
// =====================================================================
// M56 batch B · Upload Afshin's visual reference library to R2.
//
// Reads:
//   output/style_references/         (50 standard references)
//   output/style_references_winners/ (top-engagement winners — extra weight)
//   output/visual_style_profile.json (per-image samples — for metadata)
//
// For each image, derives metadata (post_id, style, layout, palette, etc.)
// from the filename + matching sample in visual_style_profile.json, then
// POSTs to /brand/visual-references/upload (one image at a time, with
// progress + retry).
//
// Result: 75-ish brand_exemplars rows tagged for Afshin retrieval, +
// matching media_library rows so Designs tab shows them in the gallery.
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
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (!n || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    }
  }
  return a;
}

const HELP = `
Usage: node upload-visual-references.js [flags]

  --to <url>        Control-plane base URL (default $RXAPPLY_BASE_URL or https://rxapply.com)
  --token <token>   Founder API token (default $RXAPPLY_FOUNDER_TOKEN)
  --output <dir>    Analyzer output folder (default ./output OR --analysis-dir)
  --analysis-dir <dir>  Alternative path to the brand-analysis output folder
                        (defaults to C:\\Users\\Hojat\\OneDrive\\Desktop\\brand-analysis\\output)
  --skip-winners    Don't upload style_references_winners/
  --max <N>         Cap how many images to upload (default: all)
  --dry-run         Print what would be uploaded
  --help            Show this help
`.trim();

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const baseUrl = (args.to || process.env.RXAPPLY_BASE_URL || 'https://rxapply.com').replace(/\/+$/, '');
  const token   = args.token || process.env.RXAPPLY_FOUNDER_TOKEN;
  const outDir  = path.resolve(
    args['analysis-dir']
    || args.output
    || 'C:/Users/Hojat/OneDrive/Desktop/brand-analysis/output'
  );

  if (!token) { console.error('ERROR: --token required.\n' + HELP); process.exit(1); }

  const refsDir = path.join(outDir, 'style_references');
  const winnersDir = path.join(outDir, 'style_references_winners');
  if (!fs.existsSync(refsDir)) {
    console.error(`ERROR: ${refsDir} not found. Pass --analysis-dir to point at the brand-analysis output folder.`);
    process.exit(1);
  }

  // Load visual_style_profile.json so we can attach per-image metadata
  let samples = [];
  const vspPath = path.join(outDir, 'visual_style_profile.json');
  if (fs.existsSync(vspPath)) {
    try { samples = JSON.parse(fs.readFileSync(vspPath, 'utf8')).samples || []; }
    catch (e) { console.warn('warn: could not parse visual_style_profile.json'); }
  }
  // Index samples by post_id for fast lookup
  const sampleByPostId = {};
  for (const s of samples) {
    if (s.post_id) sampleByPostId[s.post_id] = s;
  }
  console.log(`Loaded ${samples.length} per-image samples from visual_style_profile.json`);

  const queue = [];
  // Standard references
  for (const f of fs.readdirSync(refsDir).sort()) {
    if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
    queue.push({ filePath: path.join(refsDir, f), filename: f, isWinner: false });
  }
  // Winners (extra-weighted)
  if (!args['skip-winners'] && fs.existsSync(winnersDir)) {
    for (const f of fs.readdirSync(winnersDir).sort()) {
      if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
      queue.push({ filePath: path.join(winnersDir, f), filename: f, isWinner: true });
    }
  }
  if (args.max) queue.length = Math.min(queue.length, parseInt(args.max, 10));
  console.log(`\nReady to upload ${queue.length} images:`);
  console.log(`  ${queue.filter(q => !q.isWinner).length} standard references`);
  console.log(`  ${queue.filter(q =>  q.isWinner).length} top-engagement winners (importance=5)`);
  console.log();

  if (args['dry-run']) { console.log('[--dry-run] not uploading.'); return; }

  // Upload one at a time with retries
  let ok = 0, failed = 0;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    process.stdout.write(`  [${i + 1}/${queue.length}] ${item.filename} ... `);

    // Parse filename: 01-instagram-ig-1728410472.jpg or W01-instagram-ig-1620507585.jpg
    const m = item.filename.match(/^[Ww]?\d+-([a-z]+)-([a-zA-Z0-9_-]+)\./);
    const platform = m ? m[1] : 'instagram';
    const postId = m ? m[2] : null;
    const sample = postId ? sampleByPostId[postId] : null;

    // Build metadata + topic_tags
    const tags = ['visual-reference'];
    if (item.isWinner) tags.push('top-engagement');
    if (platform) tags.push(platform);
    if (sample) {
      if (sample.style)   tags.push(`style-${String(sample.style).split(/[\s\/]/)[0].toLowerCase()}`);
      if (sample.layout)  tags.push(`layout-${String(sample.layout).split(/[\s\/]/)[0].toLowerCase()}`);
      if (sample.subject) tags.push(`subject-${String(sample.subject).split(/[\s,\/]/)[0].toLowerCase()}`);
      if (sample.mood)    tags.push(`mood-${String(sample.mood).split(/[\s,\/]/)[0].toLowerCase()}`);
    }

    const buf = fs.readFileSync(item.filePath);
    const ext = path.extname(item.filename).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    const payload = {
      filename: item.filename,
      b64: buf.toString('base64'),
      mime,
      sourceLabel: `brand_visuals_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      metadata: {
        post_id: postId,
        platform,
        language: sample && sample.language || 'fa',
        outcome: item.isWinner ? 'top_engagement' : 'brand_reference',
        topic_tags: tags,
        ...(sample ? {
          style: sample.style,
          layout: sample.layout,
          subject: sample.subject,
          dominant_colors: sample.dominant_colors,
          accent_colors: sample.accent_colors,
          typography: sample.typography,
          logo: sample.logo,
          brand_pattern_motifs: sample.brand_pattern_motifs,
          mood: sample.mood,
        } : {}),
      },
    };

    let success = false, lastErr = null;
    const csrfToken = args['csrf-token'] || process.env.RXAPPLY_CSRF_TOKEN;
    const headers = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        const r = await fetch(`${baseUrl}/brand/visual-references/upload`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        const txt = await r.text();
        if (r.ok) {
          let resp; try { resp = JSON.parse(txt); } catch {}
          console.log(`OK${item.isWinner ? ' ⭐' : ''}`);
          success = true;
          ok++;
        } else {
          lastErr = `HTTP ${r.status}: ${txt.slice(0, 200)}`;
          if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
        }
      } catch (e) {
        lastErr = e.message;
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }
    }
    if (!success) {
      console.log(`FAIL: ${lastErr}`);
      failed++;
    }
    // Polite gap between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`✓ ${ok} uploaded · ${failed} failed`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`\nVerify in dashboard:`);
  console.log(`  • Brand training tab → Exemplars sub-tab (filter kind=design_brief)`);
  console.log(`  • Designs tab → should show the new entries`);
  console.log(`  • Run a Compose with cover image — Afshin retrieves top-3 by topic match`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
