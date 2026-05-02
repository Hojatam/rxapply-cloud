-- ============================================================================
-- Phase K3 · Training & Rating
--
-- Founder-in-the-loop feedback. Three input shapes, one table:
--
--   rating       ★1–5 (or thumbs ↑/↓ stored as 5/1) on a past run + optional note
--   correction   "this output was wrong; here's the right version" → auto-
--                promotes to procedural memory (tagged 'correction')
--   example      "here's how I want this to read" → auto-promotes to
--                semantic memory (tagged 'exemplar')
--
-- Why one table: queries for "agent quality this week" need to see all three
-- in one stream. Per-row `kind` distinguishes them.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS agent_evals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rating', 'correction', 'example')),
  -- For ratings + corrections: the run being judged. Null for standalone
  -- examples that don't reference a past run.
  run_id uuid,
  -- For ratings: 1..5 (1=bad, 5=excellent). Null for non-ratings.
  score int CHECK (score IS NULL OR (score BETWEEN 1 AND 5)),
  -- One of: 'overall' | 'voice' | 'accuracy' | 'specificity' (extensible).
  dimension text DEFAULT 'overall',
  -- Free-text note explaining the rating, the correction, or the example.
  note text,
  -- For corrections: the original (truncated) and the corrected version.
  -- For examples: corrected_output holds the example body.
  original_output text,
  corrected_output text,
  -- Memory IDs that this eval auto-promoted (so we can trace back).
  memory_ids uuid[] DEFAULT '{}',
  -- Tags propagate to the memory row.
  tags text[] DEFAULT '{}',
  rated_by text DEFAULT 'founder',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evals_agent_recent
  ON agent_evals (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evals_kind
  ON agent_evals (kind, agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evals_run
  ON agent_evals (run_id) WHERE run_id IS NOT NULL;

DO $$
DECLARE row_count int;
BEGIN
  SELECT COUNT(*) INTO row_count FROM agent_evals;
  RAISE NOTICE 'K3 migration: agent_evals table present, current rows=%', row_count;
END $$;

COMMIT;
