-- F2 · Logs L2 — full I/O capture for every agent invocation
-- =============================================================
-- WHY:
--   agent_runs today is headlines-only (status, duration, summary).
--   To debug or replay, we need full input + output payloads,
--   per-step actions (every SQL, every HTTP call), and a path to
--   the raw stdout/stderr files on disk.
--
-- WHAT'S NEW:
--   1. agent_runs gains 5 columns: input_payload, output_payload,
--      error_payload, log_file_path, cost_usd_actual.
--   2. New table agent_actions: one row per discrete action a
--      helper performs within a single run (SQL, HTTP, file write,
--      subprocess, llm_call). Cascade-deletes with the parent run.
--
-- READS:
--   Dashboard "Logs" panel (F2 UI) joins agent_runs + agent_actions
--   on run_id to render the expand-row tabs.
--
-- WRITES:
--   The log-writer module in cowork-proxy/log-writer.js writes
--   agent_runs at start (status='running') and updates at end
--   (status='success'|'fail'). Each helper that supports L2 emits
--   action records via stdin protocol or POST /logs/:runid/action.
-- =============================================================

-- ── 1. Extend agent_runs ────────────────────────────────────────
-- These columns may already exist in some forks of the schema; use
-- IF NOT EXISTS to stay idempotent.

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS input_payload   jsonb,
  ADD COLUMN IF NOT EXISTS output_payload  jsonb,
  ADD COLUMN IF NOT EXISTS error_payload   jsonb,
  ADD COLUMN IF NOT EXISTS log_file_path   text,
  ADD COLUMN IF NOT EXISTS cost_usd_actual numeric(10,4) DEFAULT 0,
  -- Baseline schema only had created_at. L2 needs two timestamps (start
  -- and end) to compute helper duration distinct from row creation. Both
  -- nullable so prior writers don't break; new rows get NOW() via the
  -- INSERT we emit from log-writer.js.
  ADD COLUMN IF NOT EXISTS started_at      timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at     timestamptz;

-- Backfill started_at from created_at for any existing rows so the view
-- has something to ORDER BY. Only updates rows where started_at IS NULL.
UPDATE agent_runs SET started_at = created_at WHERE started_at IS NULL;

-- After backfill, set the default so future direct INSERTs (any path that
-- doesn't specify started_at) still get a sane value.
ALTER TABLE agent_runs ALTER COLUMN started_at SET DEFAULT now();

COMMENT ON COLUMN agent_runs.input_payload   IS 'Full request payload — what the helper was called with. Sanitized of secrets.';
COMMENT ON COLUMN agent_runs.output_payload  IS 'Full response — stdout parsed if JSON, else { raw: "<text>" }.';
COMMENT ON COLUMN agent_runs.error_payload   IS 'NULL on success. On fail: { code, message, stderr_excerpt }.';
COMMENT ON COLUMN agent_runs.log_file_path   IS 'Relative path to the log bundle in logs/YYYY-MM-DD/<agent>-<runid>.json';
COMMENT ON COLUMN agent_runs.cost_usd_actual IS 'Actual paid-API cost recorded by F9 cost telemetry. 0 for no-LLM runs.';
COMMENT ON COLUMN agent_runs.started_at      IS 'L2: when the helper began executing (set by log-writer recordRunStart).';
COMMENT ON COLUMN agent_runs.finished_at     IS 'L2: when the helper completed. NULL while status=running.';

-- ── 2. agent_actions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_index   int  NOT NULL,
  action_kind  text NOT NULL
                CHECK (action_kind IN ('sql','http','file_write','file_read','subprocess','llm_call','validate','custom')),
  -- action_data is shape-flexible per action_kind:
  --   sql        : { query, rows_affected, duration_ms }
  --   http       : { method, url, status, request_size, response_size, duration_ms }
  --   file_write : { path, bytes }
  --   subprocess : { argv, exit_code, stdout_excerpt, stderr_excerpt }
  --   llm_call   : { model, input_tokens, output_tokens, cost_usd, prompt_excerpt }
  action_data  jsonb,
  duration_ms  int,
  status       text DEFAULT 'success' CHECK (status IN ('success','fail','skipped')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_run
  ON agent_actions(run_id, step_index);

CREATE INDEX IF NOT EXISTS idx_agent_actions_kind_recent
  ON agent_actions(action_kind, created_at DESC);

COMMENT ON TABLE agent_actions IS
  'Per-step actions inside a single agent_runs row. Used by the F2 Logs UI to render the Action timeline.';

-- ── 3. Helper view for the dashboard log feed ───────────────────
-- Pre-joins runs with their action counts so the "Logs" list page
-- can render quickly without N+1 queries.

CREATE OR REPLACE VIEW v_run_log_summary AS
SELECT
  r.id,
  r.agent,
  r.started_at,
  r.finished_at,
  r.status,
  r.duration_ms,
  r.cost_usd_actual,
  r.log_file_path,
  COALESCE(a.action_count, 0)   AS action_count,
  COALESCE(a.failed_actions, 0) AS failed_actions,
  CASE
    WHEN r.input_payload IS NULL THEN false
    ELSE true
  END AS has_input,
  CASE
    WHEN r.output_payload IS NULL THEN false
    ELSE true
  END AS has_output
FROM agent_runs r
LEFT JOIN (
  SELECT run_id,
         count(*)                                    AS action_count,
         count(*) FILTER (WHERE status = 'fail')     AS failed_actions
  FROM agent_actions
  GROUP BY run_id
) a ON a.run_id = r.id;

COMMENT ON VIEW v_run_log_summary IS
  'F2 dashboard: efficient run+action summary join. Read-only.';
