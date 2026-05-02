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

const DEFAULT_PROFILE = {
  name: 'RxApply',
  tagline: 'We help internationally-trained dentists migrate, calmly.',
  primary_color: '#4f46e5',
  secondary_colors: ['#0f172a', '#f8fafc'],
  typography: 'Inter (EN) / Vazirmatn (FA, AR)',
  voice_rules: [
    'Hype-free. We are a guide, not a hype machine.',
    'Specific over general: real numbers, named regulators.',
    'Inclusive — never mock origin countries or systems.',
    'Always cite real institutions by name. Never fake stats.',
  ],
  always_include: ['A soft CTA'],
  never_include: ['guaranteed claims', 'specific immigration legal advice'],
  visual_rules: ['Geometric, type-led, lots of negative space'],
  founder_name: 'Dr. Hojat',
  audience: 'Internationally-trained dentists',
  example_captions: [],
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
  const ARRAY_KEYS = new Set(['secondary_colors','voice_rules','always_include','never_include','visual_rules','example_captions']);
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
  lines.push('=== END BRAND CONTEXT ===');
  return lines.join('\n');
}

module.exports = { get, set, refresh, renderAsPromptBlock, DEFAULT_PROFILE };
