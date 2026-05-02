// cowork-proxy/brand-profile.js
// =====================================================================
// Single source of truth for the RxApply brand. Stored in
// dashboard_settings.brand_profile jsonb. Every agent that talks to an
// LLM injects renderAsPromptBlock() into its system prompt — change the
// profile once, propagation is automatic on next agent run.
//
// Public API:
//   get()                   → Profile object (always returns valid shape)
//   set(profile)            → write
//   renderAsPromptBlock()   → "BRAND CONTEXT\n---\n..." string for prompt injection
// =====================================================================

const { spawnSync } = require('child_process');

const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';

// Default profile — used when the DB row is empty AND as the fallback
// shape in renderAsPromptBlock. Should match the seed in the migration.
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

// Pass a Buffer as input — defends against the Windows cp1252 stdin
// corruption documented in compose-ig + agent-models.
function _psql(sql) {
  const r = spawnSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: Buffer.from(sql, 'utf-8') });
  if (r.status !== 0) {
    const err = (r.stderr || Buffer.alloc(0)).toString('utf-8');
    throw new Error(`psql (${r.status}): ${err.slice(0, 300)}`);
  }
  return (r.stdout || Buffer.alloc(0)).toString('utf-8').trim();
}

// In-memory cache. Refresh after every set().
let _cache = null;
let _cacheStamp = 0;
const CACHE_TTL_MS = 60_000;  // 1 min — long enough to skip DB on every call

function get() {
  const now = Date.now();
  if (_cache && (now - _cacheStamp) < CACHE_TTL_MS) return _cache;
  try {
    const raw = _psql(`SELECT brand_profile FROM dashboard_settings WHERE id = 1;`);
    const parsed = raw ? JSON.parse(raw) : {};
    // Merge over defaults so missing fields don't break callers.
    _cache = { ...DEFAULT_PROFILE, ...parsed };
    _cacheStamp = now;
    return _cache;
  } catch (_) {
    return DEFAULT_PROFILE;
  }
}

function set(profile) {
  if (!profile || typeof profile !== 'object') {
    return { ok: false, error: 'profile must be an object' };
  }
  // Normalise: strip unknown keys, ensure arrays are arrays.
  const KEYS = Object.keys(DEFAULT_PROFILE);
  const ARRAY_KEYS = new Set(['secondary_colors','voice_rules','always_include','never_include','visual_rules','example_captions']);
  const clean = {};
  for (const k of KEYS) {
    if (profile[k] === undefined) continue;
    if (ARRAY_KEYS.has(k)) {
      clean[k] = Array.isArray(profile[k]) ? profile[k].filter(s => typeof s === 'string') : [];
    } else if (typeof profile[k] === 'string') {
      clean[k] = profile[k];
    } else {
      // skip silently — wrong type
    }
  }
  try {
    const sql = `UPDATE dashboard_settings
                    SET brand_profile = '${JSON.stringify(clean).replace(/'/g, "''")}'::jsonb,
                        updated_at = NOW()
                  WHERE id = 1;`;
    _psql(sql);
    _cache = null;  // invalidate
    return { ok: true, profile: get() };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

// Render the brand profile as a prompt block. Caller embeds this inside their
// own system prompt (compose-ig, afshin, etc.). Plain text, no markdown fences.
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

module.exports = { get, set, renderAsPromptBlock, DEFAULT_PROFILE };
