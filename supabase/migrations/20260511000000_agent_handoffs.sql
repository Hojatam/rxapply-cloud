-- ============================================================================
-- Phase K4 · Agent-to-agent handoffs
--
-- An agent can declare it needs help from another agent by emitting a
-- handoff_intent in its output JSON, e.g. {to_agent, reason, suggested_action,
-- payload}. The proxy parses this, records it here, and surfaces it in the
-- Inbox so the founder can approve / redirect / decline.
--
-- We intentionally route every handoff through the founder (not autonomous
-- agent-to-agent loops) — multi-agent autonomous chat is research-grade and
-- erodes confidence in production. Plan-v3 §4 governance pattern.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent text NOT NULL,
  to_agent text NOT NULL,
  reason text,                              -- "I'm not confident about regulatory angle — should we ask Dadbeh?"
  suggested_action text,                    -- "brief-from-topic" | "score-ig" | "chat" | …
  payload jsonb,                             -- args / context for the receiver
  source_run_id uuid,                       -- which run prompted the handoff
  source_chat_id uuid,                      -- if it came from F5 chat
  -- Status flow:
  --   pending  → founder hasn't decided yet (visible in Inbox)
  --   approved → founder okayed; the receiver will run with the payload
  --   rejected → founder said no, with optional note
  --   redirected → founder picked a DIFFERENT agent (stored in note)
  --   executed → receiver ran successfully (terminal)
  --   failed   → receiver ran but failed (terminal)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'redirected', 'executed', 'failed')),
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  result jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_handoff_pending
  ON agent_handoffs (status, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_handoff_recent
  ON agent_handoffs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_from_agent
  ON agent_handoffs (from_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_to_agent
  ON agent_handoffs (to_agent, created_at DESC);

DO $$
DECLARE row_count int;
BEGIN
  SELECT COUNT(*) INTO row_count FROM agent_handoffs;
  RAISE NOTICE 'K4 migration: agent_handoffs table present, current rows=%', row_count;
END $$;

COMMIT;
