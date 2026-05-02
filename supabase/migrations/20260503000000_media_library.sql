-- F8 · Afshin's media_library
-- =============================================================
-- WHY:
--   Afshin produces designs (IG carousels, covers, banners) that
--   other agents (Avang, Sepehr, Ravi) need to find by kind.
--   Files-on-disk only would force everyone to scan a folder.
--
-- LIFECYCLE:
--   1. Other agent (or dashboard) requests a design via Afshin.
--   2. Afshin DRAFT: Claude generates SVG/HTML mock. Row inserted
--      with draft_path set, approved=false.
--   3. Founder reviews in dashboard "Designs" panel, clicks Approve
--      → approved=true. Or rejects → row archived.
--   4. (Optional, if OPENAI_API_KEY) Render: gpt-image-1 generates
--      final raster. render_path filled in.
--   5. Consumer: SELECT … FROM media_library WHERE kind=$1 AND
--      approved=true ORDER BY created_at DESC LIMIT 1.
-- =============================================================

CREATE TABLE IF NOT EXISTS media_library (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN (
                    'ig_carousel_slide','telegram_cover','youtube_thumb',
                    'web_banner','email_header_ravi','custom')),
  topic           text NOT NULL,
  language        text DEFAULT 'en',
  prompt          text NOT NULL,
  draft_path      text,            -- relative path under assets/generated/drafts/
  render_path     text,            -- relative path under assets/generated/renders/
  dimensions      text,            -- "1080x1080"
  owner_agent     text DEFAULT 'afshin',
  approved        boolean DEFAULT false,
  approved_at     timestamptz,
  used_by         text[] DEFAULT '{}',
  draft_cost_usd  numeric(10,4) DEFAULT 0,
  render_cost_usd numeric(10,4) DEFAULT 0,
  archived        boolean DEFAULT false,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz DEFAULT now()
);

-- Hot path: agents picking the latest approved asset of a given kind.
CREATE INDEX IF NOT EXISTS idx_media_library_kind_approved_recent
  ON media_library(kind, created_at DESC) WHERE approved = true AND archived = false;

-- Gallery view: any media for the dashboard.
CREATE INDEX IF NOT EXISTS idx_media_library_recent
  ON media_library(created_at DESC) WHERE archived = false;

COMMENT ON TABLE media_library IS
  'Afshin''s design output registry. Other agents consume approved entries by kind.';
