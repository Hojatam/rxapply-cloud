// cowork-proxy/brand-profile.js
// =====================================================================
// Single source of truth for the RxApply brand. Stored in
// dashboard_settings.brand_profile jsonb.  [cloud build]
//
// Public API:
//   get()                 → Profile object (sync; cached)
//   set(profile)          → write (async)
//   renderAsPromptBlock() → "BRAND CONTEXT\n---\n..." (sync; uses cache)
//   refresh()             → force reload cache (await on boot)
//
// Sync surface preserved because every LLM call hits this on its
// hot path. Cache is loaded once on boot and refreshed after each set().
// =====================================================================

const { query, queryValue, q } = require('./db');

// M97 · Defaults updated to match the actual Brand Kit.
//   primary_color #00a69c — sourced from the SVG pattern files in Brand Kit
//   typography Peyda      — from BrandBook
//   logo_url + pattern_url — served by the proxy at /static/brand-assets/
//
// Earlier defaults had #4f46e5 (indigo) which contradicted the brand
// archive's actual color. Now brand profile + brand_intelligence + Tarrah
// + Afshin + the actual logo file all agree on #00a69c teal.
const DEFAULT_PROFILE = {
  name: 'RxApply',
  tagline: 'RxApply, Elucidates The Road',
  tagline_short: 'Elucidates The Road',
  primary_color: '#00a69c',
  secondary_colors: ['#1c3a52', '#f0f1ee'],
  typography: 'Peyda (FA) / Inter (EN)',
  font_family_persian: 'Peyda',
  font_family_latin:   'Inter',
  logo_url: '/static/brand-assets/logo.png',
  logo_with_tagline_url: '/static/brand-assets/logo-with-tagline.png',
  pattern_url: '/static/brand-assets/pattern.svg',
  favicon_url: '/static/brand-assets/favicon.png',
  voice_rules: [
    'Hype-free. We are a guide, not a hype machine.',
    'Specific over general: real numbers, named regulators.',
    'Inclusive — never mock origin countries or systems.',
    'Always cite real institutions by name. Never fake stats.',
  ],
  always_include: ['A soft CTA'],
  never_include: ['guaranteed claims', 'specific immigration legal advice'],
  visual_rules: [
    'Brand teal #00a69c on logo, accents, key word highlights',
    'Geometric, type-led, lots of negative space',
    'Persian text in Peyda (bold for headings, medium for body)',
    'Logo placement variable — integrated as design element, not corner watermark',
  ],
  founder_name: 'Dr. Hojat',
  audience: 'Internationally-trained dentists',
  example_captions: [],
  // M119 · IG-v2 emoji palette. Post-planner picks 2–4 emojis from this
  // palette per caption to fit the brand's professional + warm tone.
  // Founder editable from Brand tab. Keep it small + on-brand; resist
  // adding random emoji that would dilute the voice.
  emoji_palette: ['🦷', '🌍', '✈️', '📋', '✓', '🏥', '⚕️', '📍', '📌', '💼'],
  // M119 · IG-v2 design templates Afshin can choose from. Founder can
  // disable any template by removing its slug from this array — Afshin
  // will skip it during template selection.
  design_templates_enabled: [
    'type-led', 'data-card', 'photo-hero', 'quote-card',
    'split-frame', 'document-mock', 'flag-overlay', 'cta-card',
  ],
};

let _cache = null;
let _cacheStamp = 0;
const CACHE_TTL_MS = 60_000;

async function refresh() {
  try {
    const raw = await queryValue(`SELECT brand_profile FROM dashboard_settings WHERE id = 1;`);
    const parsed = raw ? JSON.parse(raw) : {};
    _cache = { ...DEFAULT_PROFILE, ...parsed };
    _cacheStamp = Date.now();
  } catch (_) {
    _cache = DEFAULT_PROFILE;
  }
  return _cache;
}

function get() {
  if (_cache && (Date.now() - _cacheStamp) < CACHE_TTL_MS) return _cache;
  // Background-refresh; return whatever we have. On the very first call
  // before refresh() resolves, returns DEFAULT_PROFILE which is safe.
  refresh().catch(() => {});
  return _cache || DEFAULT_PROFILE;
}

async function set(profile) {
  if (!profile || typeof profile !== 'object') {
    return { ok: false, error: 'profile must be an object' };
  }
  const KEYS = Object.keys(DEFAULT_PROFILE);
  // M119 · Add the new array keys so set() preserves them on save.
  const ARRAY_KEYS = new Set([
    'secondary_colors','voice_rules','always_include','never_include','visual_rules','example_captions',
    'emoji_palette','design_templates_enabled',
  ]);
  const clean = {};
  for (const k of KEYS) {
    if (profile[k] === undefined) continue;
    if (ARRAY_KEYS.has(k)) {
      clean[k] = Array.isArray(profile[k]) ? profile[k].filter(s => typeof s === 'string') : [];
    } else if (typeof profile[k] === 'string') {
      clean[k] = profile[k];
    }
  }
  try {
    await query(`UPDATE dashboard_settings
                    SET brand_profile = ${q(JSON.stringify(clean))}::jsonb,
                        updated_at = NOW()
                  WHERE id = 1;`);
    await refresh();
    return { ok: true, profile: _cache };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

function renderAsPromptBlock() {
  const p = get();
  const lines = [];
  lines.push('=== BRAND CONTEXT — strictly enforce on every output ===');
  lines.push(`Brand: ${p.name}`);
  if (p.tagline) lines.push(`Tagline: ${p.tagline}`);
  if (p.audience) lines.push(`Audience: ${p.audience}`);
  if (p.founder_name) lines.push(`Founder: ${p.founder_name}`);
  lines.push('');
  lines.push(`Primary color: ${p.primary_color}`);
  if (p.secondary_colors && p.secondary_colors.length)
    lines.push(`Secondary colors: ${p.secondary_colors.join(', ')}`);
  if (p.typography) lines.push(`Typography: ${p.typography}`);
  if (p.font_family_persian) lines.push(`Persian font: ${p.font_family_persian} (bold for headings, medium for body)`);
  if (p.font_family_latin) lines.push(`Latin font: ${p.font_family_latin}`);
  // M97 · Brand asset URLs — referenced by image-gen pipeline
  if (p.logo_url) lines.push(`Logo asset: ${p.logo_url} (teal R-arrow on white square — attached to gpt-image-2 calls)`);
  if (p.pattern_url) lines.push(`Pattern asset: ${p.pattern_url} (geometric line motif — TL corner placement)`);
  lines.push('');
  if (p.voice_rules && p.voice_rules.length) {
    lines.push('VOICE — ALL these rules apply to every word of output:');
    p.voice_rules.forEach(r => lines.push(`  - ${r}`));
    lines.push('');
  }
  if (p.always_include && p.always_include.length) {
    lines.push('ALWAYS include in every post:');
    p.always_include.forEach(r => lines.push(`  - ${r}`));
    lines.push('');
  }
  if (p.never_include && p.never_include.length) {
    lines.push('NEVER include in any output (hard ban):');
    p.never_include.forEach(r => lines.push(`  - ${r}`));
    lines.push('');
  }
  if (p.visual_rules && p.visual_rules.length) {
    lines.push('VISUAL rules (for designs / image prompts):');
    p.visual_rules.forEach(r => lines.push(`  - ${r}`));
    lines.push('');
  }
  if (p.example_captions && p.example_captions.length) {
    lines.push('EXAMPLE captions that exemplify the voice. Match this tone exactly:');
    p.example_captions.forEach((c, i) => {
      lines.push(`  [${i + 1}]`);
      String(c).split('\n').forEach(l => lines.push(`      ${l}`));
    });
    lines.push('');
  }
  // M119 · Emoji palette is surfaced so the post-plan agent picks from a
  // brand-curated set instead of generic emoji noise.
  if (p.emoji_palette && p.emoji_palette.length) {
    lines.push(`Brand emoji palette (pick 2–4 per caption from this set; never others): ${p.emoji_palette.join(' ')}`);
    lines.push('');
  }
  // Design templates list — surfaced for design-v2 so Afshin knows which
  // templates the founder has enabled. Listed inline; the full visual
  // recipes for each live in agents/afshin/SKILL.md.
  if (p.design_templates_enabled && p.design_templates_enabled.length) {
    lines.push(`Enabled design templates (Afshin must pick from this set): ${p.design_templates_enabled.join(', ')}`);
    lines.push('');
  }
  lines.push('=== END BRAND CONTEXT ===');
  return lines.join('\n');
}

module.exports = { get, set, refresh, renderAsPromptBlock, DEFAULT_PROFILE };
