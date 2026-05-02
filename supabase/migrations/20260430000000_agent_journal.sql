-- agent_journal — append-only narrative log of every agent run.
--
-- Why this table exists:
--   agent_runs is billing-shaped (tokens, cost, duration) and used by Bidar.
--   agent_journal is narrative-shaped (input → output, where the output landed)
--   and used by the admin dashboard's activity feed.
--
-- Reads: dashboard activity feed (last 50, indexed on created_at DESC).
-- Writes: every agent helper appends one row per invocation. Append-only.

CREATE TABLE IF NOT EXISTS agent_journal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent           text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     int,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'success', 'fail')),
  input_summary   text,                -- 1-line: "brief df7d2847" or "saeed.tehrani@example.com"
  output_summary  text,                -- 1-line: "3 briefs inserted" or "score=0.80"
  output_table    text,                -- e.g. 'content_briefs', 'scheduled_posts', 'leads'
  output_id       uuid,                -- the row's id in output_table (if singular)
  output_count    int,                 -- when output is many rows
  error           text,                -- null on success; first 500 chars of error on fail
  trigger_source  text DEFAULT 'manual',  -- 'manual' | 'cron' | 'webhook' | 'dashboard'
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path: dashboard reads the last N rows
CREATE INDEX IF NOT EXISTS idx_agent_journal_recent
  ON agent_journal (created_at DESC);

-- Per-agent filter: "show me Pooya's last 10 runs"
CREATE INDEX IF NOT EXISTS idx_agent_journal_agent_recent
  ON agent_journal (agent, created_at DESC);

-- Failure scan: dashboard's red-banner feed
CREATE INDEX IF NOT EXISTS idx_agent_journal_failures
  ON agent_journal (created_at DESC) WHERE status = 'fail';

COMMENT ON TABLE agent_journal IS
  'Narrative activity feed for the admin dashboard. Append-only. One row per agent invocation.';
