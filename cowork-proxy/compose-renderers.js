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

// Stubs for M27 + M28 — replaced by full implementations later.
function _stub(name, source, run, recipe, lang) {
  return {
    _renderer: name,
    _format_warning: `Renderer "${name}" is a stub; full implementation lands in M27/M28.`,
    lang: lang || run.master_lang,
    fields: _fields(source),
  };
}

module.exports = {
  _default,
  // M26
  'email-html':  emailHtml,
  'seo-article': seoArticle,
  'telegram':    telegram,
  // M27 stubs
  'facebook':    ({ source, run, recipe, lang }) => _stub('facebook', source, run, recipe, lang),
  'x-thread':    ({ source, run, recipe, lang }) => _stub('x-thread', source, run, recipe, lang),
  // M28 stub (IG port)
  'ig':          ({ source, run, recipe, lang }) => _stub('ig', source, run, recipe, lang),
};
