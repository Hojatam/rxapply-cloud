-- ============================================================================
-- M69 · Refine loops with per-stage retry caps
--
-- When a critique/verify/audit/voice-critic stage returns a failing verdict,
-- the orchestrator can now re-run the previous LLM stage (e.g. draft) with
-- a # REFINE NOTES block built from the failing stage's actionable_fixes.
--
-- This migration adds:
--   compose_runs.refine_attempts JSONB[] — each entry records one refine event
--     {
--       from_stage:   "critique",   // the stage that triggered the refine
--       to_stage:     "draft",       // the stage being re-run
--       reason:       "fail" | "needs_refine" | "block" | ...,
--       fixes:        ["cut to 38–75 words", ...],
--       attempt:      1,             // 1-indexed; 1 = first refine
--       at:           "2026-05-04T..."
--     }
--   compose_runs.refine_status — 'none' | 'in_progress' | 'cap_reached'
--
-- The orchestrator reads refine_attempts to:
--   1. Decide whether to refine (count entries against retry_cap)
--   2. Build the refine-notes block when the target stage re-executes
-- ============================================================================

BEGIN;

ALTER TABLE compose_runs
  ADD COLUMN IF NOT EXISTS refine_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS refine_status   text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  RAISE NOTICE 'M69 · refine_attempts + refine_status columns added to compose_runs.';
END $$;

COMMIT;
