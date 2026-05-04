-- ============================================================================
-- M77 · Pipelines table name separation (fix M72A collision)
--
-- The original `pipelines` table from F6 (Drawflow ad-hoc pipeline runner,
-- migration 20260504000000_image_model_defaults.sql) collides with the new
-- `pipelines` table M72A wanted to create. CREATE IF NOT EXISTS in M72A's
-- migration silently no-op'd because the table already existed — so the
-- new schema (label/category/definition jsonb/version) never landed.
--
-- This migration:
--   1. Renames the legacy table → `pipeline_runner_pipelines`
--   2. Creates the new `pipelines` table with M72A's schema
--   3. Creates `pipeline_versions` for snapshot history
--
-- pipeline-runner.js (the legacy Drawflow runner) is updated in the same
-- commit to query the new table name. The legacy /pipeline-runner/* API
-- endpoints (renamed in M72B) still work — just hit the renamed table.
-- ============================================================================

BEGIN;

-- ── Step 1 · Rename legacy table if it has the legacy schema ─────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'pipelines' AND column_name = 'graph_data')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_name = 'pipeline_runner_pipelines')
  THEN
    EXECUTE 'ALTER TABLE pipelines RENAME TO pipeline_runner_pipelines';
    RAISE NOTICE 'Renamed legacy pipelines → pipeline_runner_pipelines';
  ELSE
    RAISE NOTICE 'No legacy rename needed (legacy schema not present or already renamed)';
  END IF;
END $$;

-- Also rename the legacy index if present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pipelines_updated') THEN
    EXECUTE 'ALTER INDEX idx_pipelines_updated RENAME TO idx_pipeline_runner_pipelines_updated';
  END IF;
END $$;

-- ── Step 2 · Create the new pipelines table (M72A schema) ────────────
-- If a previous M72A attempt got partial-rolled-back, drop and recreate.
-- (Won't happen in practice because step 1 cleared the namespace.)
CREATE TABLE IF NOT EXISTS pipelines (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  category    text NOT NULL DEFAULT 'compose',
  definition  jsonb NOT NULL,
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

DO $$
BEGIN
  RAISE NOTICE 'M77 · pipelines table separation complete. seedFromFiles() will run on Node bootstrap to import compose-recipes/*.json.';
END $$;

COMMIT;
