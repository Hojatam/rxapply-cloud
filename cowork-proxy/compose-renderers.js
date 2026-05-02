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
};
