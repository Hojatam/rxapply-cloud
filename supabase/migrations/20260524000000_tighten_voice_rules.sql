-- ============================================================================
-- M66 · Tighten brand-voice rules: align importance with what actually matters
-- and resolve the contradiction between two length signals.
--
-- Issue: caption length cap rules (importance 4) competed with the engagement
-- insight rule "100+ word sweet spot" (importance 4) for the per-stage 3-rule
-- budget. These two contradict each other:
--   • Hard rule from 5-yr archive: target 38–75 words, p95 119
--   • Engagement insight from a tiny subsample (20 vs 151): "100+ words wins"
--
-- The hard rule must win. Promote length caps to importance 5 (they always
-- survive the budget cut). Demote the conflicting engagement insight to
-- importance 2 (it remains in the DB for reference but won't crowd out the
-- hard rule). Also add topic_tags so retrieval ranking can prefer them on
-- relevant runs.
-- ============================================================================

BEGIN;

-- 1. Promote caption-length-cap rules to importance 5 — these are the BRAND'S
--    actual data from 5 years; they must always survive the per-stage budget.
UPDATE brand_intelligence
   SET importance = 5,
       topic_tags = ARRAY['caption-length', 'voice-rule', 'core', 'always-applies']::text[],
       founder_edited = true,
       updated_at = NOW()
 WHERE rule_text LIKE '%caption length: target%'
   AND target_agent = 'sepehr'
   AND importance < 5;

-- 2. Demote the conflicting engagement-insight rule (tiny subsample, contradicts
--    the hard length cap). Stays in the DB for reference; won't crowd out
--    the hard rule from the 3-rule per-stage budget anymore.
UPDATE brand_intelligence
   SET importance = 2,
       founder_note = COALESCE(founder_note, '') ||
         ' [M66: demoted from imp=4 — contradicts hard length cap (38–75 mean 60). Subsample n=20 vs 151 too small to outweigh full-archive median.]',
       updated_at = NOW()
 WHERE rule_text LIKE '%Caption length sweet spot%very-long (100+w)%'
   AND importance > 2;

-- 3. Promote opener + CTA template rules (the actual signature voice tics) to
--    importance 5 for their highest-frequency platform pattern. These are the
--    things that make a draft feel "RxApply" vs "AI carousel #847":
--    • IG-FA "lead-with-bullet" opener (44.1% of posts)
--    • IG-FA "statement-close" CTA (72.6% of posts)
--    • TG-FA "lead-with-bullet" opener (47.1% of posts)
--    • TG-FA "statement-close" CTA (84.6% of posts)
UPDATE brand_intelligence
   SET importance = 5,
       topic_tags = ARRAY['voice-signature', 'voice-rule', 'core', 'always-applies']::text[],
       founder_edited = true,
       updated_at = NOW()
 WHERE target_agent = 'sepehr'
   AND ((kind = 'opener_template' AND rule_text LIKE '%lead-with-bullet%')
        OR (kind = 'cta_template'    AND rule_text LIKE '%statement-close%'))
   AND importance < 5;

-- 4. Promote IG-FA + TG-FA punctuation tics (the dot-line separator is in 95.8%
--    of IG-FA — it's the brand's strongest stylistic fingerprint).
UPDATE brand_intelligence
   SET importance = 5,
       topic_tags = ARRAY['voice-signature', 'voice-rule', 'core', 'always-applies']::text[],
       founder_edited = true,
       updated_at = NOW()
 WHERE target_agent = 'sepehr'
   AND kind = 'voice_rule'
   AND rule_text LIKE '%Punctuation tics%'
   AND importance < 5;

-- 5. Promote hashtag rules for Avang to importance 5 — the IG-FA range (2–8,
--    mean 6.9) and TG-FA "essentially zero" are tight conventions Avang
--    must respect.
UPDATE brand_intelligence
   SET importance = 5,
       topic_tags = ARRAY['hashtag-rule', 'voice-rule', 'core', 'always-applies']::text[],
       founder_edited = true,
       updated_at = NOW()
 WHERE target_agent = 'avang'
   AND rule_text LIKE '%hashtags%'
   AND importance < 5;

DO $$
DECLARE
  promoted INT;
  demoted INT;
BEGIN
  SELECT COUNT(*) INTO promoted FROM brand_intelligence WHERE importance = 5 AND founder_edited = true;
  SELECT COUNT(*) INTO demoted  FROM brand_intelligence WHERE importance = 2 AND founder_note LIKE '%M66%';
  RAISE NOTICE 'M66 voice-rule tightening: % rules at importance 5 (now); % rules demoted.', promoted, demoted;
END $$;

COMMIT;
