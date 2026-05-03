-- ============================================================================
-- M51 · Episodic memory decay + promotion
--
-- Adds support columns + indexes for the nightly maintenance pass.
-- ============================================================================

BEGIN;

-- Soft-archive flag — keeps the row but excludes it from prompt retrieval.
ALTER TABLE agent_memory
  ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;

-- Promotion score — incremented when a memory is referenced in an approved /
-- successful run. The maintenance pass uses it to decide whether an episodic
-- item graduates to semantic.
ALTER TABLE agent_memory
  ADD COLUMN IF NOT EXISTS promotion_score int DEFAULT 0;

-- Maintenance audit trail — what the nightly pass did, for transparency.
CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz DEFAULT now(),
  decay_threshold_days int,
  promote_score_min int,
  decayed_count int DEFAULT 0,
  promoted_count int DEFAULT 0,
  total_episodic_before int,
  total_semantic_before int,
  total_episodic_after int,
  total_semantic_after int,
  details jsonb
);

CREATE INDEX IF NOT EXISTS idx_memory_archived
  ON agent_memory (agent, type, archived) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_memory_promotion
  ON agent_memory (agent, type, promotion_score DESC) WHERE archived = false;

DO $$
BEGIN
  RAISE NOTICE 'M51 memory-maintenance schema applied.';
END $$;

COMMIT;
