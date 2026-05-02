-- F7 · Prompt versioning + persisted agent chats
-- =============================================================
-- WHY:
--   Today the only copy of an agent's SKILL.md is the file itself.
--   Hand-edits in the dashboard "Prompts" editor overwrite without
--   history — a bad edit is recoverable only via git.
--
--   Q7 also said "persist agent chats" — when you ask Pooya
--   "why brief #3?", that conversation should survive so you can
--   ask follow-ups tomorrow.
--
-- WHAT'S NEW:
--   1. prompt_versions — append-only per-agent version history.
--      The currently-active version is the highest version number.
--      Rollback = INSERT a new row with body = older version.
--   2. agent_chats — one row per chat session, messages as JSONB.
--      run_context links to a triggering agent_runs row when the
--      chat was opened from a specific run's Forward tab.
-- =============================================================

CREATE TABLE IF NOT EXISTS prompt_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       text NOT NULL,
  version     int  NOT NULL,
  body        text NOT NULL,
  edited_by   text DEFAULT 'founder',
  edited_at   timestamptz NOT NULL DEFAULT now(),
  diff_chars  int,
  reason      text,
  UNIQUE (agent, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent_recent
  ON prompt_versions(agent, version DESC);

COMMENT ON TABLE prompt_versions IS
  'Per-agent SKILL.md version history. Append-only. Rollback = insert new version with old body.';

-- ── agent_chats ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_chats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent         text NOT NULL,
  title         text,                              -- one-line topic, set by first user message
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_msg_at   timestamptz NOT NULL DEFAULT now(),
  -- messages: array of { role: 'user'|'assistant'|'system', content: text, ts: iso, tokens?: int }
  messages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- run_context: optional link to an agent_runs row that this chat is "about"
  run_context   uuid REFERENCES agent_runs(id),
  total_tokens  int DEFAULT 0,
  total_cost    numeric(10,4) DEFAULT 0,
  archived      boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_agent_chats_agent_recent
  ON agent_chats(agent, last_msg_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_chats_active
  ON agent_chats(last_msg_at DESC) WHERE archived = false;

COMMENT ON TABLE agent_chats IS
  'Persisted Q&A sessions with an agent. Messages stored inline as JSONB for fast feed render.';

-- ── settings (single-row config table for the dashboard) ────────
-- Keeps run-time configurable knobs (sandbox toggle, monthly cap,
-- auth password hash) in DB so the dashboard can read+write them.

CREATE TABLE IF NOT EXISTS dashboard_settings (
  id              int PRIMARY KEY DEFAULT 1,
  sandbox_mode    boolean DEFAULT false,
  monthly_cap_usd numeric(10,2) DEFAULT 25.00,
  auth_password_hash text,                          -- bcrypt; NULL means auth disabled
  auth_session_hours int DEFAULT 4,
  anthropic_key_present boolean DEFAULT false,     -- set on save in Settings panel; key itself stays in env
  openai_key_present    boolean DEFAULT false,
  updated_at      timestamptz DEFAULT now(),
  CONSTRAINT singleton_check CHECK (id = 1)
);

INSERT INTO dashboard_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE dashboard_settings IS
  'Singleton row of dashboard config. Read by every page load, written from the Settings panel.';
