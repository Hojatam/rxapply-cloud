-- ============================================================================
-- M55 · Brand intelligence layer (dynamic agent training)
--
-- Three tables that turn analyzer outputs (public archive + DM analysis +
-- manual founder edits) into LIVE training data for the agents. Every
-- compose run auto-injects relevant rows into the system prompt.
--
-- Founder can edit / disable / add rules from the dashboard without any
-- code change.
-- ============================================================================

BEGIN;

-- ── 1. brand_intelligence — every pattern / rule / insight ──────────
--
-- Generic shape. The combination (kind, target_agent, scope_platform,
-- scope_language) lets the orchestrator query the right rules at prompt
-- build time. Founder edits via dashboard CRUD.
CREATE TABLE IF NOT EXISTS brand_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  kind text NOT NULL CHECK (kind IN (
    'voice_rule',           -- structural voice pattern (length, opener, etc)
    'banned_phrase',        -- phrases the brand never uses
    'favored_phrase',       -- recurring brand phrases
    'visual_rule',          -- inferred design rules for Afshin
    'engagement_insight',   -- topic-x-engagement, opener-x-engagement, etc
    'dm_question_pattern',  -- top-asked questions (from DM analysis)
    'dm_objection',         -- objection patterns + founder's best reply approach
    'cta_template',         -- CTA forms with frequency
    'opener_template',      -- opener forms with frequency
    'protected_term',       -- brand-specific terms that must not be translated
    'topic_priority',       -- topics that drive engagement / conversions
    'manual'                -- catch-all for hand-added rules
  )),

  -- Scoping — null = applies broadly (any agent / platform / language)
  target_agent text,                   -- 'sepehr', 'avang', 'afshin', 'mehrban', etc
  scope_platform text,                 -- 'instagram', 'telegram', 'email', etc
  scope_language text,                 -- 'fa', 'en', 'ar', 'de', etc

  -- Content
  rule_text text NOT NULL,             -- founder-readable summary (what gets injected)
  rule_data jsonb DEFAULT '{}'::jsonb, -- structured data from the analysis
  importance int DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),

  -- Provenance
  source text,                         -- 'archive_upload_<date>' / 'dm_upload_<date>' / 'manual'
  source_ref text,                     -- pointer back to source row in analyzer output

  -- Lifecycle
  enabled boolean DEFAULT true,
  founder_edited boolean DEFAULT false,
  founder_note text,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brand_int_lookup
  ON brand_intelligence (kind, target_agent, scope_platform, scope_language) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_brand_int_recent
  ON brand_intelligence (created_at DESC);


-- ── 2. brand_exemplars — text bodies the agents reference ───────────
--
-- Captions, DM replies, objection handlers, design briefs. Each is a
-- piece of text + metadata. Agents pull top-N by importance + tag match
-- when building prompts.
CREATE TABLE IF NOT EXISTS brand_exemplars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What kind of exemplar
  kind text NOT NULL CHECK (kind IN (
    'post_caption',         -- public-archive post body
    'dm_reply',             -- founder's good DM replies
    'objection_handler',    -- specific reply for a recurring objection
    'design_brief',         -- visual brief reference
    'intent_example_hot',   -- labeled DM example for Bineh
    'intent_example_qualifying',
    'intent_example_curious',
    'intent_example_off_topic',
    'intent_example_complaint',
    'manual'
  )),

  -- Scoping
  platform text,
  language text,

  -- The exemplar
  body text NOT NULL,
  body_translated jsonb,                -- optional pre-cached translations
  context text,                         -- inbound DM, post topic, etc
  topic_tags text[] DEFAULT '{}',

  -- Quality / provenance
  importance int DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source text,                          -- 'public_archive' / 'dm_archive' / 'manual' / 'compose_run_<id>'
  source_ref text,                      -- post id / thread hash / run id
  outcome text,                         -- 'high_engagement' / 'converted' / 'engaged' / 'reaction_top' / etc

  -- Lifecycle
  enabled boolean DEFAULT true,
  founder_note text,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exemplars_lookup
  ON brand_exemplars (kind, platform, language, importance DESC) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_exemplars_tags
  ON brand_exemplars USING gin (topic_tags) WHERE enabled = true;


-- ── 3. brand_voice_fingerprint — canonical voice cluster (M50) ──────
--
-- Small curated set used by the voice-critic agent to score whether a
-- candidate output reads like the brand. Two clusters: 'broadcast' (post
-- captions) and 'dm_reply' (1-on-1 founder voice — different register).
CREATE TABLE IF NOT EXISTS brand_voice_fingerprint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster text NOT NULL CHECK (cluster IN ('broadcast', 'dm_reply', 'manual')),
  language text NOT NULL,

  body text NOT NULL,
  why_picked text,                      -- the analyzer's note on why this is canonical

  importance int DEFAULT 4 CHECK (importance BETWEEN 1 AND 5),
  source text,
  source_ref text,

  enabled boolean DEFAULT true,
  founder_note text,

  -- Future: embeddings for cosine similarity (filled when M50 ships).
  embedding_vector jsonb,
  embedding_model text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fingerprint_cluster
  ON brand_voice_fingerprint (cluster, language) WHERE enabled = true;


-- ── 4. brand_archive_uploads — provenance log ───────────────────────
--
-- Every upload from the local analyzer creates a row here. Lets the
-- founder revert a bad import or see what each batch added.
CREATE TABLE IF NOT EXISTS brand_archive_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_kind text NOT NULL,            -- 'public_archive' | 'dm_archive' | 'manual_batch'
  source_label text,                    -- 'archive_upload_2026_05_03' etc
  intelligence_inserted int DEFAULT 0,
  exemplars_inserted int DEFAULT 0,
  fingerprint_inserted int DEFAULT 0,
  meta jsonb DEFAULT '{}'::jsonb,
  uploaded_by text DEFAULT 'founder',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploads_recent
  ON brand_archive_uploads (created_at DESC);


DO $$
DECLARE rc int;
BEGIN
  SELECT COUNT(*) INTO rc FROM brand_intelligence;
  RAISE NOTICE 'M55 brand-intelligence schema applied; intelligence rows=%', rc;
END $$;

COMMIT;
