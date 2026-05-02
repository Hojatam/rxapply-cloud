-- =====================================================================
-- T1 · Tools framework
-- ---------------------------------------------------------------------
-- Five tables that turn arbitrary external services (REST APIs, hosted
-- MCP servers, local stdio MCPs) into agent-callable tools with:
--   • encrypted credentials (pgcrypto, AES via SECRETS_KEY env var)
--   • per-(agent, tool) permission mode (off/ask/auto/policy)
--   • per-call cost log that flows into existing $/month cap
--   • dynamic policy text evaluated by a fast Haiku call when mode=policy
--
-- Lifecycle:
--   1. Tool defined in code registry (cowork-proxy/tools/registry.js)
--      and synced into `tools` table on proxy boot.
--   2. Founder connects → row inserted into `tool_credentials` with
--      pgp_sym_encrypt'd secrets_json.
--   3. Founder sets per-agent permission → row in
--      `agent_tool_permissions`.
--   4. Agent calls a tool → runtime checks perm → logs call to
--      `tool_calls` (status pending → done|error|rejected).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Tool catalog (synced from registry on boot) ─────────────────
CREATE TABLE IF NOT EXISTS tools (
  slug          text PRIMARY KEY,                  -- 'tavily-search', 'ig-graph', …
  name          text NOT NULL,                     -- 'Tavily Search'
  vendor        text,                              -- 'Tavily', 'Meta', 'Perplexity'
  kind          text NOT NULL                      -- intelligence | action | analytics | publish | research
                CHECK (kind IN ('intelligence','action','analytics','publish','research','internal')),
  conn_method   text NOT NULL                      -- how the runtime talks to it
                CHECK (conn_method IN ('rest','mcp_http','mcp_stdio')),
  icon          text,                              -- emoji or short label rendered in UI
  cost_model    text,                              -- human note: 'free 1000/mo · then $0.005/call'
  ops           jsonb DEFAULT '[]'::jsonb,         -- discovered ops [{name, description, write, schema}, …]
  default_policy text,                             -- safe default for the policy textarea
  description   text,                              -- short blurb for the catalog card
  status        text DEFAULT 'available'           -- available | deprecated | hidden
                CHECK (status IN ('available','deprecated','hidden')),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- ── 2. Connected tools (with encrypted secrets) ────────────────────
-- secrets_json holds whatever the adapter needs (API key, page token,
-- refresh token, MCP URL, etc.). Encrypted with pgp_sym_encrypt.
CREATE TABLE IF NOT EXISTS tool_credentials (
  tool_slug         text PRIMARY KEY REFERENCES tools(slug) ON DELETE CASCADE,
  secrets_enc       bytea,                          -- pgp_sym_encrypt(secrets_json::text, key)
  monthly_cap_usd   numeric(10,4) DEFAULT 5.00,     -- per-tool spend cap (independent of global $25 cap)
  monthly_spent_usd numeric(10,4) DEFAULT 0.00,     -- rolling 30d sum, refreshed by cron / on read
  last_status       text,                            -- 'ok' | 'auth_error' | 'rate_limited' | 'unreachable'
  last_status_msg   text,
  last_used_at      timestamptz,
  connected_at      timestamptz DEFAULT now(),
  connected_by      text                              -- 'founder' typically
);

-- ── 3. Per-agent permission matrix ──────────────────────────────────
-- Same shape as agent_permissions but for tools. mode='policy' means
-- the runtime asks the policy engine per call.
CREATE TABLE IF NOT EXISTS agent_tool_permissions (
  agent_name        text NOT NULL,
  tool_slug         text NOT NULL REFERENCES tools(slug) ON DELETE CASCADE,
  mode              text NOT NULL DEFAULT 'off'
                    CHECK (mode IN ('off','ask','auto','policy')),
  policy_text       text,                            -- only used when mode='policy'
  per_call_cap_usd  numeric(10,4),                   -- optional override (else tool default)
  notes             text,
  updated_at        timestamptz DEFAULT now(),
  updated_by        text DEFAULT 'founder',
  PRIMARY KEY (agent_name, tool_slug)
);

CREATE INDEX IF NOT EXISTS atp_tool_idx ON agent_tool_permissions(tool_slug);

-- ── 4. Call log (flows into cost telemetry) ─────────────────────────
-- Mirrors agent_runs but tool-shaped. Joining cost_usd here into the
-- existing 30d sum is what enforces the global $/mo cap.
CREATE TABLE IF NOT EXISTS tool_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent         text NOT NULL,
  tool_slug     text NOT NULL,
  op            text NOT NULL,                      -- which op of the tool was called
  args_redacted jsonb,                              -- args with secrets/PII stripped
  output_summary text,                              -- short text for the activity log
  cost_usd      numeric(10,6) DEFAULT 0,
  status        text NOT NULL                       -- pending | done | error | rejected | policy_ask
                CHECK (status IN ('pending','done','error','rejected','policy_ask','timeout')),
  error_msg     text,
  decision      text,                                -- 'auto' | 'user_approved' | 'user_rejected'
                                                     -- | 'policy_auto' | 'policy_ask'
  decided_by    text,                                -- 'founder' | 'policy' | 'rule'
  task_context  text,                                -- short description of what triggered the call
  request_id    text,                                -- groups tool calls under one user task
  started_at    timestamptz DEFAULT now(),
  ended_at      timestamptz
);

CREATE INDEX IF NOT EXISTS tc_agent_started_idx ON tool_calls(agent, started_at DESC);
CREATE INDEX IF NOT EXISTS tc_tool_started_idx  ON tool_calls(tool_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS tc_status_idx        ON tool_calls(status) WHERE status IN ('pending','policy_ask');

-- ── 5. Decision cache (so the policy engine doesn't re-evaluate
--      the same shape of call within an hour) ───────────────────────
CREATE TABLE IF NOT EXISTS tool_policy_cache (
  cache_key   text PRIMARY KEY,                     -- sha256(agent|tool|op|arg-shape)
  decision    text NOT NULL CHECK (decision IN ('auto','ask')),
  reason      text,
  hits        int DEFAULT 1,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tpc_expires_idx ON tool_policy_cache(expires_at);

-- ── 6. Cost rollup view (joins tool_calls into existing 30d window
--      so cost.js can include it without rewriting SQL paths) ───────
CREATE OR REPLACE VIEW tool_cost_30d AS
SELECT
  tool_slug,
  agent,
  COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS spent_usd,
  COUNT(*)::int                              AS calls
FROM tool_calls
WHERE status IN ('done','error')
  AND started_at >= now() - interval '30 days'
GROUP BY tool_slug, agent;
