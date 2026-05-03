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
async function imageCover({ source, run, recipe, lang }) {
  const f = _fields(source);

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
    const topicKw = (run.topic || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 5);
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
      _source: 'unsplash',
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

  // M56 batch B · Retrieve top-3 brand visual references whose topic_tags
  // best match this run. We embed their URLs + descriptive metadata into
  // the prompt so the image model has a strong style anchor. When the
  // selected provider supports a literal reference-image API parameter
  // (Recraft V3, Ideogram V3, Flux Redux), compose-image.js can pass the
  // URLs through. For OpenAI / generic, the URLs serve as descriptive
  // anchors only.
  let referenceUrls = [];
  try {
    const trainingRetrieval = require('./agent-training-retrieval');
    const topicKw = (run.topic || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 5);
    const packet = await trainingRetrieval.getTrainingPacket({
      agent: 'afshin', stageName: 'design',
      platform: recipe && recipe.id, language: lang || run.master_lang,
      topicTags: [...topicKw, 'visual-reference'],
    });
    const designBriefs = (packet.exemplars || []).filter(e => e.kind === 'design_brief').slice(0, 3);
    if (designBriefs.length) {
      const refLines = ['', '--- BRAND VISUAL REFERENCES (style anchor — match these as closely as the topic allows) ---'];
      for (const d of designBriefs) {
        // Each exemplar's body has a `URL: ...` line we can extract
        const urlMatch = String(d.body || '').match(/URL:\s*(\S+)/);
        if (urlMatch) referenceUrls.push(urlMatch[1]);
        refLines.push(d.body);
        refLines.push('');
      }
      // Append the references to the brief so generation considers them
      brief = brief + refLines.join('\n');
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
