-- ============================================================================
-- M97 · Update production brand_profile to match the actual Brand Kit
--
-- The previous default in brand-profile.js had primary_color = '#4f46e5'
-- (indigo) which was wrong. The Brand Kit's SVG pattern files use
-- '#00a69c' (teal) and the icon.png logo confirms it. The brand archive
-- analyzer derived '#13a597' (also teal, slightly different shade).
-- The Brand Kit value '#00a69c' is the canonical truth.
--
-- This migration patches the production brand_profile JSONB to:
--   - primary_color: #00a69c (teal)
--   - typography: Peyda (FA) / Inter (EN)
--   - logo_url: /static/brand-assets/logo.png
--   - pattern_url: /static/brand-assets/pattern.svg
--   - font_family_persian: Peyda
--   - font_family_latin: Inter
--
-- Idempotent: only applies if primary_color is currently the wrong indigo.
-- ============================================================================

BEGIN;

UPDATE dashboard_settings
   SET brand_profile = brand_profile
                       || '{"primary_color": "#00a69c"}'::jsonb
                       || '{"typography": "Peyda (FA) / Inter (EN)"}'::jsonb
                       || '{"font_family_persian": "Peyda"}'::jsonb
                       || '{"font_family_latin": "Inter"}'::jsonb
                       || '{"logo_url": "/static/brand-assets/logo.png"}'::jsonb
                       || '{"logo_with_tagline_url": "/static/brand-assets/logo-with-tagline.png"}'::jsonb
                       || '{"pattern_url": "/static/brand-assets/pattern.svg"}'::jsonb
                       || '{"favicon_url": "/static/brand-assets/favicon.png"}'::jsonb,
       updated_at = NOW()
 WHERE id = 1
   AND COALESCE(brand_profile->>'primary_color', '') IN ('#4f46e5', '');

DO $$
BEGIN
  RAISE NOTICE 'M97 · brand_profile updated with Brand Kit values (color + Peyda + asset URLs).';
END $$;

COMMIT;
