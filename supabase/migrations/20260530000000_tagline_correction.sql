-- ============================================================================
-- M98 · Update production tagline to the founder-confirmed value
--
-- Previous default was 'We help internationally-trained dentists migrate, calmly.'
-- (placeholder set during V1). Founder confirmed real tagline: 'RxApply,
-- Elucidates The Road' (long form) or just 'Elucidates The Road' (short).
-- ============================================================================

BEGIN;

UPDATE dashboard_settings
   SET brand_profile = brand_profile
                       || '{"tagline": "RxApply, Elucidates The Road"}'::jsonb
                       || '{"tagline_short": "Elucidates The Road"}'::jsonb,
       updated_at = NOW()
 WHERE id = 1;

DO $$
BEGIN
  RAISE NOTICE 'M98 · brand_profile.tagline updated to founder-confirmed value.';
END $$;

COMMIT;
