-- ============================================================================
-- M23 · Compose orchestrator schema
--
-- The Compose feature is being rewritten from the single-format IG flow into
-- a generalized recipe-driven orchestrator. Every Compose run becomes a
-- first-class object with per-stage execution records, so we can:
--   • show a live pipeline timeline in the dashboard
--   • re-run from any stage
--   • audit cost per recipe / per agent / per format
--   • integrate with n8n via a stable run id
--
-- Two tables:
--   compose_runs    — one row per user-initiated compose run
--   compose_stages  — one row per stage execution within a run
--
-- A run starts in 'queued' → 'running' as the orchestrator picks it up. When
-- a gateable stage finishes and the founder requested a gate there, the run
-- transitions to 'awaiting_approval'; resuming flips it back to 'running'.
-- Terminal states: 'done' | 'failed' | 'cancelled'.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS compose_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Recipe selection
  recipe_id text NOT NULL,                 -- 'email' | 'seo-article' | 'facebook' | 'telegram' | 'x-thread' | 'ig'
  recipe_version text DEFAULT '1',         -- bumped if a recipe's stage list changes

  -- User-supplied inputs
  topic text NOT NULL,
  audience text,
  master_lang text NOT NULL DEFAULT 'en',  -- ISO 639-1 (en, fa, ar, fr, ...)
  target_langs text[] NOT NULL DEFAULT '{}',  -- additional langs to translate to
  options jsonb NOT NULL DEFAULT '{}'::jsonb, -- format-specific opts (campaign, segment, target_keyword, ...)

  -- Approval gate strategy chosen at compose time:
  --   'none'        — no gates, run end-to-end
  --   'critique'    — gate only after critique stage (default)
  --   'critique+adapt' — gate after critique AND adapt
  --   'every'       — gate after every gateable stage
  gate_strategy text NOT NULL DEFAULT 'critique'
    CHECK (gate_strategy IN ('none', 'critique', 'critique+adapt', 'every')),

  -- Per-stage agent overrides chosen at compose time. Shape:
  --   { "draft": "sepehr", "critique": "bidar" }
  -- When null/empty, orchestrator picks by capability registry.
  agent_overrides jsonb DEFAULT '{}'::jsonb,

  -- Lifecycle
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'awaiting_approval', 'translating', 'done', 'failed', 'cancelled')),
  current_stage text,                      -- name of the stage currently running / blocked
  error text,                              -- last error message if status='failed'

  -- Final artifact (renderer output) — keyed by language:
  --   { "en": { "subject": "...", "body_html": "..." }, "fa": { ... } }
  final_output jsonb DEFAULT '{}'::jsonb,

  -- Cost rollup (sum of compose_stages.cost_usd; updated as stages finish).
  total_cost_usd numeric(10, 6) DEFAULT 0,
  total_input_tokens int DEFAULT 0,
  total_output_tokens int DEFAULT 0,

  -- Audit
  created_by text DEFAULT 'founder',
  created_at timestamptz DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_compose_runs_status
  ON compose_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compose_runs_recipe
  ON compose_runs (recipe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compose_runs_recent
  ON compose_runs (created_at DESC);


CREATE TABLE IF NOT EXISTS compose_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES compose_runs(id) ON DELETE CASCADE,

  -- Stage identity within the recipe
  stage_index int NOT NULL,                -- 0-based ordinal in recipe.stages
  stage_name text NOT NULL,                -- 'plan' | 'research' | 'draft' | 'critique' | 'audit' | 'adapt' | 'render' | 'translate'
  capability text,                          -- the capability tag the stage requested ('plan', 'critique', ...) or null for renderers

  -- For translate stages: which target language this row produced.
  -- Null for master-language stages.
  lang text,

  -- Resolved execution
  agent text,                               -- which agent ran (null for deterministic renderers)
  model text,                               -- which LLM resolved (null for renderers)

  -- Inputs / outputs
  input jsonb,                              -- the prompt context handed to the agent
  output jsonb,                             -- the parsed agent response (for LLM stages) or the rendered artifact (for renderers)

  -- Lifecycle
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'gated', 'skipped')),
  error text,

  -- Approval (only for stages where the founder gated on this stage):
  approval_required boolean DEFAULT false,
  approved_at timestamptz,
  approved_by text,
  approval_note text,

  -- Cost
  input_tokens int DEFAULT 0,
  output_tokens int DEFAULT 0,
  cost_usd numeric(10, 6) DEFAULT 0,

  -- Handoff cross-link: if this stage's agent emitted a handoff_intent.
  handoff_id uuid REFERENCES agent_handoffs(id) ON DELETE SET NULL,

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz DEFAULT now(),

  UNIQUE (run_id, stage_index, lang)        -- one row per stage per language
);

CREATE INDEX IF NOT EXISTS idx_compose_stages_run
  ON compose_stages (run_id, stage_index);
CREATE INDEX IF NOT EXISTS idx_compose_stages_status
  ON compose_stages (status) WHERE status IN ('running', 'gated');


-- View: convenient run summary with stage rollup
CREATE OR REPLACE VIEW compose_runs_summary AS
SELECT
  r.id,
  r.recipe_id,
  r.topic,
  r.master_lang,
  r.target_langs,
  r.gate_strategy,
  r.status,
  r.current_stage,
  r.total_cost_usd,
  r.created_at,
  r.finished_at,
  COUNT(s.*) AS stage_count,
  COUNT(s.*) FILTER (WHERE s.status = 'done') AS stages_done,
  COUNT(s.*) FILTER (WHERE s.status = 'failed') AS stages_failed,
  COUNT(s.*) FILTER (WHERE s.status = 'gated') AS stages_gated
FROM compose_runs r
LEFT JOIN compose_stages s ON s.run_id = r.id
GROUP BY r.id;


DO $$
DECLARE rc int;
BEGIN
  SELECT COUNT(*) INTO rc FROM compose_runs;
  RAISE NOTICE 'M23 compose-orchestrator schema applied; existing runs=%', rc;
END $$;

COMMIT;
