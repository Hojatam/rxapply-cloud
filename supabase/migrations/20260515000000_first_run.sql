-- =====================================================================
-- T0 · First-run wizard state (cloud build)
-- ---------------------------------------------------------------------
-- Powers the 8-step setup wizard. `first_run_done` flips to true after
-- the founder finishes the wizard. `setup_progress` is a jsonb cursor
-- that lets the wizard resume mid-flow if the founder closes the tab.
-- =====================================================================

ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS first_run_done   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS setup_progress   jsonb   DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS totp_secret      bytea,                      -- 2FA shared secret (pgp_sym_encrypt → bytea)
  ADD COLUMN IF NOT EXISTS totp_recovery    jsonb   DEFAULT '[]'::jsonb,-- one-time recovery codes (sha256 hashes)
  ADD COLUMN IF NOT EXISTS founder_email    text;                       -- captured in step 2

-- Make sure the singleton row exists. Idempotent.
INSERT INTO dashboard_settings (id, sandbox_mode, monthly_cap_usd)
VALUES (1, false, 25.0)
ON CONFLICT (id) DO NOTHING;
