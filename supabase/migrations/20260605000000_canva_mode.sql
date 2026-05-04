-- =====================================================================
-- M103 · Canva-native compose mode
-- ---------------------------------------------------------------------
-- Adds the persistence layer for the second compose mode:
--   * canva_settings  · single-row config (1 row, id=1)
--   * canva_templates · founder-managed registry of Canva brand templates
--   * canva_sizes     · founder-managed list of Magic-Resize target sizes
--   * canva_runs      · per-design records produced by compose runs
--                       (one row per slide; one row per fan-out resize)
--
-- Idempotent — uses CREATE TABLE IF NOT EXISTS + ON CONFLICT inserts.
-- Safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS canva_settings (
  id                       int  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_token                text,
  default_brand_id         text,
  autofill_async           boolean      DEFAULT true,
  poll_max_ms              int          DEFAULT 60000,
  preferred_export_format  text         DEFAULT 'png',
  notes                    text,
  updated_at               timestamptz  DEFAULT now()
);

INSERT INTO canva_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS canva_templates (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL,
  canva_template_id  text        NOT NULL,
  slot_type          text,                              -- 'cover' | 'data' | 'cta' | 'key_fact' | freeform
  platform           text,                              -- 'instagram' | 'linkedin' | 'facebook' | freeform
  language           text,                              -- 'en' | 'fa' | null (any)
  slot_mappings      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  enabled            boolean     DEFAULT true,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canva_templates_lookup_idx
  ON canva_templates (slot_type, platform, language)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS canva_sizes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  width_px    int         NOT NULL CHECK (width_px > 0),
  height_px   int         NOT NULL CHECK (height_px > 0),
  platform    text,
  enabled     boolean     DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- Pre-seed common sizes so the founder has something to start with.
-- Every row is editable from the dashboard — these are NOT hardcoded
-- defaults at runtime, just initial values that can be edited / deleted.
INSERT INTO canva_sizes (name, width_px, height_px, platform) VALUES
  ('Instagram Post (1:1)',          1080, 1080, 'instagram'),
  ('Instagram Portrait (4:5)',      1080, 1350, 'instagram'),
  ('Instagram Story (9:16)',        1080, 1920, 'instagram'),
  ('Instagram Reel cover (9:16)',   1080, 1920, 'instagram'),
  ('LinkedIn Post (1.91:1)',        1200, 627,  'linkedin'),
  ('LinkedIn Square (1:1)',         1080, 1080, 'linkedin'),
  ('Facebook Post (1.91:1)',        1200, 630,  'facebook'),
  ('Facebook Story (9:16)',         1080, 1920, 'facebook'),
  ('YouTube Thumbnail (16:9)',      1280, 720,  'youtube'),
  ('YouTube Community (1:1)',       1080, 1080, 'youtube'),
  ('Twitter / X Post (16:9)',       1600, 900,  'twitter'),
  ('Pinterest Pin (2:3)',           1000, 1500, 'pinterest'),
  ('Telegram Channel cover (16:9)', 1280, 720,  'telegram')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS canva_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  compose_run_id  uuid,                                              -- references compose_runs(id)
  slide_n         int,
  canva_design_id text,
  edit_url        text,
  view_url        text,
  template_id     uuid REFERENCES canva_templates(id) ON DELETE SET NULL,
  size_id         uuid REFERENCES canva_sizes(id)     ON DELETE SET NULL,
  parent_run_id   uuid REFERENCES canva_runs(id)      ON DELETE SET NULL,
  status          text        DEFAULT 'creating',                    -- 'creating'|'ready'|'failed'
  error           text,
  fields          jsonb,                                              -- the autofill data sent
  created_at      timestamptz DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS canva_runs_compose_idx ON canva_runs (compose_run_id);
CREATE INDEX IF NOT EXISTS canva_runs_parent_idx  ON canva_runs (parent_run_id);
