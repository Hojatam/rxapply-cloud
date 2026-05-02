-- ============================================================================
-- Per-agent LLM model overrides
--
-- Stores a jsonb map of { agent_name: anthropic_model_id }. Empty by default;
-- agents fall back to ANTHROPIC_MODEL env or the hardcoded default.
-- Read at every Anthropic API call via agent-models.js resolveModel().
-- ============================================================================

ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS agent_models jsonb DEFAULT '{}'::jsonb;

DO $$
DECLARE has_col int;
BEGIN
  SELECT COUNT(*) INTO has_col FROM information_schema.columns
   WHERE table_name='dashboard_settings' AND column_name='agent_models';
  RAISE NOTICE 'per_agent_models migration: dashboard_settings.agent_models present=%', has_col;
END $$;
