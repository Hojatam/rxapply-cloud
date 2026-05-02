-- ============================================================================
-- Compose-IG migration  (V2 / Phase F · plan-v2 §5)
--
-- Adds the columns the Compose flow needs to track:
--   1. The two-gate approval state on media_library (design plan → image)
--   2. The post-readiness + future auto-post hooks on scheduled_posts
--   3. Forward-looking carousel slots (slide_index, parent_media_id)
--
-- Idempotent — safe to re-run. No data destruction.
-- ============================================================================

BEGIN;

-- ── media_library: design plan + plan-approval gate (Gate A) ──────────────
ALTER TABLE media_library
  ADD COLUMN IF NOT EXISTS design_plan jsonb,                 -- compose-ig output
  ADD COLUMN IF NOT EXISTS plan_approved_at timestamptz,      -- when Gate A passed
  ADD COLUMN IF NOT EXISTS plan_approved_by text,             -- usually 'founder'

  -- Forecast-ready: carousel support without a future schema break.
  -- For single-image posts these stay NULL; for carousels each slide gets
  -- its own row pointing at the parent.
  ADD COLUMN IF NOT EXISTS slide_index int,
  ADD COLUMN IF NOT EXISTS parent_media_id uuid REFERENCES media_library(id) ON DELETE CASCADE,

  -- Compose-IG runs save the captions trio per language directly here, so
  -- the same media row carries everything needed by the viewer.
  ADD COLUMN IF NOT EXISTS captions jsonb;                    -- { en: {...}, fa: {...}, ar: {...} }

CREATE INDEX IF NOT EXISTS idx_media_library_parent
  ON media_library (parent_media_id, slide_index)
  WHERE parent_media_id IS NOT NULL;

-- ── scheduled_posts: post-readiness + auto-post forecasting ───────────────
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS compose_media_id uuid REFERENCES media_library(id) ON DELETE SET NULL,

  -- Set when Gate B (approve for posting) passes.
  ADD COLUMN IF NOT EXISTS approved_for_posting_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_for_posting_by text,

  -- Filled in once posting actually happens (manual or automated).
  -- Schema is here from day 1 so the auto-post integration won't need a
  -- migration when we wire Meta Graph / Publer / an MCP server.
  ADD COLUMN IF NOT EXISTS posted_url text,
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS posting_provider text,             -- 'manual' | 'meta_graph' | 'publer' | 'mcp_<name>'
  ADD COLUMN IF NOT EXISTS posting_error text;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_compose
  ON scheduled_posts (compose_media_id)
  WHERE compose_media_id IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────────────────
DO $$
DECLARE
  ml_added int;
  sp_added int;
BEGIN
  SELECT COUNT(*) INTO ml_added FROM information_schema.columns
   WHERE table_name='media_library'
     AND column_name IN ('design_plan','plan_approved_at','plan_approved_by',
                         'slide_index','parent_media_id','captions');
  SELECT COUNT(*) INTO sp_added FROM information_schema.columns
   WHERE table_name='scheduled_posts'
     AND column_name IN ('compose_media_id','approved_for_posting_at',
                         'approved_for_posting_by','posted_url','posted_at',
                         'posting_provider','posting_error');
  RAISE NOTICE 'compose_ig migration: media_library +% / 6, scheduled_posts +% / 7',
               ml_added, sp_added;
END $$;

COMMIT;
