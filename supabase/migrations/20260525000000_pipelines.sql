-- ============================================================================
-- M72A · Pipelines stored in DB
--
-- Replaces the JSON files in compose-recipes/ with a `pipelines` table so
-- the founder can edit pipelines from the dashboard without redeploys.
-- Each save creates a `pipeline_versions` row so history is preserved.
--
-- Schema is intentionally minimal for M72A — the `definition` JSONB carries
-- the full recipe shape (stages, options_schema, translate, length_target_words,
-- etc) verbatim. M72B (Pipeline tab v2) will extend the definition with graph
-- fields (edges_out, edges_refine) without needing a schema change.
--
-- Migration is idempotent — re-running on an already-seeded DB is safe.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS pipelines (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  category    text NOT NULL DEFAULT 'compose',  -- 'compose' | 'dm' | 'fanout' | ...
  definition  jsonb NOT NULL,                    -- the full recipe object
  version     int NOT NULL DEFAULT 1,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id   text NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version       int NOT NULL,
  definition    jsonb NOT NULL,
  changed_by    text,
  change_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, version)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_versions_pid_v
  ON pipeline_versions (pipeline_id, version DESC);

-- ── Seed: import the 6 existing JSON recipes verbatim. The migration runner
--    on the Node side seeds these from disk if the table is empty (so we
--    don't have to embed multi-KB JSON literals in this SQL file). The
--    runner's seed step lives in cowork-proxy/pipelines.js#seedFromFiles().
-- ──

DO $$
BEGIN
  RAISE NOTICE 'M72A pipelines schema applied. Run pipelines.seedFromFiles() on Node startup to import compose-recipes/*.json into the table.';
END $$;

COMMIT;
