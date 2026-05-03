-- ============================================================================
-- M43 · Country-cohort eval harness
--
-- Pairwise A/B between a "candidate" Compose run and a "baseline" Compose run,
-- judged by a designated agent (default: Bidar). Used before each country
-- launch (UK → USA → DE → AU → CA → UAE → SA) to confirm new recipes / model
-- changes / brand-profile updates don't regress quality.
--
-- The founder seeds golden prompts per country (no seeding from this migration).
-- Each prompt is paired with a baseline compose_run (the reference output).
-- When a candidate is run, the harness records the pairwise judge verdict.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS eval_golden_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Country tag (lowercase ISO-ish, or null for multi-country evergreen prompts)
  country text,

  -- Which recipe to evaluate for this prompt (e.g. 'email', 'telegram', 'seo-article')
  recipe_id text NOT NULL,

  -- The prompt itself: same fields the founder fills on the run form
  topic text NOT NULL,
  audience text,
  master_lang text DEFAULT 'en',
  target_langs text[] DEFAULT '{}',
  options jsonb DEFAULT '{}'::jsonb,

  -- The reference output we're comparing against. Points to a compose_runs row
  -- the founder has already approved as canonical for this prompt.
  baseline_run_id uuid REFERENCES compose_runs(id) ON DELETE SET NULL,

  -- Optional founder notes / what makes this prompt important
  notes text,

  -- Lifecycle
  archived boolean DEFAULT false,
  created_by text DEFAULT 'founder',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eval_golden_country
  ON eval_golden_prompts (country, recipe_id) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_eval_golden_recent
  ON eval_golden_prompts (created_at DESC);


CREATE TABLE IF NOT EXISTS eval_pairwise_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  golden_prompt_id uuid NOT NULL REFERENCES eval_golden_prompts(id) ON DELETE CASCADE,

  -- The two compose runs being compared
  candidate_run_id uuid NOT NULL REFERENCES compose_runs(id) ON DELETE CASCADE,
  baseline_run_id  uuid REFERENCES compose_runs(id) ON DELETE SET NULL,

  -- Judge result
  judge_agent text,                              -- e.g. 'bidar'
  judge_model text,                              -- model used
  judge_output jsonb,                            -- full structured judge response
  winner text CHECK (winner IN ('candidate', 'baseline', 'tie', 'inconclusive')),

  -- Reasons (extracted from judge_output for fast filtering)
  on_brand_winner text,                          -- 'candidate' | 'baseline' | 'tie'
  accuracy_winner text,
  format_fit_winner text,

  cost_usd numeric(10, 6) DEFAULT 0,
  duration_ms int,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eval_pairwise_recent
  ON eval_pairwise_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_pairwise_prompt
  ON eval_pairwise_runs (golden_prompt_id, created_at DESC);


-- Convenience view: most-recent verdict per (golden_prompt_id)
CREATE OR REPLACE VIEW eval_latest_verdict AS
SELECT DISTINCT ON (golden_prompt_id)
  golden_prompt_id,
  candidate_run_id,
  baseline_run_id,
  winner,
  on_brand_winner,
  accuracy_winner,
  format_fit_winner,
  judge_agent,
  judge_model,
  cost_usd,
  created_at
FROM eval_pairwise_runs
ORDER BY golden_prompt_id, created_at DESC;


DO $$
DECLARE rc int;
BEGIN
  SELECT COUNT(*) INTO rc FROM eval_golden_prompts;
  RAISE NOTICE 'M43 eval harness schema applied; existing golden prompts=%', rc;
END $$;

COMMIT;
