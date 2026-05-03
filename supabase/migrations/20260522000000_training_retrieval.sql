-- ============================================================================
-- M56 · Topic-aware retrieval + promotion proposals
--
-- Adds:
-- - topic_tags column on brand_intelligence (was already on brand_exemplars)
-- - training_promotion_proposals table — librarian-agent surfaces these for
--   founder approval; never auto-applies.
-- ============================================================================

BEGIN;

ALTER TABLE brand_intelligence
  ADD COLUMN IF NOT EXISTS topic_tags text[] DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_brand_int_topics
  ON brand_intelligence USING gin (topic_tags) WHERE enabled = true;


-- Promotion proposals: librarian scan finds candidates; founder reviews in Inbox.
-- Never auto-promotes. Status flow: pending → approved | rejected.
CREATE TABLE IF NOT EXISTS training_promotion_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What's being promoted
  source_kind text NOT NULL CHECK (source_kind IN ('agent_memory', 'manual')),
  source_id uuid,                          -- agent_memory.id when source_kind='agent_memory'
  source_agent text,                        -- which agent owned this memory

  -- Proposal payload
  proposed_kind text NOT NULL,             -- target brand_intelligence.kind
  proposed_target_agent text,              -- null = global to all agents
  proposed_scope_platform text,
  proposed_scope_language text,
  proposed_topic_tags text[] DEFAULT '{}'::text[],
  proposed_rule_text text NOT NULL,
  proposed_importance int DEFAULT 4,

  -- Why it should be promoted
  promotion_reason text,                   -- 'recurring_correction' | 'high_score' | 'multi_agent' | 'founder'
  recurrence_count int DEFAULT 1,
  avg_rating numeric,
  detected_at timestamptz DEFAULT now(),

  -- Founder decision
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'auto-merged')),
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  resulting_intelligence_id uuid           -- the brand_intelligence row created on approve
);

CREATE INDEX IF NOT EXISTS idx_promotion_pending
  ON training_promotion_proposals (status, detected_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_promotion_recent
  ON training_promotion_proposals (detected_at DESC);


DO $$
DECLARE rc int;
BEGIN
  SELECT COUNT(*) INTO rc FROM brand_intelligence;
  RAISE NOTICE 'M56 retrieval schema applied; brand_intelligence rows=%', rc;
END $$;

COMMIT;
