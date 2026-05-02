-- F8b · Per-kind image model defaults + F6 pipeline table
-- =============================================================
-- Adds image_model_defaults (jsonb) to dashboard_settings so the
-- founder can set a default render provider per design kind:
--   { "ig_carousel_slide": "gpt-image-1", "telegram_cover": "dall-e-3", ... }
--
-- Also adds a pipelines table that stores saved Drawflow graphs so
-- the F6 pipeline editor can persist named pipelines across sessions.
-- =============================================================

ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS image_model_defaults jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN dashboard_settings.image_model_defaults IS
  'Per-kind render model defaults. Keys = kind slug, values = model_key from the MODEL_REGISTRY.';

-- ── Pipelines (F6) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipelines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  -- graph_data is the full Drawflow export JSON.
  graph_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  node_count  int  DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipelines_updated
  ON pipelines(updated_at DESC);

COMMENT ON TABLE pipelines IS
  'F6 Drawflow visual pipeline editor — one row per saved pipeline graph.';
