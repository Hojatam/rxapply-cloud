// tools/brand-analyzer/parsers.js
// =====================================================================
// Parsers for the two input formats. Each returns a list of
// normalised post objects:
//
//   {
//     id, platform, language, post_date,
//     caption, hashtags[], image_paths[],
//     engagement: { likes, comments, saves, views, reach } | null,
//     raw: <provider-specific blob for debugging>,
//   }
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Language detection ───────────────────────────────────────────────
// Quick character-script heuristic. Good enough for FA / AR / EN / DE / FR.
function detectLanguage(text) {
  if (!text) return 'en';
  const s = String(text);
  // Persian uses ی/ک/پ/گ/چ/ژ — distinguish from Arabic
  if (/[پچژکگی]/.test(s)) return 'fa';
  if (/[؀-ۿ]/.test(s)) return 'ar';
  if (/[À-ÿ]/.test(s)) {
    if (/\b(der|die|das|und|nicht|sehr)\b/i.test(s)) return 'de';
    if (/\b(le|la|les|et|pas|très)\b/i.test(s)) return 'fr';
  }
  return 'en';
}

function extractHashtags(text) {
  if (!text) return [];
  const m = String(text).match(/#[\p{L}0-9_]+/gu);
  return m ? Array.from(new Set(m.map(t => t.toLowerCase()))) : [];
}

// ── Telegram channel export (Telegram Desktop → Export channel history) ────
//
// The export folder contains result.json + a photos/ subfolder. Messages have:
//   { id, date, text (string | array), photo, file, views, forwarded_from }
function parseTelegramExport(folderPath) {
  const resultPath = path.join(folderPath, 'result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Telegram export not found: ${resultPath}\nMake sure you exported as JSON (not HTML) and pointed to the folder, not the file.`);
  }
  const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const messages = raw.messages || [];
  const out = [];

  for (const m of messages) {
    if (m.type !== 'message') continue;          // skip service messages
    // Skip pure forwards without our own commentary
    if (m.forwarded_from && (!m.text || (Array.isArray(m.text) ? m.text.length === 0 : !m.text.trim()))) continue;

    // text field is sometimes a plain string, sometimes an array of {type, text}
    let caption = '';
    if (typeof m.text === 'string') {
      caption = m.text;
    } else if (Array.isArray(m.text)) {
      caption = m.text.map(part => typeof part === 'string' ? part : (part.text || '')).join('');
    }
    caption = caption.trim();
    if (!caption && !m.photo) continue;          // skip empty + no-image messages

    const imagePath = m.photo
      ? path.join(folderPath, m.photo)
      : (m.file && m.mime_type && m.mime_type.startsWith('image/') ? path.join(folderPath, m.file) : null);

    out.push({
      id: `tg-${m.id}`,
      platform: 'telegram',
      language: detectLanguage(caption),
      post_date: m.date || m.date_unixtime || null,
      caption,
      hashtags: extractHashtags(caption),
      image_paths: imagePath ? [imagePath] : [],
      engagement: typeof m.views === 'number' ? { views: m.views } : null,
      raw: { id: m.id, date: m.date, type: m.type },
    });
  }
  return out;
}

// ── Instagram archive (Meta DYI export, JSON format) ────────────────────────
//
// Structure: {ARCHIVE_ROOT}/your_instagram_activity/content/posts_1.json (and posts_2 etc.)
// Each post has:
//   { media: [{ uri, title, creation_timestamp, ... }], title }
async function parseInstagramArchive(archivePath) {
  const isZip = archivePath.toLowerCase().endsWith('.zip');
  let rootPath = archivePath;

  if (isZip) {
    // Lazy-require yauzl so the rest of the analyzer works without it.
    const yauzl = require('yauzl');
    rootPath = await new Promise((resolve, reject) => {
      const tmp = path.join(path.dirname(archivePath), '.ig-extract-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
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
        zip.on('end', () => resolve(tmp));
        zip.on('error', reject);
      });
    });
  }

  // Find every posts_*.json under the archive
  const postsFiles = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/^posts_\d+\.json$/i.test(e) || e.toLowerCase() === 'posts.json') postsFiles.push(p);
    }
  }
  walk(rootPath);
  if (postsFiles.length === 0) {
    throw new Error(`No posts_*.json found in ${rootPath}.\nDid you pick "JSON" format on the IG download? See README → Path A.`);
  }

  const out = [];
  for (const f of postsFiles) {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const arr = Array.isArray(data) ? data : (data.posts || data.media || []);
    for (const post of arr) {
      const media = Array.isArray(post.media) ? post.media : (post.media ? [post.media] : []);
      const caption = (post.title || (media[0] && media[0].title) || '').trim();
      const ts = post.creation_timestamp || (media[0] && media[0].creation_timestamp) || null;
      const imagePaths = media
        .filter(m => m && m.uri && /\.(jpg|jpeg|png|webp)$/i.test(m.uri))
        .map(m => path.join(rootPath, m.uri));
      if (!caption && imagePaths.length === 0) continue;
      out.push({
        id: `ig-${ts || Math.random().toString(36).slice(2, 10)}`,
        platform: 'instagram',
        language: detectLanguage(caption),
        post_date: ts,
        caption,
        hashtags: extractHashtags(caption),
        image_paths: imagePaths,
        engagement: null,                         // archive doesn't include metrics
        raw: { source_file: path.basename(f) },
      });
    }
  }
  return out;
}

// ── Instagram via Graph API (live fetch) ────────────────────────────
async function fetchInstagramViaGraph({ token, accountId, limit = 200 }) {
  if (!token || !accountId) throw new Error('Need IG_LONG_LIVED_TOKEN + IG_BUSINESS_ACCOUNT_ID');
  const out = [];
  let url = `https://graph.facebook.com/v22.0/${accountId}/media`
          + `?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,`
          + `like_count,comments_count,insights.metric(impressions,reach,saved,shares,total_interactions)`
          + `&limit=50&access_token=${encodeURIComponent(token)}`;

  while (url && out.length < limit) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`IG Graph ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    for (const post of (j.data || [])) {
      const insightsMap = {};
      for (const i of (post.insights && post.insights.data || [])) {
        insightsMap[i.name] = (i.values && i.values[0] && i.values[0].value) || 0;
      }
      out.push({
        id: `ig-live-${post.id}`,
        platform: 'instagram',
        language: detectLanguage(post.caption),
        post_date: post.timestamp,
        caption: post.caption || '',
        hashtags: extractHashtags(post.caption),
        image_paths: post.media_url ? [post.media_url] : (post.thumbnail_url ? [post.thumbnail_url] : []),
        engagement: {
          likes: post.like_count || 0,
          comments: post.comments_count || 0,
          impressions: insightsMap.impressions || 0,
          reach: insightsMap.reach || 0,
          saved: insightsMap.saved || 0,
          shares: insightsMap.shares || 0,
          total_interactions: insightsMap.total_interactions || 0,
        },
        raw: { permalink: post.permalink, media_type: post.media_type },
      });
    }
    url = (j.paging && j.paging.next) || null;
  }
  return out.slice(0, limit);
}

// ── Engagement merge — pair archive posts with Meta Business Suite CSV ─────
//
// CSV is matched by post permalink or timestamp. CSV format expected:
//   "Post ID","Account ID","Account username","Description","Duration (sec)",
//   "Publish time","Permalink","Post type","Data comment","Date","Impressions",
//   "Reach","Likes","Comments","Saves","Shares","Follows", ...
function mergeEngagementCsv(posts, csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return posts;
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return posts;
  const header = lines[0].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.replace(/^"|"$/g, '').toLowerCase());
  const idxOf = (k) => header.findIndex(h => h.includes(k));
  const idxLink   = idxOf('permalink');
  const idxLikes  = idxOf('likes');
  const idxComm   = idxOf('comments');
  const idxSaves  = idxOf('saves');
  const idxReach  = idxOf('reach');
  const idxImpr   = idxOf('impressions');
  const idxDate   = idxOf('publish');
  const byLink = {};

  for (const ln of lines.slice(1)) {
    const cells = ln.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.replace(/^"|"$/g, ''));
    const link = cells[idxLink];
    if (!link) continue;
    byLink[link] = {
      likes:    parseInt(cells[idxLikes] || 0, 10) || 0,
      comments: parseInt(cells[idxComm]  || 0, 10) || 0,
      saved:    parseInt(cells[idxSaves] || 0, 10) || 0,
      reach:    parseInt(cells[idxReach] || 0, 10) || 0,
      impressions: parseInt(cells[idxImpr] || 0, 10) || 0,
      _csv_date: cells[idxDate],
    };
  }
  for (const p of posts) {
    const link = p.raw && p.raw.permalink;
    if (link && byLink[link]) p.engagement = { ...(p.engagement || {}), ...byLink[link] };
  }
  return posts;
}

module.exports = {
  detectLanguage,
  extractHashtags,
  parseTelegramExport,
  parseInstagramArchive,
  fetchInstagramViaGraph,
  mergeEngagementCsv,
};
