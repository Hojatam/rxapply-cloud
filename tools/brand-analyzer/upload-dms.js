#!/usr/bin/env node
// tools/brand-analyzer/upload-dms.js
// =====================================================================
// M55 · Upload the DM-analysis JSONs (from DM-INSTRUCTIONS.md output)
// to the control plane's /brand/dm-analysis/upload endpoint.
//
// Only sends aggregated patterns + sanitized exemplars. The raw
// dm_threads_input.json + dm_threads_index.json never leave your PC.
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
Usage: node upload-dms.js [flags]

  --to <url>        Control-plane base URL (default $RXAPPLY_BASE_URL or https://rxapply.com)
  --token <token>   Founder API token (default $RXAPPLY_FOUNDER_TOKEN)
  --output <dir>    Analyzer output folder (default ./output)
  --dry-run         Print what would be uploaded
  --help            Show this help

Reads from output/:
  - dm_question_patterns.json
  - dm_objection_playbook.json
  - dm_voice_fingerprint.json
  - dm_intent_examples.json

Sanity check: refuses to upload if dm_threads_input.json or
dm_threads_index.json (PRIVATE files) are accidentally listed.
`.trim();

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const baseUrl = (args.to || process.env.RXAPPLY_BASE_URL || 'https://rxapply.com').replace(/\/+$/, '');
  const token   = args.token || process.env.RXAPPLY_FOUNDER_TOKEN;
  const outDir  = path.resolve(args.output || './output');

  if (!token) { console.error('ERROR: --token required.\n' + HELP); process.exit(1); }
  const required = ['dm_question_patterns.json', 'dm_objection_playbook.json',
                     'dm_voice_fingerprint.json', 'dm_intent_examples.json'];
  for (const f of required) {
    if (!fs.existsSync(path.join(outDir, f))) {
      console.error(`ERROR: ${f} missing in ${outDir}. Run DM-INSTRUCTIONS.md in Claude Code first.`);
      process.exit(1);
    }
  }

  const payload = {
    questionPatterns:  JSON.parse(fs.readFileSync(path.join(outDir, 'dm_question_patterns.json'), 'utf8')),
    objectionPlaybook: JSON.parse(fs.readFileSync(path.join(outDir, 'dm_objection_playbook.json'), 'utf8')),
    voiceFingerprint:  JSON.parse(fs.readFileSync(path.join(outDir, 'dm_voice_fingerprint.json'), 'utf8')),
    intentExamples:    JSON.parse(fs.readFileSync(path.join(outDir, 'dm_intent_examples.json'), 'utf8')),
    sourceLabel:       `dm_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
  };

  console.log(`Payload assembled (~${Math.round(JSON.stringify(payload).length / 1024)} KB)`);
  console.log(`  • question patterns: ${(payload.questionPatterns.patterns || []).length}`);
  console.log(`  • objections: ${(payload.objectionPlaybook.objections || []).length}`);
  console.log(`  • voice fingerprint cluster: ${(payload.voiceFingerprint.cluster || []).length}`);
  console.log(`  • intent examples per bucket: ${
    Object.entries(payload.intentExamples.buckets || {})
      .map(([b, items]) => `${b}=${(items||[]).length}`).join(', ')
  }`);

  if (args['dry-run']) { console.log('\n[--dry-run] not uploading.'); return; }

  // Sanity check: refuse if private files would be uploaded
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.includes('"USER_') === false) {
    console.warn('WARNING: payload has no USER_<hash> identifiers — your DM analyzer may not have hashed names. Check DM-INSTRUCTIONS.md was followed.');
  }
  if (payloadStr.match(/\b09\d{9}\b/) || payloadStr.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)) {
    console.error('ERROR: payload contains what looks like raw phone numbers or emails. Aborting upload.');
    console.error('Check DM-INSTRUCTIONS.md is sanitizing — and re-run the analyzer.');
    process.exit(1);
  }

  const url = `${baseUrl}/brand/dm-analysis/upload`;
  console.log(`\nUploading to ${url} ...`);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: payloadStr,
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error(`FAIL: HTTP ${r.status}\n${txt.slice(0, 1000)}`);
    process.exit(1);
  }
  let resp;
  try { resp = JSON.parse(txt); } catch { resp = { raw: txt.slice(0, 500) }; }
  console.log('\n✓ DM analysis uploaded.');
  console.log(JSON.stringify(resp, null, 2));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
