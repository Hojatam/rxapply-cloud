-- =====================================================================
-- M105 · Hierarchical Knowledge Base
-- ---------------------------------------------------------------------
-- Adds tree structure to knowledge_base:
--   country → topic (visa/exam/courses/fees/tax/QoL/...) → subtopic
-- Plus a founder-managed taxonomy table (kb_topics) so the tree itself
-- is editable from the dashboard, not hardcoded in app code.
--
-- All changes are additive — existing rows keep working. Old `category`
-- column remains for back-compat; we backfill its value into `topic`.
-- =====================================================================

-- ── Extend knowledge_base ─────────────────────────────────────────────
ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS topic       text,
  ADD COLUMN IF NOT EXISTS subtopic    text,
  ADD COLUMN IF NOT EXISTS parent_id   uuid REFERENCES knowledge_base(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by  text;

CREATE INDEX IF NOT EXISTS kb_topic_idx     ON knowledge_base (country, topic, subtopic);
CREATE INDEX IF NOT EXISTS kb_parent_idx    ON knowledge_base (parent_id);

-- Backfill: copy category → topic, normalising synonyms.
--   'cost'      → 'fees'         (founder vocab)
--   'milestone' → 'timeline'     (collapse near-duplicate)
UPDATE knowledge_base SET topic = CASE category
  WHEN 'cost'      THEN 'fees'
  WHEN 'milestone' THEN 'timeline'
  ELSE category
END
WHERE topic IS NULL;

-- ── Founder-managed taxonomy ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_topics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country       text NOT NULL,
  topic_slug    text NOT NULL,
  subtopic_slug text,
  display_name  text NOT NULL,
  description   text,
  parent_id     uuid REFERENCES kb_topics(id) ON DELETE SET NULL,
  display_order int DEFAULT 100,
  enabled       boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (country, topic_slug, subtopic_slug)
);

CREATE INDEX IF NOT EXISTS kb_topics_country_idx
  ON kb_topics (country, topic_slug, subtopic_slug)
  WHERE enabled = true;

-- Seed: one row per (country, top-level topic) for the launch countries.
-- Founder will add subtopics as the KB grows. These are STARTING POINTS,
-- not hardcoded enums — every row is editable / disable-able / deletable.
INSERT INTO kb_topics (country, topic_slug, subtopic_slug, display_name, description, display_order) VALUES
  -- GLOBAL: catch-all facts that apply across countries
  ('GLOBAL','visa',            NULL, 'Visa',             'Cross-country visa context (Schengen, Common Travel Area, etc.)', 10),
  ('GLOBAL','exam',            NULL, 'Exam',             'Cross-country exam context (PLAB-IELTS-like, OET, etc.)',         20),
  ('GLOBAL','courses',         NULL, 'Courses',          'International dental CE / online certifications',                  30),
  ('GLOBAL','fees',            NULL, 'Fees',             'Currency conversions, generic licensing fee context',              40),
  ('GLOBAL','tax',             NULL, 'Tax',              'Cross-border tax considerations (FEIE, treaties)',                 50),
  ('GLOBAL','quality_of_life', NULL, 'Quality of life',  'Cost-of-living indices, language environment notes',              60),
  ('GLOBAL','regulator',       NULL, 'Regulators',       'Cross-country regulatory notes (mutual recognition, etc.)',       70),
  ('GLOBAL','timeline',        NULL, 'Timeline',         'Generic migration timeline patterns',                              80),
  ('GLOBAL','document',        NULL, 'Documents',        'Document conventions (apostille, certified translation)',          90),
  ('GLOBAL','other',           NULL, 'Other',            'Misc',                                                            999),

  -- UK
  ('UK','visa',            NULL, 'Visa',             'Tier 2 Skilled Worker, Health and Care, Standard Visitor, etc.', 10),
  ('UK','exam',            NULL, 'Exam',             'ORE Part 1, ORE Part 2, LDS RCS',                                 20),
  ('UK','courses',         NULL, 'Courses',          'GDC-recognised CE, postgraduate diplomas',                        30),
  ('UK','fees',            NULL, 'Fees',             'GDC ARF, ORE fees, NHS contract financials',                       40),
  ('UK','tax',             NULL, 'Tax',              'Self-assessment, NI, council tax, scope of tax residency',         50),
  ('UK','quality_of_life', NULL, 'Quality of life',  'Housing costs, NHS access, schooling, regional differences',       60),
  ('UK','regulator',       NULL, 'Regulator',        'GDC',                                                              70),
  ('UK','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('UK','document',        NULL, 'Documents',        'CoS, IELTS/OET, transcripts, certified translation',              90),
  ('UK','other',           NULL, 'Other',            'Misc',                                                            999),

  -- USA
  ('USA','visa',            NULL, 'Visa',             'J-1, H-1B, EB-2 NIW, F-1, TN, etc.',                              10),
  ('USA','exam',            NULL, 'Exam',             'INBDE, ADAT, NBDE, state board exams',                            20),
  ('USA','courses',         NULL, 'Courses',          'CODA-accredited programs, advanced standing',                      30),
  ('USA','fees',            NULL, 'Fees',             'Tuition, exam fees, licensure',                                    40),
  ('USA','tax',             NULL, 'Tax',              'Federal + state, FBAR, treaty positions',                          50),
  ('USA','quality_of_life', NULL, 'Quality of life',  'Cost of living by state, healthcare, schooling',                   60),
  ('USA','regulator',       NULL, 'Regulator',        'ADA / state boards / CDCA / WREB',                                 70),
  ('USA','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('USA','document',        NULL, 'Documents',        'ECE/WES evaluation, transcripts, recommendation letters',         90),
  ('USA','other',           NULL, 'Other',            'Misc',                                                            999),

  -- DE (Germany)
  ('DE','visa',            NULL, 'Visa',             'Approbation pathway, EU Blue Card, Niederlassungserlaubnis',      10),
  ('DE','exam',            NULL, 'Exam',             'Kenntnisprüfung, Fachsprachprüfung',                              20),
  ('DE','courses',         NULL, 'Courses',          'Sprachkurs B2/C1, Vorbereitungskurs',                              30),
  ('DE','fees',            NULL, 'Fees',             'Approbation, course fees, language tests',                        40),
  ('DE','tax',             NULL, 'Tax',              'Lohnsteuer, Steuerklasse, Kirchensteuer',                         50),
  ('DE','quality_of_life', NULL, 'Quality of life',  'Krankenversicherung, Mietpreise, Schulen',                        60),
  ('DE','regulator',       NULL, 'Regulator',        'Landeszahnärztekammer per Bundesland',                             70),
  ('DE','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('DE','document',        NULL, 'Documents',        'Anerkennung, beglaubigte Übersetzungen, Apostille',                90),
  ('DE','other',           NULL, 'Other',            'Misc',                                                            999),

  -- AU (Australia)
  ('AU','visa',            NULL, 'Visa',             'Subclass 482, 186, 189, 190; PR pathways',                        10),
  ('AU','exam',            NULL, 'Exam',             'ADC Initial Assessment, ADC Written, ADC Practical',              20),
  ('AU','courses',         NULL, 'Courses',          'Bridging courses, AHPRA-recognised CE',                            30),
  ('AU','fees',            NULL, 'Fees',             'AHPRA, ADC exam fees, visa fees',                                  40),
  ('AU','tax',             NULL, 'Tax',              'ATO, GST, tax residency, super',                                   50),
  ('AU','quality_of_life', NULL, 'Quality of life',  'Cost of living by state, Medicare, schooling',                     60),
  ('AU','regulator',       NULL, 'Regulator',        'Dental Board of Australia / AHPRA / ADC',                          70),
  ('AU','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('AU','document',        NULL, 'Documents',        'Transcripts, ADC evaluation packs, English tests',                90),
  ('AU','other',           NULL, 'Other',            'Misc',                                                            999),

  -- CA (Canada)
  ('CA','visa',            NULL, 'Visa',             'Express Entry, PNP, work permits, study permits',                  10),
  ('CA','exam',            NULL, 'Exam',             'NDEB AFK, ACS, ACJ, NDECC',                                        20),
  ('CA','courses',         NULL, 'Courses',          'IDAPP, qualifying programs, CE',                                   30),
  ('CA','fees',            NULL, 'Fees',             'NDEB, provincial licensing, immigration',                          40),
  ('CA','tax',             NULL, 'Tax',              'CRA, provincial tax, GST/HST/PST',                                 50),
  ('CA','quality_of_life', NULL, 'Quality of life',  'Cost of living by province, healthcare, schooling',                60),
  ('CA','regulator',       NULL, 'Regulator',        'NDEB + provincial regulatory bodies',                              70),
  ('CA','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('CA','document',        NULL, 'Documents',        'WES/ECA evaluation, transcripts, language tests',                  90),
  ('CA','other',           NULL, 'Other',            'Misc',                                                            999),

  -- UAE
  ('UAE','visa',            NULL, 'Visa',             'Employment visa, Golden Visa, family',                            10),
  ('UAE','exam',            NULL, 'Exam',             'DHA / DOH / MOH licensing exams',                                 20),
  ('UAE','courses',         NULL, 'Courses',          'CME for MOH/DHA/DOH renewal',                                     30),
  ('UAE','fees',            NULL, 'Fees',             'Eligibility, exam, licensing, Pearson VUE',                       40),
  ('UAE','tax',             NULL, 'Tax',              'Personal income tax (none), corporate tax notes',                 50),
  ('UAE','quality_of_life', NULL, 'Quality of life',  'Cost of living by emirate, schooling',                            60),
  ('UAE','regulator',       NULL, 'Regulator',        'MOHAP / DHA / DOH',                                               70),
  ('UAE','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('UAE','document',        NULL, 'Documents',        'Attestation chain, Dataflow PSV',                                  90),
  ('UAE','other',           NULL, 'Other',            'Misc',                                                            999),

  -- SA (Saudi Arabia)
  ('SA','visa',            NULL, 'Visa',             'Iqama / work permit, family visa',                                 10),
  ('SA','exam',            NULL, 'Exam',             'SDLE (SCFHS)',                                                     20),
  ('SA','courses',         NULL, 'Courses',          'CME for SCFHS classification',                                     30),
  ('SA','fees',            NULL, 'Fees',             'Mumaris+, exam, classification',                                   40),
  ('SA','tax',             NULL, 'Tax',              'Personal income tax (none), Zakat / VAT context',                  50),
  ('SA','quality_of_life', NULL, 'Quality of life',  'Cost of living by city, schooling',                                60),
  ('SA','regulator',       NULL, 'Regulator',        'SCFHS',                                                            70),
  ('SA','timeline',        NULL, 'Timeline',         'End-to-end migration milestones',                                  80),
  ('SA','document',        NULL, 'Documents',        'Mumaris+ workflow, Dataflow PSV, SCFHS classification',            90),
  ('SA','other',           NULL, 'Other',            'Misc',                                                            999)

ON CONFLICT (country, topic_slug, subtopic_slug) DO NOTHING;
