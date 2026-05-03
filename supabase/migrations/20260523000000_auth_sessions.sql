-- ============================================================================
-- M57 · Persist auth sessions in Postgres so they survive Railway redeploys.
-- Replaces the in-memory Map in auth.js. Session cookies + tokens stay
-- valid across deploys.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token       text PRIMARY KEY,
  csrf_token  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz DEFAULT now(),
  last_used_at timestamptz DEFAULT now(),
  user_agent  text,
  ip          text
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
  ON auth_sessions (expires_at);

-- Periodic cleanup is cheap; no auto-trigger.
-- Call DELETE FROM auth_sessions WHERE expires_at < NOW() from a cron, or
-- the auth module's pruneExpired() picks them up best-effort on access.

DO $$
BEGIN
  RAISE NOTICE 'M57 auth_sessions schema applied.';
END $$;

COMMIT;
