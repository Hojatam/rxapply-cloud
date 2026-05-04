-- ============================================================================
-- M84 · Training proposals (Moallem trainer agent)
--
-- Moallem (معلم, "teacher") watches the team's recent runs and produces
-- training proposals. Each proposal is reviewed by the founder. Approved
-- proposals get applied as either a brand_intelligence rule or an
-- agent_memory entry. Rejected proposals are remembered so Moallem
-- doesn't re-suggest the same pattern for 30 days.
--
-- This is the meta-learning layer the user asked for: 'agents must
-- learn — not like idiots. If necessary add a Trainer agent which
-- guesses what to teach to each agent and suggests me, if I approve
-- add that to the agent.'
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS training_proposals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_agent             text NOT NULL,
  pattern_summary          text NOT NULL,
  root_cause_hypothesis    text,
  evidence_run_ids         uuid[],
  evidence_metric          jsonb,                 -- { kind, value, n }
  proposed_action          text NOT NULL,         -- add_brand_intelligence_rule | raise_rule_importance | add_procedural_memory | update_skill_md | update_stage_file
  proposed_change          jsonb NOT NULL,        -- the concrete content to apply
  confidence               numeric(3,2) NOT NULL DEFAULT 0.0,
  founder_decision         text NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | superseded
  decision_note            text,
  detected_at              timestamptz NOT NULL DEFAULT now(),
  decided_at               timestamptz,
  applied_at               timestamptz,
  applied_to               text,                  -- e.g. 'brand_intelligence:<uuid>' or 'agent_memory:<uuid>'
  effectiveness_check_at   timestamptz,
  effectiveness_outcome    text,                  -- effective | needs_revision | inconclusive
  effectiveness_metric     jsonb,
  signature                text,                  -- pattern fingerprint to dedup re-proposals
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_proposals_status
  ON training_proposals (founder_decision, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_proposals_agent
  ON training_proposals (target_agent, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_proposals_signature
  ON training_proposals (signature) WHERE signature IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'M84 · training_proposals table ready. Moallem trainer agent can write proposals here; founder approves via /trainer/proposals/:id/approve.';
END $$;

COMMIT;
