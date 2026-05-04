// cowork-proxy/compose-renderers.js
// =====================================================================
// Renderer registry for the Compose orchestrator.
//
// Renderers are deterministic JS functions (no LLM call) that take the
// last LLM stage's output and produce the final artifact in the format
// the recipe declared. One renderer per output format.
//
// Contract:
//   render({ source, run, recipe, lang }) → object
//     where the returned object is whatever the dashboard / consumer needs
//     to preview + export the artifact (HTML string, markdown, structured
//     payload, etc.).
//
// `source` is whichever upstream stage produced the structured fields
// (typically the `adapt` stage's `output.fields`, or `output` if the
// recipe has no adapt stage).
//
// Each renderer should be PURE — same source ⇒ same output. No DB writes.
// =====================================================================

'use strict';

const composeImage = require('./compose-image');

// ── Helpers ───────────────────────────────────────────────────────────

function _fields(source) {
  // Adapt stage outputs `{ fields: {...} }`. Draft outputs `{ title, body, ... }`.
  // Renderers should accept either shape.
  if (source && typeof source === 'object' && source.fields && typeof source.fields === 'object') {
    return source.fields;
  }
  return source || {};
}

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Tiny markdown → HTML pass for the formats that need it. Not a full
// markdown engine — handles paragraphs, **bold**, *italic*, [link](url),
// `code`, line breaks, and bullet lists. That covers 95% of what RxApply
// content uses.
function _mdToHtml(md) {
  if (!md) return '';
  let s = String(md).replace(/\r\n/g, '\n');

  // Code spans first (so we don't accidentally bold inside them).
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${_escapeHtml(code)}</code>`);

  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) =>
    `<a href="${_escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${_escapeHtml(txt)}</a>`);

  // Bold + italic (process bold first to avoid * conflicts)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Convert into block elements: split on blank lines.
  const blocks = s.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const html = blocks.map(b => {
    // Bullet list?
    if (/^(\s*[-*]\s+)/.test(b)) {
      const items = b.split(/\n/).filter(Boolean)
        .map(line => line.replace(/^\s*[-*]\s+/, ''))
        .map(li => `<li>${li}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    // Heading? (single # or ##)
    const h = b.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      return `<h${level}>${h[2]}</h${level}>`;
    }
    // Plain paragraph — convert single newlines to <br>
    return `<p>${b.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

// Strip ALL markdown formatting (used for plain-text channels like Telegram
// when we want the raw text length, or for X tweets).
function _mdToPlain(md) {
  if (!md) return '';
  return String(md)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .trim();
}

function _slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function _wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

// ── Default pass-through ──────────────────────────────────────────────
function _default({ source, run, lang }) {
  return {
    _renderer: '_default',
    lang: lang || run.master_lang,
    body: _fields(source),
  };
}

// ── Email (HTML) ──────────────────────────────────────────────────────
// Produces a self-contained HTML document the founder can paste into any
// ESP (Mailchimp / SendGrid / Postal). Inline-styled for max client compat.
function emailHtml({ source, run, recipe, lang }) {
  const f = _fields(source);
  const subject = String(f.subject || '').slice(0, 200);
  const preview = String(f.preview || '').slice(0, 150);
  const bodyMd  = String(f.body || '');
  const bodyHtml = _mdToHtml(bodyMd);
  const fromName = (run.options && run.options.from_name) || 'RxApply';
  const cta = (run.options && run.options.primary_cta) || '';

  const html = [
    '<!doctype html>',
    '<html lang="' + _escapeHtml(lang || run.master_lang || 'en') + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + _escapeHtml(subject) + '</title>',
    '</head>',
    '<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">',
    '<!-- preview text (hidden) -->',
    '<div style="display:none;max-height:0;overflow:hidden;">' + _escapeHtml(preview) + '</div>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;">',
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">',
    '<tr><td style="padding:32px 32px 24px;">',
    '<div style="font-size:13px;color:#64748b;margin-bottom:8px;">' + _escapeHtml(fromName) + '</div>',
    '<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#0f172a;">' + _escapeHtml(subject) + '</h1>',
    '<div style="font-size:16px;line-height:1.6;color:#1e293b;">' + bodyHtml + '</div>',
    cta ? ('<div style="margin-top:28px;"><a href="' + _escapeHtml(cta) + '" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;">Read more</a></div>') : '',
    '</td></tr>',
    '<tr><td style="padding:16px 32px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.5;">',
    'You received this because you signed up at <a href="https://rxapply.com" style="color:#94a3b8;">rxapply.com</a>.<br>',
    '<a href="{{unsubscribe_url}}" style="color:#94a3b8;">Unsubscribe</a>',
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body></html>',
  ].join('\n');

  return {
    _renderer: 'email-html',
    lang: lang || run.master_lang,
    subject,
    preview,
    body_md: bodyMd,
    body_html: bodyHtml,    // body fragment without the wrapper, for ESPs that wrap themselves
    full_html: html,        // complete email document
    word_count: _wordCount(bodyMd),
    cta_url: cta || null,
  };
}

// ── SEO article ───────────────────────────────────────────────────────
// Produces a structured payload ready to feed a CMS (Ghost / Webflow /
// custom MDX). Includes JSON-LD schema for the Article type so the founder
// can drop it straight into a <head>.
function seoArticle({ source, run, recipe, lang }) {
  const f = _fields(source);
  const title = String(f.title || '').slice(0, 200);
  const meta  = String(f.meta_description || '').slice(0, 160);
  const slug  = String(f.slug || '').trim() || _slugify(title);
  const outline = Array.isArray(f.outline) ? f.outline : [];
  const bodyMd = String(f.body_md || '');
  const bodyHtml = _mdToHtml(bodyMd);
  const targetKeyword = (run.options && run.options.target_keyword) || '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: meta,
    inLanguage: lang || run.master_lang,
    author: { '@type': 'Organization', name: 'RxApply' },
    publisher: { '@type': 'Organization', name: 'RxApply' },
    datePublished: new Date().toISOString().slice(0, 10),
  };

  return {
    _renderer: 'seo-article',
    lang: lang || run.master_lang,
    title,
    slug,
    meta_description: meta,
    target_keyword: targetKeyword || null,
    outline,
    body_md: bodyMd,
    body_html: bodyHtml,
    word_count: _wordCount(bodyMd),
    json_ld: jsonLd,
    // Convenience: a complete <article> fragment for hand-off into a page.
    article_html: [
      '<article>',
      '<h1>' + _escapeHtml(title) + '</h1>',
      bodyHtml,
      '</article>',
      '<script type="application/ld+json">' + JSON.stringify(jsonLd) + '</script>',
    ].join('\n'),
  };
}

// ── Telegram ──────────────────────────────────────────────────────────
// Telegram caps a message at ~4096 chars. We also enforce a softer cap
// (~1500 chars / one screen) so the post doesn't feel like an essay.
const TELEGRAM_HARD_CAP = 4000;
const TELEGRAM_SOFT_CAP = 1500;

function telegram({ source, run, lang }) {
  const f = _fields(source);
  const bodyMd = String(f.body_md || f.body || '');
  const ctaText = String(f.cta_text || '').trim();
  const ctaUrl  = String(f.cta_url || (run.options && run.options.primary_cta) || '').trim();

  // Telegram supports a Markdown-V2 dialect; for safety we emit a
  // simplified HTML that Telegram's `parse_mode=HTML` accepts.
  let plain = _mdToPlain(bodyMd);
  if (plain.length > TELEGRAM_HARD_CAP) plain = plain.slice(0, TELEGRAM_HARD_CAP - 3) + '...';

  // Telegram HTML supports: <b> <strong> <i> <em> <u> <s> <a> <code> <pre>
  // We'll convert markdown to that subset.
  let tgHtml = String(bodyMd)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Append CTA on its own line if present.
  if (ctaUrl) {
    const linkText = ctaText || 'Open';
    tgHtml += `\n\n<a href="${ctaUrl}">${linkText} →</a>`;
    plain  += `\n\n${linkText}: ${ctaUrl}`;
  }

  return {
    _renderer: 'telegram',
    lang: lang || run.master_lang,
    body_md: bodyMd,
    body_html: tgHtml,
    body_plain: plain,
    char_count: plain.length,
    over_soft_cap: plain.length > TELEGRAM_SOFT_CAP,
    cta_text: ctaText || null,
    cta_url: ctaUrl || null,
    // Ready-to-POST body for the Telegram Bot API sendMessage endpoint.
    sendMessage_payload: {
      chat_id: (run.options && run.options.channel) || null,
      text: tgHtml,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    },
  };
}

// ── Facebook ──────────────────────────────────────────────────────────
// Facebook posts have no hard length limit but engagement drops sharply
// past ~80-100 words. We warn if the post exceeds 250 words.
const FB_SOFT_CAP_WORDS = 250;

function facebook({ source, run, lang }) {
  const f = _fields(source);
  const hook  = String(f.hook || '').trim();
  const body  = String(f.body || '').trim();
  const cta   = String(f.cta_text || '').trim();
  const ctaUrl = String((run.options && run.options.primary_cta) || '').trim();
  const imgBrief = String(f.image_brief || '').trim();

  // Facebook strips most markdown when posting via the API; normalise to plain text.
  const fullText = [hook, body, cta && ctaUrl ? `${cta}\n${ctaUrl}` : (cta || ctaUrl)].filter(Boolean).join('\n\n');
  const plain = _mdToPlain(fullText);
  const wordCount = _wordCount(plain);

  return {
    _renderer: 'facebook',
    lang: lang || run.master_lang,
    hook,
    body,
    cta_text: cta || null,
    cta_url: ctaUrl || null,
    image_brief: imgBrief || null,
    full_text: plain,
    char_count: plain.length,
    word_count: wordCount,
    over_soft_cap: wordCount > FB_SOFT_CAP_WORDS,
    page_handle: (run.options && run.options.page_handle) || null,
  };
}

// ── X thread ──────────────────────────────────────────────────────────
// X (Twitter) caps each tweet at 280 chars (URLs count as 23). The adapt
// stage produces structured tweet content; this renderer enforces the cap
// per tweet and re-splits if any tweet exceeds it.
const X_TWEET_LIMIT = 280;

function _splitTweet(text, limit = X_TWEET_LIMIT) {
  const t = String(text || '').trim();
  if (t.length <= limit) return [t];
  // Greedy split on sentence / clause boundaries.
  const out = [];
  let remaining = t;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('. ', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut < 1) cut = limit;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

function xThread({ source, run, lang }) {
  const f = _fields(source);
  const hook    = _mdToPlain(String(f.hook_tweet || '').trim());
  const closing = _mdToPlain(String(f.closing_tweet || '').trim());
  const bodyArr = Array.isArray(f.body_tweets) ? f.body_tweets : (f.body_tweets ? [String(f.body_tweets)] : []);
  const ctaUrl = String((run.options && run.options.primary_cta) || '').trim();
  const maxTweets = Math.max(3, Math.min(20, Number((run.options && run.options.max_tweets) || 10)));

  // Build the ordered tweet list. Each entry might exceed 280 chars; split it.
  let tweets = [];
  if (hook) tweets.push(...(_splitTweet(hook)));
  for (const t of bodyArr) {
    tweets.push(...(_splitTweet(_mdToPlain(String(t)))));
  }
  if (closing) {
    const closingFull = ctaUrl ? `${closing}\n${ctaUrl}`.trim() : closing;
    tweets.push(...(_splitTweet(closingFull)));
  }
  // Filter out empties & enforce maxTweets cap.
  tweets = tweets.map(s => s.trim()).filter(Boolean);
  const truncated = tweets.length > maxTweets;
  if (truncated) tweets = tweets.slice(0, maxTweets);

  // Number them as "1/N", "2/N", …
  const total = tweets.length;
  const numbered = tweets.map((t, i) => {
    const tag = ` ${i + 1}/${total}`;
    // Only add the numbering if it fits.
    return (t.length + tag.length <= X_TWEET_LIMIT) ? (t + tag) : t;
  });

  return {
    _renderer: 'x-thread',
    lang: lang || run.master_lang,
    tweets: numbered,
    tweet_count: numbered.length,
    truncated,
    cta_url: ctaUrl || null,
    char_counts: numbered.map(t => t.length),
    over_limit_indices: numbered.map((t, i) => t.length > X_TWEET_LIMIT ? i : -1).filter(i => i >= 0),
  };
}

// ── Instagram ─────────────────────────────────────────────────────────
// IG captions cap at 2200 chars (incl. hashtags + line breaks). We enforce
// a softer cap (1500 chars) before warning. Hashtags are normalised
// (lowercase, deduped, '#' prefix) and capped at run.options.max_hashtags.
const IG_HARD_CAP = 2200;
const IG_SOFT_CAP = 1500;

function _normalizeHashtags(raw, max = 12) {
  const arr = Array.isArray(raw) ? raw : (raw ? String(raw).split(/[\s,]+/) : []);
  const seen = new Set();
  const out = [];
  for (const h of arr) {
    const tag = String(h || '').trim().replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_؀-ۿݐ-ݿ]/g, '');
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(`#${tag}`);
    if (out.length >= max) break;
  }
  return out;
}

function instagram({ source, run, lang }) {
  const f = _fields(source);
  const caption = String(f.caption || '').trim();
  const maxTags = Math.max(3, Math.min(30, Number((run.options && run.options.max_hashtags) || 12)));
  const hashtags = _normalizeHashtags(f.hashtags, maxTags);
  const designPlan  = f.design_plan  || null;   // structured (slides, layout, color, etc.)
  const designBrief = String(f.design_brief || '').trim() || null;

  // Compose the final caption-ready string: caption + blank line + hashtags
  const captionWithTags = [caption, hashtags.join(' ')].filter(Boolean).join('\n\n');
  const charCount = captionWithTags.length;

  return {
    _renderer: 'ig',
    lang: lang || run.master_lang,
    caption,
    hashtags,
    caption_with_tags: captionWithTags,
    char_count: charCount,
    over_soft_cap: charCount > IG_SOFT_CAP,
    over_hard_cap: charCount > IG_HARD_CAP,
    design_plan: designPlan,        // for Afshin to consume
    design_brief: designBrief,      // human-readable description
    cta_url: (run.options && run.options.primary_cta) || null,
  };
}

// ── M32 · Cover image renderer ───────────────────────────────────────
// Async: calls OpenAI Images API and uploads the PNG to R2. Output
// shape:
//   { _renderer: 'image-cover', url, key, prompt, model, cost_usd, size, lang }
// or, on failure (no API key, billing block, etc.):
//   throws an Error — orchestrator marks the stage failed.
//
// `source` for this renderer is whatever upstream stage produced the
// brief. We accept either:
//   • adapt.fields.design_brief / image_brief / design_prompt   (preferred)
//   • render.image_brief (some recipes embed it in the post itself)
//   • final fallback: synthesise a minimal brief from topic + caption
// ── M65 · Multi-slide carousel renderer ────────────────────────────
// Iterates Tarrah's slide spec, calls compose-image.generateCover once
// per slide with the brand-template scaffold + slot values, and returns
// one renderer payload listing every slide's URL/key/photographer. Each
// slide also gets the top-3 brand reference images for consistent style.
async function _renderCarousel({ source, carouselSpec, run, recipe, lang }) {
  const afshin = require('./afshin-router');
  const composeImage = require('./compose-image');
  const slides = carouselSpec.slides || [];
  const templateId = carouselSpec.template;
  const globalSlots = carouselSpec.global || {};

  // ── M89 · Contract enforcement ─────────────────────────────────
  // Afshin (after M82) produces a `slides` array that mirrors Tarrah's
  // count and provides per-slide overrides (image_source, unsplash_query,
  // final_prompt, design_directive, brand_asset_placement). When present,
  // we use Afshin's overrides per-slide. If counts diverge, we FAIL —
  // the founder needs to see that the contract broke.
  const afshinSlides = (source && source.mode === 'carousel' && Array.isArray(source.slides)) ? source.slides : null;
  if (afshinSlides && afshinSlides.length !== slides.length) {
    throw new Error(`M89 contract violation · Tarrah specified ${slides.length} slides, Afshin produced ${afshinSlides.length}. The design stage must produce one slide entry per Tarrah slide. Fix: re-run the design stage or adjust Tarrah's spec.`);
  }
  const afshinByN = new Map();
  if (afshinSlides) {
    for (const a of afshinSlides) {
      if (a && a.n != null) afshinByN.set(a.n, a);
    }
  }

  // Pull top-3 brand reference URLs once — same anchor for every slide.
  // M70 · Also pulls descriptive metadata so the per-slide prompt can be
  // enriched (style/layout/typography rules from the visual_style_profile).
  let referenceUrls = [];
  let designBriefs = [];
  try {
    const trainingRetrieval = require('./agent-training-retrieval');
    const topicKw = require('./agent-training-retrieval').expandTopicTags(run.topic || '');
    const packet = await trainingRetrieval.getTrainingPacket({
      agent: 'afshin', stageName: 'design',
      platform: recipe && recipe.id, language: lang || run.master_lang,
      topicTags: [...topicKw, 'visual-reference'],
    });
    designBriefs = (packet.exemplars || []).filter(e => e.kind === 'design_brief').slice(0, 3);
    for (const d of designBriefs) {
      const m = String(d.body || '').match(/URL:\s*(\S+)/);
      if (m) referenceUrls.push(m[1]);
    }
  } catch (_) { /* non-fatal */ }

  const runOption = (run.options && run.options.image_model) || null;
  const designSuggestion = (source && source.recommended_model) || null;
  const recipeDefault = (recipe && recipe.default_image_model) || null;

  const renderedSlides = [];
  let totalCost = 0;
  let firstError = null;

  for (const slide of slides) {
    // Merge global slots (palette, country pill, icon) with per-slide
    // overrides, then expand the template scaffold to a render prompt.
    const mergedSlots = { ...globalSlots, ...(slide.slots || {}) };
    let slidePrompt = afshin.renderTemplatePrompt(templateId, mergedSlots);

    // If the template doesn't render (unknown id), fall back to a plain
    // scaffold built from the slot values themselves.
    if (!slidePrompt) {
      const parts = [`RxApply brand carousel slide #${slide.n} of ${slides.length}.`];
      if (mergedSlots.title) parts.push(`Main title (large, render exactly): "${mergedSlots.title}"`);
      if (mergedSlots.subtitle) parts.push(`Subtitle: "${mergedSlots.subtitle}"`);
      if (mergedSlots.country_pill) parts.push(`Country pill text: "${mergedSlots.country_pill}"`);
      if (Array.isArray(mergedSlots.body_bullets)) parts.push(`Bullets: ${mergedSlots.body_bullets.map(b => `"${b}"`).join(', ')}`);
      if (mergedSlots.key_number) parts.push(`Big key number: "${mergedSlots.key_number}"`);
      if (mergedSlots.deadline_pill) parts.push(`Orange deadline pill: "${mergedSlots.deadline_pill}"`);
      if (mergedSlots.date_pill) parts.push(`Date pill: "${mergedSlots.date_pill}"`);
      if (mergedSlots.block_color) parts.push(`Solid-fill caption block color: ${mergedSlots.block_color}`);
      if (mergedSlots.icon) parts.push(`Circular brand icon: ${mergedSlots.icon}`);
      parts.push('Brand: clean, professional, calm. Teal R-arrow logo on white square integrated as a design element.');
      slidePrompt = parts.join(' ');
    }

    // Append slot-discipline note so the model renders text exactly
    slidePrompt += `\n\n[Render the on-image text VERBATIM from the slot values above. ` +
                    `Persian numerals on Persian slides; do not paraphrase or translate slot text. ` +
                    `This is slide ${slide.n} of ${slides.length} in a carousel — keep palette, fonts, ` +
                    `and brand identity consistent across slides.]`;

    // M71 + M82/M89 · Per-slide image_source resolution
    // Priority order (Afshin's spec wins because he's the strict executor):
    //   1. Afshin's per-slide directive (afshinByN[slide.n].image_source)
    //   2. Tarrah's slide.image_source (the planner's choice)
    //   3. mergedSlots.image_source (legacy fallback)
    //   4. 'generated' default
    const afshinSlide = afshinByN.get(slide.n) || null;
    const slideImageSource =
        (afshinSlide && afshinSlide.image_source)
     || slide.image_source
     || (mergedSlots && mergedSlots.image_source)
     || 'generated';
    if (slideImageSource === 'unsplash') {
      const unsplash = require('./unsplash');
      if (!unsplash.hasKey()) {
        if (!firstError) firstError = `slide ${slide.n}: UNSPLASH_ACCESS_KEY not set`;
        renderedSlides.push({ n: slide.n, role: slide.role, error: 'UNSPLASH_ACCESS_KEY not set on server' });
        continue;
      }
      const qText =
          (afshinSlide && afshinSlide.unsplash_query)
       || slide.unsplash_query
       || mergedSlots.unsplash_query
       || run.topic;
      try {
        const u = await unsplash.quickPick({
          query: qText,
          orientation: slide.unsplash_orientation || 'squarish',
          topic: run.topic,
          language: lang || run.master_lang,
          topicTags: (run.topic || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 5),
        });
        if (!u.ok) {
          if (!firstError) firstError = `slide ${slide.n}: unsplash ${u.error}`;
          renderedSlides.push({ n: slide.n, role: slide.role, error: u.error });
          continue;
        }
        renderedSlides.push({
          n: slide.n,
          role: slide.role,
          slots: mergedSlots,
          url: u.url,
          key: u.r2_key,
          media_id: u.media_id,
          model: 'unsplash-stock',
          size: null,
          cost_usd: 0,
          model_label: 'Unsplash stock',
          prompt: `Unsplash search: "${qText}"`,
          _image_source: 'unsplash',
          _attribution: u.attribution_text,
          _photographer: u.photographer,
        });
        continue;
      } catch (e) {
        if (!firstError) firstError = `slide ${slide.n}: unsplash ${e.message}`;
        renderedSlides.push({ n: slide.n, role: slide.role, error: e.message });
        continue;
      }
    }

    // M82/M89 · When Afshin produced an explicit final_prompt for this
    // slide (carrying Tarrah's design_directive + brand_asset_placement
    // verbatim), use it as the base. Otherwise fall back to the template-
    // scaffold path. Either way, M70 enrichment runs on top.
    const baseBriefForSlide = (afshinSlide && afshinSlide.final_prompt)
      ? afshinSlide.final_prompt
      : slidePrompt;
    const enrichedPrompt = _buildEnrichedImagePrompt({
      baseBrief: baseBriefForSlide,
      source: { _carousel_slot: mergedSlots, _afshin_slide: afshinSlide },
      run, recipe, lang,
      designBriefs,
    });

    try {
      const r = await composeImage.generateCover({
        prompt: enrichedPrompt,
        runId: run.id,
        lang: lang || run.master_lang,
        recipeId: recipe && recipe.id,
        topic: `${run.topic} · slide ${slide.n}`,
        runOption,
        designSuggestion,
        recipeDefault,
        referenceUrls,
      });
      if (!r.ok) {
        if (!firstError) firstError = `slide ${slide.n}: ${r.error}`;
        renderedSlides.push({ n: slide.n, role: slide.role, error: r.error || 'unknown' });
        continue;
      }
      totalCost += Number(r.cost_usd) || 0;
      renderedSlides.push({
        n: slide.n,
        role: slide.role,
        slots: mergedSlots,
        url: r.url,
        key: r.key,
        media_id: r.mediaId,
        model: r.model,
        size: r.size,
        cost_usd: r.cost_usd,
        model_label: r.model_label || null,
        prompt: slidePrompt,
        _image_source: 'generated',
      });
    } catch (e) {
      if (!firstError) firstError = `slide ${slide.n}: ${e.message}`;
      renderedSlides.push({ n: slide.n, role: slide.role, error: e.message });
    }
  }

  const successes = renderedSlides.filter(s => s.url).length;
  if (successes === 0) {
    throw new Error(`carousel render failed for all ${slides.length} slides — ${firstError}`);
  }

  return {
    _renderer: 'image-cover',
    _carousel: true,
    lang: lang || run.master_lang,
    slide_count: slides.length,
    slides_rendered: successes,
    slides: renderedSlides,
    template: templateId,
    cost_usd: totalCost,
    agent: 'afshin',
    first_url: renderedSlides.find(s => s.url) ? renderedSlides.find(s => s.url).url : null,
    first_key: renderedSlides.find(s => s.url) ? renderedSlides.find(s => s.url).key : null,
    partial_failure: firstError && successes < slides.length ? firstError : null,
  };
}

// ── M70 · Enriched image-gen prompt builder ──────────────────────────
// Composes the prompt sent to gpt-image-2 / Recraft / etc with explicit
// structured blocks. The model sees structured context, not just a 60-160
// word art-direction paragraph.
//
// Six blocks (only included when applicable):
//   1. Afshin's final_prompt              — art direction
//   2. Carousel slot block                — when Tarrah's spec exists; lists
//                                            title/subtitle/country_pill etc
//                                            verbatim per slide
//   3. Brand exemplar context             — descriptive metadata, not just URLs
//                                            (style/layout/palette/typography
//                                            from visual_style_profile.json)
//   4. Brand color hex block              — explicit hexes called out
//   5. Language direction block           — RTL + font + numerals when fa/ar
//   6. Negative-prompt block              — clichéd dental imagery, etc
function _buildEnrichedImagePrompt({ baseBrief, source, run, recipe, lang, designBriefs }) {
  const blocks = [];
  const language = lang || (run && run.master_lang) || 'en';

  // Block 1 · Afshin's art direction (the heart of the prompt)
  if (baseBrief && baseBrief.trim()) {
    blocks.push(baseBrief.trim());
  }

  // Block 2 · Carousel slot block — when Tarrah's spec is present, the
  // image renderer is processing a SINGLE slide; spell out the slot values
  // verbatim so the model renders the exact text Tarrah specified.
  // (For the multi-slide path, _renderCarousel passes per-slide context;
  // this block also fires when source carries _carousel_slot for that slide.)
  const slot = source && (source._carousel_slot || source.slot);
  if (slot && typeof slot === 'object') {
    const lines = ['', '## RENDER VERBATIM (carousel slot values — do not paraphrase or translate)'];
    for (const [k, v] of Object.entries(slot)) {
      if (v == null || v === '') continue;
      if (Array.isArray(v)) {
        lines.push(`  ${k}: ${v.map(x => `"${x}"`).join(', ')}`);
      } else {
        lines.push(`  ${k}: "${v}"`);
      }
    }
    blocks.push(lines.join('\n'));
  }

  // Block 3 · Brand exemplar context (descriptive — the URLs go to the
  // model as image attachments separately, but the model also benefits
  // from knowing what those references are).
  if (Array.isArray(designBriefs) && designBriefs.length) {
    const lines = ['', '## BRAND VISUAL REFERENCES (style anchors — match these, attached as input images)'];
    designBriefs.forEach((d, idx) => {
      // Each exemplar's body is multiline metadata. Take the first 6 lines
      // (Style/Layout/Subject/Dominant colors/Logo/Motifs) and skip the URL.
      const meta = String(d.body || '')
        .split('\n')
        .filter(l => !l.startsWith('URL:') && !l.startsWith('('))
        .slice(0, 6)
        .map(l => '    ' + l.trim())
        .filter(Boolean)
        .join('\n');
      if (meta) {
        lines.push(`  Reference #${idx + 1}:`);
        lines.push(meta);
      }
    });
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  // Block 4 · Brand color hex callouts (always — the brand is anchored
  // in 100% of the archive on this teal).
  blocks.push([
    '',
    '## BRAND COLORS (use these exact hex values)',
    '  Primary teal   #13a597   — logo, accents, CTA, key word highlights',
    '  Navy block     #1c3a52   — analytical mood, fact-heavy posts',
    '  Urgent red     #cb3a3a   — USA-themed posts',
    '  Germany green  #1f3d22   — Germany-themed posts',
    '  Earth/brown    #bca175   — occasion / cultural posts',
    '  Orange         #ff7a1a   — DEADLINE pressure ONLY',
    '  Surface        #ffffff or #f0f1ee',
  ].join('\n'));

  // Block 5 · Language direction (when Persian/Arabic is involved)
  if (language === 'fa' || language === 'ar') {
    blocks.push([
      '',
      `## TEXT RENDERING (language: ${language})`,
      `  Direction:  right-to-left (RTL).`,
      `  Typeface:   bold sans-serif Persian/Arabic-supporting (Vazirmatn,`,
      `              IRANSans, or equivalent). Latin wordmarks (RXAPPLY)`,
      `              stay in Latin font.`,
      `  Numerals:   Persian numerals (۰۱۲۳۴۵۶۷۸۹) for Persian text,`,
      `              not Latin (0-9).`,
      `  Spacing:    Persian text needs slightly more line-height than Latin.`,
    ].join('\n'));
  }

  // Block 6 · Negative-prompt list (brand never-do, from brand_intelligence)
  blocks.push([
    '',
    '## DO NOT INCLUDE',
    '  • Clichéd dental imagery (toothbrushes, pills, white-coat-stock-photo)',
    '  • Generic stock photos with no brand specificity',
    '  • English text on a Persian-only design (or vice versa)',
    '  • Marketing-buzzword superlatives in any visible text',
    '  • Fake regulator names or invented credentials',
    '  • More than one logo per slide',
  ].join('\n'));

  return blocks.join('\n\n');
}

async function imageCover({ source, run, recipe, lang }) {
  const f = _fields(source);

  // M65 · Multi-slide carousel branch. When Tarrah produced a slide spec
  // upstream, render ONE image per slide using the per-template scaffold
  // + slot values from the spec. Each slide gets its own gpt-image-2 call
  // so on-image text is exactly what Tarrah specified, and brand-exemplar
  // reference images condition the style consistently across slides.
  const carouselSpec = source && source._carousel_spec;
  if (carouselSpec && Array.isArray(carouselSpec.slides) && carouselSpec.slides.length > 0) {
    return await _renderCarousel({ source, carouselSpec, run, recipe, lang });
  }

  // M64 · Stock-photo path — when Afshin's design output sets
  // `image_source: "unsplash"`, fetch a real photo from Unsplash instead
  // of generating from a model. Photographer attribution is stored on
  // the resulting media_library row per Unsplash terms.
  const imageSource = (source && source.image_source) || (f && f.image_source) || 'generated';
  if (imageSource === 'unsplash') {
    const unsplash = require('./unsplash');
    if (!unsplash.hasKey()) {
      throw new Error('image_source=unsplash requested but UNSPLASH_ACCESS_KEY is not set on the server');
    }
    const qText = (source && source.unsplash_query) || (f && f.unsplash_query) || run.topic;
    const orientation = (source && source.unsplash_orientation) || (f && f.unsplash_orientation) || null;
    const topicKw = require('./agent-training-retrieval').expandTopicTags(run.topic || '');
    const r = await unsplash.quickPick({
      query: qText,
      orientation,
      topic: run.topic,
      language: lang || run.master_lang,
      topicTags: topicKw,
    });
    if (!r.ok) throw new Error(`Unsplash failed: ${r.error}`);
    return {
      _renderer: 'image-cover',
      _image_source: 'unsplash',         // M71 · canonical telemetry field
      _source: 'unsplash',                // backwards-compat alias
      _attribution: r.attribution_text,
      _photographer: r.photographer,
      lang: lang || run.master_lang,
      url: r.url,
      key: r.r2_key,
      media_id: r.media_id,
      model: 'unsplash-stock',
      size: null,
      cost_usd: 0,
      attribution: r.attribution_text,
      photographer: r.photographer,
      design_context: source && (source.style || source.composition) ? {
        style: source.style || null,
        composition: source.composition || null,
        color_palette: source.color_palette || null,
        mood: source.mood || null,
      } : null,
    };
  }

  // Source-priority for the final image prompt:
  //   1. Afshin's design stage final_prompt (M37 — full art direction)
  //   2. Avang's adapt fields design_brief / image_brief / design_prompt
  //   3. Synthesised fallback from the topic
  let brief =
        (source && source.final_prompt)        // Afshin's design stage output (top-level)
     || f.final_prompt                          // … if wrapped under fields
     || f.design_brief
     || f.image_brief
     || f.design_prompt
     || (source && source.design_brief)
     || (source && source.image_brief)
     || (source && source.design_prompt)
     || '';

  // M56 batch B + M70 · Retrieve top-3 brand visual references whose
  // topic_tags best match this run. Their URLs go to the provider as
  // attached input images (where supported). Their descriptive metadata
  // (style/layout/palette) is woven into the enriched prompt by
  // _buildEnrichedImagePrompt below.
  let referenceUrls = [];
  let designBriefs = [];
  try {
    const trainingRetrieval = require('./agent-training-retrieval');
    const topicKw = require('./agent-training-retrieval').expandTopicTags(run.topic || '');
    const packet = await trainingRetrieval.getTrainingPacket({
      agent: 'afshin', stageName: 'design',
      platform: recipe && recipe.id, language: lang || run.master_lang,
      topicTags: [...topicKw, 'visual-reference'],
    });
    designBriefs = (packet.exemplars || []).filter(e => e.kind === 'design_brief').slice(0, 3);
    for (const d of designBriefs) {
      const m = String(d.body || '').match(/URL:\s*(\S+)/);
      if (m) referenceUrls.push(m[1]);
    }
  } catch (_) { /* non-fatal — fall back to text-only brief */ }

  // If neither Afshin nor Avang produced a brief, build one from the topic
  // + the format hint so we always render *something*.
  if (!brief && run && run.topic) {
    const formatHint = recipe && recipe.label ? recipe.label : 'social post';
    brief = `Square cover image for a ${formatHint} about: ${run.topic}.
Brand: RxApply (helping internationally trained dentists migrate). Editorial
illustration style, clean composition, minimal text overlay, no logo.`;
  }
  if (!brief.trim()) throw new Error('no design brief available for image stage');

  // M70 · Compose the enriched prompt (carousel slot + exemplar context +
  // hex colors + language direction + negative list). gpt-image-2 sees
  // structured context, not just narrative.
  brief = _buildEnrichedImagePrompt({
    baseBrief: brief,
    source, run, recipe, lang,
    designBriefs,
  });

  // M38 · model selection signals (priority handled inside generateCover):
  //   1. Founder's per-run UI override
  //   2. Afshin's recommended_model from the design stage
  //   3. Recipe's default_image_model
  const runOption = (run.options && run.options.image_model) || null;
  const designSuggestion = (source && source.recommended_model) || null;
  const recipeDefault = (recipe && recipe.default_image_model) || null;

  const r = await composeImage.generateCover({
    prompt: brief,
    runId: run.id,
    lang: lang || run.master_lang,
    recipeId: recipe && recipe.id,
    topic: run.topic,
    runOption,
    designSuggestion,
    recipeDefault,
    referenceUrls,                             // M56 batch B — passed through to providers that support image refs
  });
  if (!r.ok) throw new Error(r.error || 'image generation failed');

  // Surface what Afshin contributed (when present) so the preview pane
  // can show his style/palette/composition picks alongside the rendered image.
  const designContext = (source && (source.style || source.composition || source.color_palette))
    ? {
        style: source.style || null,
        composition: source.composition || null,
        color_palette: source.color_palette || null,
        mood: source.mood || null,
        brand_visual_refs: source.brand_visual_refs || null,
      }
    : null;

  return {
    _renderer: 'image-cover',
    _image_source: 'generated',        // M71 · explicit telemetry
    lang: lang || run.master_lang,
    url: r.url,
    key: r.key,
    media_id: r.mediaId,
    model: r.model,
    size: r.size,
    cost_usd: r.cost_usd,
    agent: 'afshin',                  // attribution for the UI cost annotation
    agent_run_id: r.agent_run_id,
    prompt: brief,
    afshin_direction: designContext,  // shown in the preview when present
    model_label: r.model_label || null,
  };
}

module.exports = {
  _default,
  // M26
  'email-html':  emailHtml,
  'seo-article': seoArticle,
  'telegram':    telegram,
  // M27
  'facebook':    facebook,
  'x-thread':    xThread,
  // M28
  'ig':          instagram,
  // M32
  'image-cover': imageCover,
};
