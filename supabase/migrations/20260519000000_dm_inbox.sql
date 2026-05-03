-- ============================================================================
-- M47 · DM inbox + intent triage
--
-- Inbound DMs from Instagram / Telegram get triaged into 5 buckets so the
-- founder can spot hot/qualifying leads buried in noise. Hot + qualifying
-- get a draft reply (Mehrban) queued for founder approval.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS dm_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  source text NOT NULL,                 -- 'instagram' | 'telegram' | 'manual'
  source_user text,                     -- handle / id of the sender
  source_message_id text,               -- platform-specific id (for dedup)
  language text,                        -- detected language code
  body text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),

  -- Triage (M47)
  triage_status text                    -- 'curious' | 'qualifying' | 'hot' | 'off-topic' | 'complaint' | NULL = untriaged
    CHECK (triage_status IS NULL OR triage_status IN ('curious','qualifying','hot','off-topic','complaint')),
  triage_confidence numeric,            -- 0..1
  triage_reasoning text,
  triage_at timestamptz,
  triage_agent text,
  triage_model text,
  triage_cost_usd numeric(10,6) DEFAULT 0,

  -- Draft reply (only generated for hot + qualifying)
  draft_reply text,
  draft_reply_at timestamptz,
  draft_reply_agent text,
  draft_reply_model text,

  -- Founder action
  founder_action text                   -- 'replied' | 'archived' | 'ignored' | 'flagged' | NULL
    CHECK (founder_action IS NULL OR founder_action IN ('replied','archived','ignored','flagged')),
  founder_action_at timestamptz,
  founder_note text,

  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),

  UNIQUE (source, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_inbox_recent
  ON dm_inbox (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_inbox_untriaged
  ON dm_inbox (received_at DESC) WHERE triage_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_dm_inbox_hot
  ON dm_inbox (received_at DESC) WHERE triage_status IN ('hot', 'qualifying') AND founder_action IS NULL;

DO $$
DECLARE rc int;
BEGIN
  SELECT COUNT(*) INTO rc FROM dm_inbox;
  RAISE NOTICE 'M47 dm_inbox schema applied; rows=%', rc;
END $$;

COMMIT;
