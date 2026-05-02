-- RxApply Test Phase — initial schema
-- Source: build-guide/04-database.html
-- Apply via:  supabase db reset    (after `supabase start`)
-- 16 tables: 14 core + scheduled_posts + nurture_schedule

-- ============================================================
-- 14 core tables
-- ============================================================

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  language text NOT NULL CHECK (language IN ('en','fa','ar','tr','hi','es','ko')),
  origin_country text,
  destination_intent text[],
  experience_years int,
  source text,
  engagement_score numeric(3,2) DEFAULT 0,
  tags jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id),
  email text NOT NULL,
  stripe_customer_id text UNIQUE,
  ltv_usd numeric(10,2) DEFAULT 0,
  products jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id),
  scheduled_at timestamptz NOT NULL,
  cal_event_id text,
  outcome text,
  notes text,
  follow_up_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE content_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  language_priorities text[],
  target_destinations text[],
  source text,  -- 'pooya' | 'reg_change' | 'manual'
  status text DEFAULT 'pending_g1',
  brief_json jsonb,
  approved_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE content_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id uuid REFERENCES content_briefs(id),
  language text NOT NULL,
  kind text NOT NULL,  -- 'master' | 'ig_carousel' | 'reel' | 'telegram' | 'fb' | 'email' | 'linkedin' | 'video'
  body_md text,
  body_json jsonb,
  citations jsonb DEFAULT '[]',
  status text DEFAULT 'pending_g2',
  published_url text,
  published_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE engagement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id),
  platform text NOT NULL,
  kind text NOT NULL,  -- 'dm' | 'comment' | 'click' | 'open' | 'reply' | 'page_view'
  language text,
  payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid REFERENCES content_assets(id),
  language text NOT NULL,
  reporter_lead_id uuid REFERENCES leads(id),
  before_text text,
  after_text text,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name text NOT NULL,
  contact_name text,
  contact_email text,
  country text,
  type text,  -- 'rcic' | 'oisc' | 'mara' | 'exam_prep' | 'university' | 'recruiter'
  status text DEFAULT 'targeted',
  outreach_drafts jsonb DEFAULT '[]',
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE guest_pipeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id),
  origin_country text,
  destination_country text,
  story_summary text,
  status text DEFAULT 'invited',
  episode_id text,
  release_form_signed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE intel_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,  -- 'roya' | 'shahed' | 'dadbeh' | 'nasim' | 'ramin'
  kind text NOT NULL,   -- 'market_heatmap' | 'competitor_diff' | 'reg_change' | 'trend_spike' | 'keyword_candidates'
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  workflow_run_id text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(8,4),
  duration_ms int,
  status text,  -- 'success' | 'fail' | 'retry'
  output_summary text,
  output_quality_flag text,
  founder_decision text,  -- 'approved' | 'rejected' | 'refined' | null
  created_at timestamptz DEFAULT now()
);

CREATE TABLE agent_efficiency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  date date NOT NULL,
  runs int,
  approval_ratio numeric(4,3),
  avg_cost_usd numeric(8,4),
  avg_duration_ms int,
  quality_score numeric(3,2),
  bidar_recommendation text,
  UNIQUE(agent, date)
);

CREATE TABLE approval_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate text NOT NULL,  -- 'G1' | 'G2' | 'G3' | 'G4' | 'DM_FA' | 'DM_AR' | etc
  source_agent text,
  artifact_kind text,
  artifact_id uuid,
  preview text,
  n8n_resume_url text,
  sla_at timestamptz,
  status text DEFAULT 'pending',
  founder_action text,
  founder_notes text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE n8n_executions (
  id text PRIMARY KEY,  -- n8n's exec id
  workflow text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms int,
  status text,
  retries int DEFAULT 0,
  node_breakdown jsonb,
  payload_size_bytes int
);

-- ============================================================
-- Free-tier replacements for Publer + MailerLite
-- ============================================================

CREATE TABLE scheduled_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid REFERENCES content_assets(id),
  platform text NOT NULL,    -- 'fb' | 'ig' | 'telegram' | 'linkedin' | 'youtube'
  account_key text NOT NULL, -- 'fb_en' | 'ig_fa' | 'telegram_ar' | etc
  language text NOT NULL,
  text text,
  media_urls text[],
  scheduled_at timestamptz NOT NULL,
  status text DEFAULT 'pending', -- 'pending' | 'posted' | 'failed' | 'skipped'
  published_url text,
  error_message text,
  attempts int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  posted_at timestamptz
);

CREATE TABLE nurture_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id),
  sequence_id text NOT NULL, -- 'fa_canada' | 'hi_uk' | 'en_intl' | etc
  step_number int NOT NULL,  -- 1..5
  email_subject text NOT NULL,
  email_html text NOT NULL,
  send_at timestamptz NOT NULL,
  status text DEFAULT 'queued', -- 'queued' | 'sent' | 'failed' | 'cancelled'
  resend_message_id text,
  created_at timestamptz DEFAULT now(),
  sent_at timestamptz,
  UNIQUE(lead_id, sequence_id, step_number)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX ON leads (language, engagement_score DESC);
CREATE INDEX ON content_assets (status, language);
CREATE INDEX ON engagement_events (platform, created_at DESC);
CREATE INDEX ON intel_snapshots (agent, created_at DESC);
CREATE INDEX ON agent_runs (agent, created_at DESC);
CREATE INDEX ON approval_queue (status, gate, sla_at);
CREATE INDEX ON scheduled_posts (status, scheduled_at) WHERE status = 'pending';
CREATE INDEX ON nurture_schedule (status, send_at) WHERE status = 'queued';

-- ============================================================
-- Row-level security
-- (Lock down sensitive lead data; agent service-role bypasses RLS)
-- ============================================================

ALTER TABLE leads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "founder_full_access" ON leads
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'role' = 'founder');

CREATE POLICY "founder_full_access" ON customers
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'role' = 'founder');

CREATE POLICY "founder_full_access" ON consultations
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'role' = 'founder');
