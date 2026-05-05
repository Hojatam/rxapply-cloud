-- =====================================================================
-- M112 · KB import history + undo
-- ---------------------------------------------------------------------
-- Each /knowledge/upload-json call writes a row to this table so the
-- founder can: see when each batch landed, how many entries it added,
-- which ones failed, and undo the whole batch in one click.
--
-- Undo is non-destructive by default: it flips status='rejected' on
-- every successful entry from the import (excluded from agent recall
-- but preserved for audit). A "hard" undo flag deletes the rows
-- permanently — exposed for the founder when soft-undo isn't enough.
-- =====================================================================

CREATE TABLE IF NOT EXISTS kb_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz DEFAULT now(),
  created_by      text,                          -- founder / agent

  filename        text,                          -- original upload filename (best-effort)
  default_country text,
  default_status  text,
  default_importance int,

  total_count     int DEFAULT 0,                 -- entries in the JSON
  created_count   int DEFAULT 0,                 -- successfully inserted
  failed_count    int DEFAULT 0,
  entry_ids       uuid[] DEFAULT '{}'::uuid[],   -- the new entries' ids (for undo)
  failed_entries  jsonb DEFAULT '[]'::jsonb,     -- {title, error}[] for diagnostics

  status          text DEFAULT 'active'
                  CHECK (status IN ('active','undone','undone_hard')),
  undone_at       timestamptz,
  undone_by       text,
  undone_method   text,                          -- 'soft' | 'hard'
  notes           text
);

CREATE INDEX IF NOT EXISTS kb_imports_recent_idx
  ON kb_imports (created_at DESC);
CREATE INDEX IF NOT EXISTS kb_imports_status_idx
  ON kb_imports (status, created_at DESC);
