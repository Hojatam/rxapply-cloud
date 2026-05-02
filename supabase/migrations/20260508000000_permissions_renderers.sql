-- ============================================================================
-- Phase K1 · Per-action approval matrix + per-agent output renderers
--
-- Three concepts:
--   1. agent_permissions      per (agent, action) → 'auto' | 'ask' | 'blocked'
--   2. agent_actions_pending  Inbox queue: actions that hit "ask" mode and
--                             are waiting for the founder's approve / reject
--   3. dashboard_settings.output_renderers   per-agent narrative templates
--      that turn raw JSON output into one-paragraph human-readable text
--
-- All three are forecast-ready for Phases K2–K5 (memory, training, handoffs).
-- ============================================================================

BEGIN;

-- ── 1. Permissions matrix ────────────────────────────────────────────
-- Mode semantics:
--   auto    → run immediately, no Inbox stop
--   ask     → enqueue in agent_actions_pending; Inbox shows preview;
--             founder approves (executes) or rejects (fails the call)
--   blocked → reject without queueing; surfaced as a clear error
CREATE TABLE IF NOT EXISTS agent_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  action text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto', 'ask', 'blocked')),
  cost_threshold_usd numeric(10,4),
    -- if set, "auto" only when estimated cost ≤ threshold; above it falls back to "ask"
  notes text,
  updated_at timestamptz DEFAULT now(),
  updated_by text DEFAULT 'system',
  UNIQUE(agent, action)
);
CREATE INDEX IF NOT EXISTS idx_perm_agent_action ON agent_permissions (agent, action);

-- ── 2. Inbox queue ────────────────────────────────────────────────────
-- Status flow: pending → approved | rejected | expired
-- expires_at lets us auto-fail stale items so they don't pile up forever.
CREATE TABLE IF NOT EXISTS agent_actions_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,         -- the args + context the action needs to run
  preview_text text,              -- human-readable preview shown in Inbox
  estimated_cost_usd numeric(10,4),
  triggered_by text DEFAULT 'founder',     -- 'founder' | 'cron:<workflow>' | 'webhook' | etc.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  expires_at timestamptz DEFAULT (now() + interval '24 hours'),
  -- After approval, the runner stores the result here for Inbox history view.
  result jsonb
);
CREATE INDEX IF NOT EXISTS idx_inbox_pending
  ON agent_actions_pending (status, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_recent
  ON agent_actions_pending (created_at DESC);

-- ── 3. Output renderers (per-agent narrative templates) ──────────────
-- Stored on dashboard_settings as a single jsonb so it's atomically editable.
-- Shape: { "<agent>": { "<action>": "narrative template string" } }
ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS output_renderers jsonb DEFAULT '{}'::jsonb;

-- ── 4. Seed sensible defaults ─────────────────────────────────────────
-- Defaults err on the side of "ask" for anything that:
--   - costs paid API tokens (compose-ig, afshin.draft/render, pooya brief)
--   - sends or schedules an external action (mehrban save, rahbar enroll,
--     ravi send, mehmandar nudge, payvand draft, avang fan-out, cross-post)
-- Read-only / journaling / preview actions are 'auto'.
INSERT INTO agent_permissions (agent, action, mode, cost_threshold_usd, notes) VALUES
  -- Compose-IG & friends (paid LLM)
  ('compose-ig', 'compose-trio',  'auto', 0.20, 'founder-initiated via Compose panel; capped at $0.20'),
  ('pooya',      'brief-from-topic', 'auto', 0.05, 'internal stage of Compose'),
  ('kherad',     'score-ig',      'auto', 0.05, 'internal stage of Compose'),

  -- Afshin (paid + external surface)
  ('afshin',     'draft',         'ask',  NULL, 'paid SVG draft (~$0.005)'),
  ('afshin',     'render',        'ask',  NULL, 'paid PNG render (~$0.04)'),
  ('afshin',     'approve',       'auto', NULL, 'state change only'),
  ('afshin',     'archive',       'auto', NULL, 'state change only'),

  -- Compose gates
  ('compose',    'approve-plan',         'ask',  NULL, 'creates media_library row + triggers paid Afshin draft'),
  ('compose',    'approve-for-posting',  'ask',  NULL, 'writes scheduled_posts row(s) marked ready_to_post'),

  -- Plan-v3 helpers — writes
  ('avang',      'run',           'ask',  NULL, 'writes 11 scheduled_posts rows'),
  ('cross-post', 'run',           'ask',  NULL, 'flips scheduled_posts.status'),
  ('mehrban',    'save',          'ask',  NULL, 'writes engagement_event reply'),
  ('rahbar',     'enroll',        'ask',  NULL, 'writes 5 nurture_schedule rows'),
  ('rahbar',     'enroll-all',    'ask',  NULL, 'writes 15 nurture_schedule rows (3 leads × 5)'),
  ('ravi',       'send',          'ask',  NULL, 'sends email to MailHog'),
  ('mehmandar',  'run',           'ask',  NULL, 'sends 1 weekly digest + N nudges to MailHog'),
  ('payvand',    'draft',         'ask',  NULL, 'writes partnerships.outreach_drafts'),
  ('sepehr',     'save',          'ask',  NULL, 'writes content_assets master'),
  ('goyesh',     'save',          'ask',  NULL, 'writes content_assets translation'),
  ('pooya',      'insert',        'ask',  NULL, 'writes content_briefs'),
  ('bineh',      'save',          'auto', NULL, 'updates one lead engagement_score; deterministic'),

  -- Read-only / preview / audit (auto)
  ('pooya',      'fetch',         'auto', NULL, 'read-only'),
  ('zirak',      'log',           'auto', NULL, 'system journaling'),
  ('zirak',      'tail',          'auto', NULL, 'read-only'),
  ('paya',       'write',         'auto', NULL, 'intel snapshot validation/insert'),
  ('paya',       'list',          'auto', NULL, 'read-only'),
  ('bidar',      'preview',       'auto', NULL, 'dry-run; no DB write'),
  ('bidar',      'run',           'ask',  NULL, 'writes 21 agent_efficiency rows'),
  ('davari',     'run',           'auto', NULL, 'no DB write — chat output only'),
  ('rahnama',    'list',          'auto', NULL, 'read-only'),
  ('rahnama',    'persona',       'auto', NULL, 'compose-only, no DB write'),

  -- Intel agents — all auto (they only write through Paya, which is safe)
  ('roya',       'run',           'auto', NULL, 'writes 1 intel_snapshot via Paya'),
  ('shahed',     'run',           'auto', NULL, 'writes 1 intel_snapshot via Paya'),
  ('dadbeh',     'run',           'auto', NULL, 'writes 1 intel_snapshot via Paya'),
  ('nasim',      'run',           'auto', NULL, 'writes 1 intel_snapshot via Paya'),
  ('ramin',      'run',           'auto', NULL, 'writes 1 intel_snapshot via Paya')
ON CONFLICT (agent, action) DO NOTHING;

-- Seed default output renderers — JS/JSX-style {placeholder} templates.
-- Renderer fallback in code is a generic "<Agent> ran <action> · <duration>ms".
UPDATE dashboard_settings
   SET output_renderers = '{
     "compose-ig": {
       "compose-trio": "compose-ig produced 3 captions for \"{topic}\" — EN {languages.en.caption_chars}c · FA {languages.fa.caption_chars}c · AR {languages.ar.caption_chars}c. Cost {cost_usd_str}."
     },
     "afshin": {
       "draft":  "Afshin generated an SVG draft for \"{topic}\" ({dimensions}). Cost {cost_usd_str}.",
       "render": "Afshin rendered a PNG via {model} for \"{topic}\". Cost {cost_usd_str}."
     },
     "pooya": {
       "brief-from-topic": "Pooya researched \"{topic}\" and produced {key_facts_count} key facts. Angle: {angle_short}",
       "fetch":            "Pooya read {row_count} intel rows from the last 7 days.",
       "insert":           "Pooya inserted {row_count} content_briefs."
     },
     "kherad": {
       "score-ig": "Kherad scored the trio: {verdict}. Overall {overall_score}. {verdict_reason}"
     },
     "zirak": {
       "log":  "Zirak logged a {status} run for {agent} ({count} chars).",
       "tail": "Zirak retrieved the last {row_count} journal rows."
     },
     "ravi": {
       "fetch": "Ravi assembled the weekly funnel report ({funnel_dates.this_week_start} → {funnel_dates.this_week_end}).",
       "send":  "Ravi sent the Monday narrative ({chars} chars / {words} words) to {to}."
     },
     "bidar": {
       "preview": "Bidar would write {rolled_up_agents} agent_efficiency rows. Recommendations: {recommendation_counts}",
       "run":     "Bidar wrote {rolled_up_agents} agent_efficiency rows. Recommendations: {recommendation_counts}"
     },
     "rahbar": {
       "leads":      "Rahbar listed {row_count} leads.",
       "enroll":     "Rahbar enrolled {email} in sequence {sequence_id} (5 emails scheduled).",
       "enroll-all": "Rahbar enrolled {row_count} leads ({successful} successful)."
     },
     "roya":   { "run": "Roya scanned {window_days}d of leads + customers and produced a market heatmap with {destinations_count} destinations." },
     "shahed": { "run": "Shahed compared competitors and emitted {diffs} diffs." },
     "dadbeh": { "run": "Dadbeh found {events} regulatory events in the window." },
     "nasim":  { "run": "Nasim found {spikes} trend spikes from the last 3 days." },
     "ramin":  { "run": "Ramin produced {candidates} keyword candidates from the last 7d of intel." },
     "rahnama": {
       "list":    "Rahnama listed {row_count} leads.",
       "persona": "Rahnama scored persona {email}: top destinations {destinations_short}"
     }
   }'::jsonb
 WHERE id = 1
   AND (output_renderers IS NULL OR output_renderers = '{}'::jsonb);

DO $$
DECLARE
  perm_count int;
  pending_table_present int;
BEGIN
  SELECT COUNT(*) INTO perm_count FROM agent_permissions;
  SELECT COUNT(*) INTO pending_table_present FROM information_schema.tables
   WHERE table_name = 'agent_actions_pending';
  RAISE NOTICE 'K1 migration: agent_permissions seeded with % rows, agent_actions_pending present=%',
               perm_count, pending_table_present;
END $$;

COMMIT;
