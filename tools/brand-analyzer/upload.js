#!/usr/bin/env node
// tools/brand-analyzer/upload.js
// =====================================================================
// Hands the analyzer's output to the control plane in one HTTP call.
// The endpoint (POST /brand/archive/upload) seeds:
//   • brand_profile JSONB columns (tone_patterns + visual_patterns)
//   • Sepehr / Avang / Goyesh / Bidar agent_memory with exemplars
//   • voice_fingerprint table (centroid + cluster)
//   • style_references in media_library (with images uploaded to R2)
//
// Run AFTER review of the JSON files in output/.
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
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[m[1]] = val;
  }
})();

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
Usage: node upload.js [flags]

  --to <url>           Control-plane base URL (default: $RXAPPLY_BASE_URL or https://rxapply.com)
  --token <token>      Founder API token (default: $RXAPPLY_FOUNDER_TOKEN)
  --output <folder>    Analyzer output folder (default: ./output)
  --dry-run            Print what would be uploaded, don't actually POST
  --help               Show this help

Get the founder token by logging into the dashboard, opening the browser
DevTools → Application → Local Storage → look for 'rxapply-auth-token'.
Copy that value (NOT the CSRF token — the auth token).
`.trim();

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const baseUrl = (args.to || process.env.RXAPPLY_BASE_URL || 'https://rxapply.com').replace(/\/+$/, '');
  const token   = args.token || process.env.RXAPPLY_FOUNDER_TOKEN;
  const outDir  = path.resolve(args.output || './output');

  if (!token) { console.error('ERROR: --token (or RXAPPLY_FOUNDER_TOKEN) is required.\n' + HELP); process.exit(1); }
  for (const f of ['brand_voice_profile.json', 'exemplars.json', 'voice_fingerprint.json', 'visual_style_profile.json']) {
    if (!fs.existsSync(path.join(outDir, f))) {
      console.error(`ERROR: ${f} missing in ${outDir}. Run analyze.js first.`);
      process.exit(1);
    }
  }

  // 1. Load and combine the JSON outputs.
  const payload = {
    generated_at: new Date().toISOString(),
    brand_voice_profile:  JSON.parse(fs.readFileSync(path.join(outDir, 'brand_voice_profile.json'),  'utf8')),
    exemplars:            JSON.parse(fs.readFileSync(path.join(outDir, 'exemplars.json'),            'utf8')),
    voice_fingerprint:    JSON.parse(fs.readFileSync(path.join(outDir, 'voice_fingerprint.json'),    'utf8')),
    visual_style_profile: JSON.parse(fs.readFileSync(path.join(outDir, 'visual_style_profile.json'), 'utf8')),
  };

  // 2. Style references — find images, encode as base64 (server uploads to R2).
  const refDir = path.join(outDir, 'style_references');
  const styleRefs = [];
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).slice(0, 50)) {
      const p = path.join(refDir, f);
      if (!fs.statSync(p).isFile()) continue;
      if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
      const ext = path.extname(f).slice(1).toLowerCase();
      const buf = fs.readFileSync(p);
      // Cap individual image size at 5 MB so we don't blow up the request.
      if (buf.length > 5 * 1024 * 1024) continue;
      styleRefs.push({
        filename: f,
        ext,
        b64: buf.toString('base64'),
      });
    }
  }
  payload.style_references = styleRefs;

  const sizeMb = (JSON.stringify(payload).length / 1024 / 1024).toFixed(2);
  console.log(`Payload assembled: ${sizeMb} MB`);
  console.log(`  • brand_voice_profile (patterns for ${Object.keys(payload.brand_voice_profile.patterns || {}).length} platform/lang groups)`);
  console.log(`  • exemplars (${(payload.exemplars.exemplars || []).length})`);
  console.log(`  • voice_fingerprint (${(payload.voice_fingerprint.cluster || []).length} cluster items)`);
  console.log(`  • visual_style_profile (${(payload.visual_style_profile.samples || []).length} image samples)`);
  console.log(`  • style_references (${styleRefs.length} images)`);

  if (args['dry-run']) { console.log('\n[--dry-run] not uploading.'); return; }

  // 3. POST to /brand/archive/upload (M55 endpoint shape)
  // The endpoint takes the analyzer JSONs as named keys.
  const archivePayload = {
    patterns:           payload.brand_voice_profile,
    exemplars:          payload.exemplars,
    fingerprint:        payload.voice_fingerprint,
    visualProfile:      payload.visual_style_profile,
    sourceLabel:        `archive_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
  };
  // engagement_analysis.json is optional — read it if present in output/
  const engagementPath = path.join(outDir, 'engagement_analysis.json');
  if (fs.existsSync(engagementPath)) {
    archivePayload.engagementAnalysis = JSON.parse(fs.readFileSync(engagementPath, 'utf8'));
  }

  const url = `${baseUrl}/brand/archive/upload`;
  console.log(`\nUploading to ${url} ...`);
  console.log(`  source label: ${archivePayload.sourceLabel}`);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(archivePayload),
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error(`FAIL: HTTP ${r.status}\n${txt.slice(0, 1000)}`);
    process.exit(1);
  }
  let resp;
  try { resp = JSON.parse(txt); } catch { resp = { raw: txt.slice(0, 500) }; }
  console.log('\n✓ Upload succeeded.');
  console.log(JSON.stringify(resp, null, 2));

  // Style references (images) — separate path: upload one by one to /brand/exemplars
  // (the design-brief kind). Skip for now; the visual_style_profile already
  // captured the brand_rules_inferred. Image uploads can come in M55b if needed.
  if (styleRefs.length > 0) {
    console.log(`\n${styleRefs.length} style reference images detected but NOT uploaded.`);
    console.log('Visual rules from visual_style_profile.aggregate.brand_rules_inferred are imported as Afshin intelligence.');
    console.log('Image uploads to media_library: ship M55b if needed.');
  }

  // M56 · Auto-detect + upload dm_tone_profile.json if present
  const tonePath = path.join(outDir, 'dm_tone_profile.json');
  if (fs.existsSync(tonePath)) {
    console.log(`\n→ Detected dm_tone_profile.json — uploading separately ...`);
    try {
      const tonePayload = {
        toneProfile: JSON.parse(fs.readFileSync(tonePath, 'utf8')),
        sourceLabel: `dm_tone_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      };
      const tr = await fetch(`${baseUrl}/brand/dm-tone-profile/upload`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(tonePayload),
      });
      const tt = await tr.text();
      if (!tr.ok) {
        console.error(`  FAIL: HTTP ${tr.status}\n  ${tt.slice(0, 500)}`);
      } else {
        console.log(`  ✓ dm_tone_profile uploaded.`);
        try { console.log('  ' + JSON.stringify(JSON.parse(tt))); } catch (_) {}
      }
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
