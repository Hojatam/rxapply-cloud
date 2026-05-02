-- =====================================================================
-- K6 · Knowledge Base
-- ---------------------------------------------------------------------
-- Country-scoped, category-tagged, sourced and versioned facts that
-- every agent reads as grounding before producing output. Founder owns
-- the data; Daneshyar (agent #24) parses / verifies / refines / enriches.
--
-- Versioning model: when an entry is replaced, the OLD row's status is
-- set to 'superseded' and `superseded_by` points to the new row's id.
-- This preserves audit history without tombstoning rows.
-- =====================================================================

CREATE TABLE IF NOT EXISTS knowledge_base (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  country         text NOT NULL,                  -- 'UK','USA','DE','AU','CA','UAE','SA','GLOBAL'
  category        text NOT NULL,                  -- 'exam','visa','milestone','regulator','timeline','cost','document','other'
  title           text NOT NULL,                  -- short label, e.g. "ORE Part 1 — eligibility"
  content         text NOT NULL,                  -- the prose / canonical wording
  facts           jsonb DEFAULT '{}'::jsonb,      -- structured key/value facts (numbers, dates, names)

  -- Provenance
  source          text,                           -- URL or "founder note"
  source_type     text DEFAULT 'manual'           -- 'manual' | 'parsed' | 'web' | 'inherited'
                  CHECK (source_type IN ('manual','parsed','web','inherited')),

  -- Lifecycle
  status          text DEFAULT 'active'
                  CHECK (status IN ('active','draft','stale','superseded','rejected')),
  verified_at     timestamptz,
  verified_by     text,                           -- 'founder' | 'daneshyar' | agent name
  superseded_by   uuid REFERENCES knowledge_base(id) ON DELETE SET NULL,

  -- Indexing helpers
  tags            text[] DEFAULT '{}',
  importance      int DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),

  -- Timestamps
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  last_used_at    timestamptz DEFAULT now(),
  use_count       int DEFAULT 0
);

CREATE INDEX IF NOT EXISTS kb_country_status_idx
  ON knowledge_base (country, status);
CREATE INDEX IF NOT EXISTS kb_category_idx
  ON knowledge_base (category);
CREATE INDEX IF NOT EXISTS kb_tags_gin
  ON knowledge_base USING GIN (tags);
CREATE INDEX IF NOT EXISTS kb_facts_gin
  ON knowledge_base USING GIN (facts);
CREATE INDEX IF NOT EXISTS kb_status_imp_idx
  ON knowledge_base (status, importance DESC, last_used_at DESC);

-- ── Permission seeds for Daneshyar (agent #24) ──────────────────────
-- Daneshyar owns the KB lifecycle. Default modes:
--   parse, verify, find-more, refine  → auto (cheap reads / structured ops)
--   enrich-from-research              → ask  (involves web fetch + writes)
INSERT INTO agent_permissions (agent, action, mode, cost_threshold_usd)
VALUES
  ('daneshyar','parse',                'auto', 0.50),
  ('daneshyar','verify',               'auto', 0.50),
  ('daneshyar','find-more',            'auto', 0.50),
  ('daneshyar','refine',               'auto', 0.50),
  ('daneshyar','enrich-from-research', 'ask',  1.00),
  ('daneshyar','reply',                'auto', 0.50)
ON CONFLICT (agent, action) DO NOTHING;
