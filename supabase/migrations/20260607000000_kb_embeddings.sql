-- =====================================================================
-- M106 · Semantic embeddings for the Knowledge Base
-- ---------------------------------------------------------------------
-- Adds pgvector + embedding column to knowledge_base. Each row's
-- title + content + facts + tags are embedded with OpenAI's
-- text-embedding-3-small (1536 dims). Recall becomes hybrid: keyword
-- score + cosine similarity + importance/recency.
-- =====================================================================

-- pgvector extension. Supabase Postgres supports this directly.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS embedding         vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_status  text DEFAULT 'pending'
                                              CHECK (embedding_status IN ('pending','ready','failed','skipped')),
  ADD COLUMN IF NOT EXISTS embedding_error   text,
  ADD COLUMN IF NOT EXISTS embedded_at       timestamptz,
  ADD COLUMN IF NOT EXISTS embedding_model   text;

-- HNSW index for cosine-distance ANN search. ef_construction default
-- works fine at our scale; bump if recall quality drops.
CREATE INDEX IF NOT EXISTS kb_embedding_hnsw_idx
  ON knowledge_base USING hnsw (embedding vector_cosine_ops);

-- Status index so the backfill job can scan only what it needs.
CREATE INDEX IF NOT EXISTS kb_embedding_status_idx
  ON knowledge_base (embedding_status)
  WHERE embedding_status = 'pending';

-- Existing rows: they were created before embeddings landed. Mark them
-- 'pending' so the backfill picks them up. Newly-inserted rows already
-- default to 'pending' via the column default above.
UPDATE knowledge_base SET embedding_status = 'pending' WHERE embedding_status IS NULL;
