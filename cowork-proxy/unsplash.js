// cowork-proxy/unsplash.js
// =====================================================================
// M64 · Unsplash integration — real stock photos for Afshin.
//
// Why: 88% of the brand's designs are text-on-image. Some slides need a
// PHOTOREAL hero (doctor, clinic, student, cityscape) where the value is
// the photo itself, with text only as a small overlay. Generating these
// from scratch with gpt-image-2 is wasteful when 5M free, professionally-
// shot photos already exist on Unsplash. Afshin queries by topic, picks
// the best match, and stores the photo in media_library with proper
// photographer attribution.
//
// Required env: UNSPLASH_ACCESS_KEY (free at unsplash.com/developers)
//
// Compliance with Unsplash API guidelines:
//   1. We MUST hit the `links.download_location` URL when a photo is
//      "used" (downloaded for an actual design). This is how Unsplash
//      counts downloads for the photographer. Failing to do this can
//      get the API key revoked. See `triggerDownload()`.
//   2. Photographer attribution is REQUIRED on the published design or
//      its caption. We store name + username + profile URL in
//      media_library.metadata.photographer so the renderer / dashboard
//      can surface it.
//   3. We use UTM tags `?utm_source=rxapply&utm_medium=referral` on
//      profile and photo links per Unsplash's brand requirements.
// =====================================================================

'use strict';

const storage = require('./storage');
const { query, q, qJson, queryReturning } = require('./db');

const UNSPLASH_BASE = 'https://api.unsplash.com';
const UTM = '?utm_source=rxapply&utm_medium=referral';

function _key() {
  return process.env.UNSPLASH_ACCESS_KEY || '';
}

function hasKey() {
  return !!_key();
}

function _withUtm(url) {
  if (!url) return null;
  return url + (url.includes('?') ? '&' : UTM);
}

// Tag a photo with the brand's required attribution shape. Stored on
// media_library so the dashboard + caption renderer always has it.
function _attribution(photo) {
  const u = photo.user || {};
  return {
    name:        u.name || u.username || 'Unsplash photographer',
    username:    u.username || null,
    profile_url: u.username
      ? `https://unsplash.com/@${u.username}${UTM}`
      : (u.links && u.links.html ? _withUtm(u.links.html) : null),
    photo_url:   photo.links && photo.links.html ? _withUtm(photo.links.html) : null,
    source:      'Unsplash',
    license:     'Unsplash License',
  };
}

// ── Public: search ────────────────────────────────────────────────────
//
// query        — free-text search (e.g. "dental clinic modern", "student studying")
// perPage      — max 30
// orientation  — null | 'landscape' | 'portrait' | 'squarish'
// contentFilter — 'low' (default; family-friendly) | 'high'
async function searchPhotos({ query: qText, perPage = 12, orientation = null, contentFilter = 'low' } = {}) {
  if (!hasKey()) return { ok: false, error: 'UNSPLASH_ACCESS_KEY not set' };
  if (!qText || !qText.trim()) return { ok: false, error: 'query required' };

  const params = new URLSearchParams({
    query: qText.trim(),
    per_page: String(Math.min(Math.max(parseInt(perPage, 10) || 12, 1), 30)),
    content_filter: contentFilter,
  });
  if (orientation) params.set('orientation', orientation);

  const r = await fetch(`${UNSPLASH_BASE}/search/photos?${params.toString()}`, {
    headers: { 'Authorization': `Client-ID ${_key()}`, 'Accept-Version': 'v1' },
  });
  if (!r.ok) return { ok: false, error: `Unsplash ${r.status}: ${(await r.text()).slice(0, 200)}` };

  const j = await r.json();
  const items = (j.results || []).map(p => ({
    id: p.id,
    description: p.description || p.alt_description || null,
    width: p.width, height: p.height, color: p.color || null,
    urls: {
      thumb:    p.urls && p.urls.thumb,
      small:    p.urls && p.urls.small,
      regular:  p.urls && p.urls.regular,
      full:     p.urls && p.urls.full,
      raw:      p.urls && p.urls.raw,
    },
    download_location: p.links && p.links.download_location, // required for triggerDownload
    photographer: _attribution(p),
    likes: p.likes || 0,
    blur_hash: p.blur_hash || null,
  }));
  return {
    ok: true, total: j.total || 0, total_pages: j.total_pages || 0,
    count: items.length, items,
  };
}

// ── Public: trigger download (Unsplash compliance) ───────────────────
// Unsplash REQUIRES this hit when a photo is actually used. They use it
// to count downloads for the photographer. Don't skip it — it's a
// terms-of-use requirement, not a side effect.
async function triggerDownload(downloadLocation) {
  if (!hasKey() || !downloadLocation) return { ok: false, error: 'no key or location' };
  try {
    const r = await fetch(downloadLocation, {
      headers: { 'Authorization': `Client-ID ${_key()}`, 'Accept-Version': 'v1' },
    });
    if (!r.ok) return { ok: false, error: `Unsplash download trigger ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Public: fetch a photo's bytes + register in media_library ───────
//
// Downloads the chosen size to R2, creates a media_library row tagged
// 'unsplash_stock', triggers the Unsplash download counter for the
// photographer, and returns a row the dashboard can show in Designs.
//
// Inputs:
//   photoId          — Unsplash photo id
//   downloadLocation — links.download_location from search result
//   urlToFetch       — pick from urls.{regular|full|raw} (regular = 1080w)
//   photographer     — the attribution object we built in search
//   topic            — the founder's topic (for media_library row)
//   language         — language tag (for retrieval)
//   topicTags        — tag array for retrieval ranking
async function importPhoto({
  photoId, downloadLocation, urlToFetch, photographer,
  topic = null, language = null, topicTags = [],
} = {}) {
  if (!photoId || !urlToFetch) return { ok: false, error: 'photoId + urlToFetch required' };

  // 1. Fetch bytes
  const r = await fetch(urlToFetch);
  if (!r.ok) return { ok: false, error: `download ${r.status}` };
  const ct = r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000 || buf.length > 25 * 1024 * 1024) {
    return { ok: false, error: `image bytes out of bounds (${buf.length})` };
  }

  // 2. Trigger Unsplash's download counter (compliance — fire and continue)
  if (downloadLocation) {
    triggerDownload(downloadLocation).catch(() => {});  // best-effort
  }

  // 3. Store in R2 under stock/ prefix
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  const r2Key = `media/stock/unsplash-${photoId}.${ext}`;
  await storage.put({ key: r2Key, body: buf, contentType: ct });

  // 4. Insert into media_library so it shows in Designs gallery + can be
  //    used as a render source by Afshin or as a reference image.
  const dimensions = '1080x1080';   // shape declared after compositing
  const id = await queryReturning(`
    INSERT INTO media_library
      (kind, topic, language, prompt, owner_agent, approved, approved_at,
        dimensions, render_path, render_cost_usd, metadata)
    VALUES
      ('stock_photo', ${q(topic)}, ${q(language || 'en')},
        ${q(`Unsplash stock photo · ${photographer && photographer.name || photoId}`)},
        'afshin', true, NOW(),
        ${q(dimensions)}, ${q(r2Key)}, 0,
        ${qJson({
          source: 'unsplash',
          source_id: photoId,
          source_url: photographer && photographer.photo_url,
          photographer: photographer || null,
          topic_tags: Array.isArray(topicTags) ? topicTags.slice(0, 12) : [],
          attribution_required: true,   // dashboard shows "Photo: <name> on Unsplash"
        })})
    RETURNING id::text;`);

  return {
    ok: true,
    media_id: id,
    r2_key: r2Key,
    url: storage.urlFor ? storage.urlFor(r2Key) : `/storage/${r2Key}`,
    photographer,
    attribution_text: photographer
      ? `Photo by ${photographer.name} on Unsplash`
      : 'Photo from Unsplash',
  };
}

// ── Public: search + auto-pick top result + import in one call ──────
async function quickPick({ query: qText, orientation = null, topic = null, language = null, topicTags = [] } = {}) {
  const s = await searchPhotos({ query: qText, perPage: 5, orientation });
  if (!s.ok) return s;
  if (!s.items.length) return { ok: false, error: 'no results for that query' };
  const top = s.items[0];   // top relevance from Unsplash's own ranking
  return await importPhoto({
    photoId: top.id,
    downloadLocation: top.download_location,
    urlToFetch: top.urls.regular,
    photographer: top.photographer,
    topic: topic || qText,
    language,
    topicTags,
  });
}

module.exports = {
  hasKey,
  searchPhotos,
  triggerDownload,
  importPhoto,
  quickPick,
};
