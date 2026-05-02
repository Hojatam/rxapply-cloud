-- =====================================================================
-- T0 · Avatars index column (cloud build)
-- ---------------------------------------------------------------------
-- Replaces the local "list cowork-proxy/public/team/agents/" call with
-- a single DB read. Pairs with cowork-proxy/storage.js: the actual
-- image bytes live in R2 (or the local-disk fallback) keyed by
-- avatars/<name>.<ext>; this column maps agent name → extension so
-- /agents/avatars can return the URL list in one query.
-- =====================================================================

ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS avatars jsonb DEFAULT '{}'::jsonb;

-- Optional: seed any existing on-disk avatars into the index.  Safe
-- no-op if the directory doesn't exist or has no matching files.
UPDATE dashboard_settings
   SET avatars = COALESCE(avatars, '{}'::jsonb)
 WHERE id = 1 AND avatars IS NULL;
