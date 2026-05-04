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
--
-- M77 fix · The legacy F6 `pipelines` table (uuid id + graph_data) collides
-- with the schema we want. Rename it to `pipeline_runner_pipelines` BEFORE
-- creating the new tables so the FK from pipeline_versions.pipeline_id (text)
-- to pipelines.id (text) actually works. The legacy table's data is preserved
-- under the new name; pipeline-runner.js reads from the new name.
-- ============================================================================

BEGIN;

-- ── Step 1 · Move legacy F6 table out of the way (idempotent) ────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'pipelines' AND column_name = 'graph_data')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_name = 'pipeline_runner_pipelines')
  THEN
    EXECUTE 'ALTER TABLE pipelines RENAME TO pipeline_runner_pipelines';
    RAISE NOTICE 'Renamed legacy pipelines → pipeline_runner_pipelines';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pipelines_updated') THEN
    EXECUTE 'ALTER INDEX idx_pipelines_updated RENAME TO idx_pipeline_runner_pipelines_updated';
  END IF;
END $$;

-- ── Step 2 · New compose-pipeline tables ─────────────────────────────
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
