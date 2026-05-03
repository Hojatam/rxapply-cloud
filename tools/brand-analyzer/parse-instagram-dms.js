#!/usr/bin/env node
// tools/brand-analyzer/parse-instagram-dms.js
// =====================================================================
// M54 · Pure-JS parser for Instagram DM archive (Meta DYI export).
//
// Input: extracted IG archive folder (or .zip).
// Output: dm_threads_input.json — normalised thread structure that
// Claude Code reads via DM-INSTRUCTIONS.md.
//
// Privacy:
//   - Strips obvious PII (phone, email, long digit sequences)
//     before writing to disk
//   - Replaces the partner's display name with USER_<short-hash>
//     in the LLM-input file. A separate dm_threads_index.json keeps
//     the real handle ↔ hash mapping LOCAL only (not for upload).
//
// Skips:
//   - Group chats (>2 participants) — different beast, less useful
//   - Threads with fewer than --min-messages text messages
//   - Reactions / likes / shares / unsupported types (kept as type
//     marker in metadata but stripped from body)
// =====================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── CLI ──────────────────────────────────────────────────────────────
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
Usage: node parse-instagram-dms.js [flags]

  --archive <path>        Path to IG archive folder OR .zip
  --output <folder>       Output folder (default: ./output)
  --min-messages <N>      Skip threads with fewer than N text messages (default: 3)
  --max-messages <N>      Cap messages per thread for the LLM input (default: 200)
  --no-redact             Disable PII redaction (default: redact ON)
  --help                  Show this help

Run AFTER you've extracted the IG messages archive zip somewhere on your PC.
Then open Claude Code in this folder and follow DM-INSTRUCTIONS.md.
`.trim();

// ── Helpers ──────────────────────────────────────────────────────────

// IG mojibake fix — captions often arrive as UTF-8 bytes mis-encoded as Latin-1.
// Round-trip restores the right text. Best-effort: only applies if it actually decodes.
function _fixIgMojibake(s) {
  if (!s) return s;
  try {
    const buf = Buffer.from(s, 'latin1');
    const fixed = buf.toString('utf8');
    // Heuristic: if the original had non-ASCII Latin-1-looking bytes and the
    // fixed version has more printable Persian / Arabic characters, prefer fixed.
    const origScore = (s.match(/[Ã¢ÂÂ£Â]/g) || []).length;
    const fixedScore = (fixed.match(/[؀-ۿݐ-ݿ]/g) || []).length;
    return fixedScore > origScore ? fixed : s;
  } catch (_) { return s; }
}

function _detectLang(text) {
  if (!text) return 'unknown';
  const s = String(text);
  if (/[پچژکگی]/.test(s)) return 'fa';
  if (/[؀-ۿ]/.test(s)) return 'ar';
  if (/[a-zA-Z]/.test(s)) return 'en';
  return 'unknown';
}

// PII redaction. Strips obvious phone / email / long digit sequences.
// Keeps the structure of the message intact.
function _redact(s) {
  if (!s) return s;
  let out = String(s);
  // Email
  out = out.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]');
  // Phone (international + Iranian patterns)
  out = out.replace(/(\+|00)?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g, '[phone]');
  // Long digit runs (probably IDs / passport / credit-card)
  out = out.replace(/\b\d{8,}\b/g, '[id]');
  // Iranian phone (98...) without explicit country code
  out = out.replace(/\b09\d{9}\b/g, '[phone]');
  // Instagram URL with username (just keep "[ig-link]")
  out = out.replace(/https?:\/\/(?:www\.)?instagram\.com\/[\w._-]+\/?/g, '[ig-link]');
  return out;
}

function _hashName(name) {
  return 'USER_' + crypto.createHash('sha1').update(String(name || '')).digest('hex').slice(0, 6);
}

// ── ZIP extract (yauzl, optional dep) ────────────────────────────────
async function _extractZipIfNeeded(archivePath) {
  if (!archivePath.toLowerCase().endsWith('.zip')) return archivePath;
  let yauzl;
  try { yauzl = require('yauzl'); }
  catch { throw new Error('Pass an EXTRACTED folder, or `npm install` first to use yauzl for zip extraction.'); }
  const tmp = path.join(path.dirname(archivePath), '.dm-extract-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (e) => {
        if (/\/$/.test(e.fileName)) { zip.readEntry(); return; }
        const dest = path.join(tmp, e.fileName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(e, (err2, rs) => {
          if (err2) return reject(err2);
          const ws = fs.createWriteStream(dest);
          rs.pipe(ws);
          ws.on('finish', () => zip.readEntry());
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
    });
  });
  return tmp;
}

// ── Find inbox folder ────────────────────────────────────────────────
function _findInboxFolder(rootPath) {
  // Try common paths first
  const candidates = [
    path.join(rootPath, 'your_instagram_activity', 'messages', 'inbox'),
    path.join(rootPath, 'messages', 'inbox'),
    path.join(rootPath, 'inbox'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Fall back to recursive search
  function walk(dir, depth = 0) {
    if (depth > 5 || !fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (e === 'inbox' && fs.existsSync(path.join(p, '..', 'messages'))) return p;
      const r = walk(p, depth + 1);
      if (r) return r;
    }
    return null;
  }
  return walk(rootPath);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }
  if (!args.archive) { console.error('Need --archive <path>\n' + HELP); process.exit(1); }

  const minMessages = parseInt(args['min-messages'] || 3, 10);
  const maxMessages = parseInt(args['max-messages'] || 200, 10);
  const redact = args['no-redact'] !== true;

  const outDir = path.resolve(args.output || './output');
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write(`[1/4] Resolving archive ... `);
  const rootPath = await _extractZipIfNeeded(path.resolve(args.archive));
  const inboxDir = _findInboxFolder(rootPath);
  if (!inboxDir) {
    console.error(`could not find IG messages 'inbox' folder under ${rootPath}.\nMake sure you ticked "Messages" in the Meta DYI export and chose JSON format.`);
    process.exit(1);
  }
  console.log(`OK\n      inbox: ${inboxDir}`);

  process.stdout.write(`[2/4] Walking threads ... `);
  const threadFolders = fs.readdirSync(inboxDir).filter(f => {
    try { return fs.statSync(path.join(inboxDir, f)).isDirectory(); } catch { return false; }
  });
  console.log(`${threadFolders.length} thread folders`);

  // ── Parse + normalise ───────────────────────────────────────────
  process.stdout.write(`[3/4] Parsing message_*.json files ... `);
  let myName = null;     // detected from "is_still_participant" + most-frequent sender
  const threads = [];
  const senderCounts = {};

  for (const tf of threadFolders) {
    const tdir = path.join(inboxDir, tf);
    const files = fs.readdirSync(tdir).filter(f => /^message_\d+\.json$/.test(f)).sort();
    if (files.length === 0) continue;

    // Read + concatenate messages across paginated files
    let all = [];
    let participants = [];
    let title = null;
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
        if (Array.isArray(j.messages)) all = all.concat(j.messages);
        if (Array.isArray(j.participants)) participants = j.participants;
        if (j.title) title = j.title;
      } catch (e) { /* skip corrupt files */ }
    }

    // Skip group chats (>2 participants)
    if (participants.length > 2) continue;
    if (all.length === 0) continue;

    // Tally sender names so we can later detect "you"
    for (const m of all) {
      if (m.sender_name) senderCounts[m.sender_name] = (senderCounts[m.sender_name] || 0) + 1;
    }
    threads.push({ folder: tf, participants, title, messages: all });
  }

  // Detect the founder's IG name as the most-frequent sender across ALL threads
  myName = Object.entries(senderCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  console.log(`OK · detected "you" = ${myName || '(unknown)'}`);

  // ── Normalise ────────────────────────────────────────────────────
  process.stdout.write(`[4/4] Normalising + redacting ... `);
  const normalisedThreads = [];
  const indexMap = {};        // hash → real partner name (LOCAL ONLY)
  let totalMsgs = 0, droppedShort = 0, droppedNonText = 0;

  for (const t of threads) {
    const partnerName = (t.participants.find(p => p.name !== myName) || {}).name || (t.title || 'unknown');
    const hash = _hashName(partnerName);
    indexMap[hash] = partnerName;

    // Sort messages by timestamp ASC
    const sorted = t.messages.slice().sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));

    // Build normalised message list
    const norm = [];
    let inboundCount = 0, outboundCount = 0;
    for (const m of sorted) {
      // Only text-bearing messages count as content
      let body = '';
      if (typeof m.content === 'string' && m.content.trim()) {
        body = _fixIgMojibake(m.content);
      } else if (m.type === 'Share' && m.share && typeof m.share.share_text === 'string') {
        body = '[shared] ' + _fixIgMojibake(m.share.share_text);
      } else if (m.photos || m.videos || m.audio_files) {
        // Skip non-text messages but keep a short marker for context
        body = '';
      } else {
        body = '';
      }
      if (!body || body.trim().length < 1) { droppedNonText++; continue; }
      const direction = m.sender_name === myName ? 'out' : 'in';
      if (direction === 'in') inboundCount++; else outboundCount++;
      norm.push({
        ts: m.timestamp_ms || null,
        direction,
        body: redact ? _redact(body) : body,
        lang: _detectLang(body),
      });
    }

    if (norm.length < minMessages) { droppedShort++; continue; }
    totalMsgs += norm.length;

    // Cap message count for the LLM-input file
    const capped = norm.length > maxMessages ? norm.slice(-maxMessages) : norm;

    // Detect primary language by tally
    const langTally = {};
    for (const m of norm) langTally[m.lang] = (langTally[m.lang] || 0) + 1;
    const primaryLang = Object.entries(langTally).sort((a, b) => b[1] - a[1])[0][0];

    const ts0 = norm[0].ts || 0, tsN = norm[norm.length - 1].ts || 0;

    normalisedThreads.push({
      thread_id: hash,
      partner: hash,                          // hashed for privacy
      partner_real: undefined,                // never write to disk
      message_count: norm.length,
      inbound_count: inboundCount,
      outbound_count: outboundCount,
      first_message_at: ts0 ? new Date(ts0).toISOString() : null,
      last_message_at:  tsN ? new Date(tsN).toISOString() : null,
      duration_hours: ts0 && tsN ? Math.round((tsN - ts0) / 36000) / 100 : null,
      primary_language: primaryLang,
      messages_capped_to: capped.length < norm.length ? capped.length : null,
      messages: capped,
    });
  }

  // Sort by recency descending so Claude Code sees recent first
  normalisedThreads.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));

  fs.writeFileSync(path.join(outDir, 'dm_threads_input.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    counts: {
      total_threads: normalisedThreads.length,
      total_messages: totalMsgs,
      dropped_threads_short: droppedShort,
      dropped_messages_nontext: droppedNonText,
    },
    you_handle_hash: _hashName(myName),
    threads: normalisedThreads,
  }, null, 2));

  // LOCAL-ONLY index — DO NOT upload. Lets you reverse-look-up real names.
  fs.writeFileSync(path.join(outDir, 'dm_threads_index.json'), JSON.stringify({
    note: 'PRIVATE — never upload. Maps hashed thread_ids back to real partner names.',
    you_real_name: myName,
    you_hash: _hashName(myName),
    map: indexMap,
  }, null, 2));

  console.log(`OK\n      ${normalisedThreads.length} threads kept · ${totalMsgs} messages · ${droppedShort} too short · ${droppedNonText} non-text dropped`);

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`✓ DM archive parsed.`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  output/dm_threads_input.json   ${normalisedThreads.length} threads, hashed handles, redacted PII`);
  console.log(`  output/dm_threads_index.json   PRIVATE — keep on your PC, don't upload`);
  console.log(``);
  console.log(`Now open Claude Code in this folder and tell it:`);
  console.log(`  "Run the DM analysis using DM-INSTRUCTIONS.md"`);
  console.log(``);
  console.log(`Cost: \$0 — Claude Code uses your subscription, not the API.`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
