-- ============================================================================
-- Phase K2 · Per-agent persistent memory
--
-- Three flavors of memory, one table:
--   episodic    past chats / runs   ("on May 1, founder asked about NDEB AFK
--                                     and was happy with the brief")
--   semantic    facts                ("RxApply primary color is #4f46e5",
--                                     "founder prefers em-dashes over hyphens")
--   procedural  preferences/rules    ("when writing FA captions, never start
--                                     with a verb")
--
-- Episodic is auto-written by the proxy at the end of every successful agent
-- call. Semantic + procedural come from founder training (Phase K3).
--
-- Retrieval (K2.2 agent-memory.js): top-K by importance × recency × tag-match.
-- No vector search yet — keyword + tag is sufficient for the agent volume
-- here (23 agents × 10-50 memories each at production scale). Add pgvector
-- if recall accuracy becomes the bottleneck.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  type text NOT NULL CHECK (type IN ('episodic', 'semantic', 'procedural')),
  content text NOT NULL,                -- the actual memory, plain text
  tags text[] DEFAULT '{}',              -- topical tags for filtered retrieval
  importance int DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
                                          -- 1=trivial, 5=must-always-show
  source text DEFAULT 'auto',            -- 'auto' | 'founder' | 'agent-self'
  source_run_id uuid,                    -- if auto: which agent_runs row produced it
  related_to text,                        -- free-text "what this is about"
  created_at timestamptz DEFAULT now(),
  last_used_at timestamptz DEFAULT now(),
  use_count int DEFAULT 0,
  -- After Phase K3 founder rates a run, the resulting memory may be tied
  -- back to that rating for surfacing in quality dashboards.
  rated_eval_id uuid
);

-- Hot-path indexes:
--   - agent + type + last_used_at — recall the K most recent of a kind
--   - tags GIN — for tag-filtered retrieval
--   - importance DESC + last_used_at DESC — top picks
CREATE INDEX IF NOT EXISTS idx_memory_agent_type_recent
  ON agent_memory (agent, type, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_agent_importance
  ON agent_memory (agent, importance DESC, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_tags
  ON agent_memory USING GIN (tags);

DO $$
DECLARE row_count int;
BEGIN
  SELECT COUNT(*) INTO row_count FROM agent_memory;
  RAISE NOTICE 'K2 migration: agent_memory table present, current rows=%', row_count;
END $$;

COMMIT;
