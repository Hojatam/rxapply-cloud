-- ============================================================================
-- Brand profile (Layer 3)
--
-- One central jsonb that every agent's runtime prompt injects from. Edit the
-- brand profile once → all agents (compose-ig, afshin, future per-step Compose
-- stages) automatically obey the new colors, voice, and rules on their next
-- invocation. No code redeploy needed.
-- ============================================================================

ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS brand_profile jsonb DEFAULT '{}'::jsonb;

-- Seed the default profile if the column is empty. The shape is defined in
-- cowork-proxy/brand-profile.js DEFAULT_PROFILE; keep them in sync.
UPDATE dashboard_settings
   SET brand_profile = '{
     "name": "RxApply",
     "tagline": "We help internationally-trained dentists migrate, calmly.",
     "primary_color": "#4f46e5",
     "secondary_colors": ["#0f172a", "#f8fafc"],
     "typography": "Inter (EN) / Vazirmatn (FA, AR)",
     "voice_rules": [
       "Hype-free. We are a guide, not a hype machine. Never use exclamation marks at the end of sentences.",
       "Specific over general: real numbers, named exams, named regulators (NDEB, ADC, GDC, DHA, ZAB, BC bridging) — never generalities.",
       "Inclusive: never mock origin countries or systems.",
       "Always cite real institutions by name. Never fake stats, prices, or URLs.",
       "Soft CTAs only (\"DM us for the full checklist\"); never demanding (\"Sign up NOW\").",
       "First-person plural (\"we\") when speaking as the brand."
     ],
     "always_include": [
       "A soft CTA (e.g. \"DM us for the full checklist\")",
       "Regulatory disclaimer when discussing licensing routes (we never give regulated advice)"
     ],
     "never_include": [
       "guaranteed pass / guaranteed visa",
       "easy money / get rich",
       "absolute claims about timelines without ranges",
       "specific immigration legal advice (refer to RCIC/OISC/MARA partners instead)"
     ],
     "visual_rules": [
       "Geometric, type-led compositions; lots of negative space",
       "No clichéd dental imagery (no toothbrushes, no smile montages, no clipart)",
       "One simple motif at most per design",
       "No embedded text in renders unless explicitly requested",
       "RTL-aware for FA and AR layouts"
     ],
     "founder_name": "Dr. Hojat",
     "audience": "Internationally-trained dentists 28–45 considering practising abroad in 6–36 months",
     "example_captions": []
   }'::jsonb
 WHERE id = 1
   AND (brand_profile IS NULL OR brand_profile = '{}'::jsonb);

DO $$
DECLARE has_col int; has_seed int;
BEGIN
  SELECT COUNT(*) INTO has_col FROM information_schema.columns
   WHERE table_name='dashboard_settings' AND column_name='brand_profile';
  SELECT CASE WHEN brand_profile ? 'name' THEN 1 ELSE 0 END INTO has_seed
   FROM dashboard_settings WHERE id = 1;
  RAISE NOTICE 'brand_profile migration: column present=% seeded=%', has_col, has_seed;
END $$;
