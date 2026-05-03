-- ============================================================================
-- M46 · Regulatory drift watchdog
--
-- Daily check on canonical regulator pages (NDEB, ORE, GDC, ADC, AHPRA, etc.)
-- to catch silent rule changes before stale content goes live.
--
-- Watchpoints are defined as KB entries with metadata.watchpoint_url. The
-- watchdog scans for those, fetches each URL, hashes the content, and on
-- change records a drift event for founder review.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS regulatory_watchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional link back to the KB entry that defines this watchpoint
  kb_entry_id uuid,

  -- Identity
  label text,                          -- founder-friendly name, e.g. "NDEB Part 1 fee page"
  country text,                        -- 'ca', 'uk', 'us', 'de', 'au', 'uae', 'sa'
  regulator text,                      -- 'NDEB', 'GDC', 'ORE', 'ADC', 'AHPRA', 'DHA', etc.

  -- What to monitor
  url text NOT NULL,
  selector text,                       -- optional CSS selector to scope the diff
  fetch_method text DEFAULT 'GET',     -- 'GET' | 'POST' (POST needs body in metadata)
  metadata jsonb DEFAULT '{}'::jsonb,

  -- State
  last_hash text,
  last_check_at timestamptz,
  last_change_at timestamptz,
  consecutive_errors int DEFAULT 0,
  last_error text,

  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchpoints_active
  ON regulatory_watchpoints (active, last_check_at) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_watchpoints_country
  ON regulatory_watchpoints (country, regulator);


CREATE TABLE IF NOT EXISTS regulatory_drift_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchpoint_id uuid NOT NULL REFERENCES regulatory_watchpoints(id) ON DELETE CASCADE,

  detected_at timestamptz DEFAULT now(),
  prev_hash text,
  new_hash text,
  diff_size_bytes int,
  diff_excerpt text,                   -- first ~2000 chars of the difference

  -- Founder review state
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed', 'dismissed', 'kb-updated')),
  reviewed_at timestamptz,
  reviewed_by text,
  resolution_note text
);

CREATE INDEX IF NOT EXISTS idx_drift_pending
  ON regulatory_drift_events (status, detected_at DESC) WHERE status = 'pending';


DO $$
DECLARE rc int;
BEGIN
  SELECT COUNT(*) INTO rc FROM regulatory_watchpoints;
  RAISE NOTICE 'M46 regulatory-watchdog schema applied; watchpoints=%', rc;
END $$;

COMMIT;
