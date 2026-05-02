-- Seed n8n_executions with 5 fake runs across 3 workflows.
-- Includes one deliberately P95-slow run so Davari has something to flag.
-- Idempotent via the test-tag in id prefix.
DELETE FROM n8n_executions WHERE id LIKE 'davari-test-%';

INSERT INTO n8n_executions (id, workflow, started_at, finished_at, duration_ms, status, retries, node_breakdown, payload_size_bytes) VALUES
  ('davari-test-001', 'wf:01-content-distribute', NOW() - INTERVAL '23 hours', NOW() - INTERVAL '23 hours' + INTERVAL '4 seconds',  4100, 'success', 0,
     '[{"node":"trigger","ms":12},{"node":"pg_select","ms":640},{"node":"http_run_agent","ms":2900},{"node":"pg_insert","ms":540}]'::jsonb, 28400),

  ('davari-test-002', 'wf:01-content-distribute', NOW() - INTERVAL '12 hours', NOW() - INTERVAL '12 hours' + INTERVAL '5 seconds',  5300, 'success', 0,
     '[{"node":"trigger","ms":10},{"node":"pg_select","ms":700},{"node":"http_run_agent","ms":3700},{"node":"pg_insert","ms":880}]'::jsonb, 31200),

  ('davari-test-003', 'wf:08-cross-post-dryrun', NOW() - INTERVAL '8 hours', NOW() - INTERVAL '8 hours' + INTERVAL '2 seconds',  1900, 'success', 0,
     '[{"node":"trigger","ms":12},{"node":"pg_select","ms":340},{"node":"format_message","ms":60},{"node":"console_log","ms":18}]'::jsonb, 18900),

  -- The deliberately slow one — http_run_agent took 21s, well above P95 baseline (~3000ms).
  ('davari-test-004', 'wf:01-content-distribute', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 hours' + INTERVAL '22 seconds', 21800, 'success', 2,
     '[{"node":"trigger","ms":11},{"node":"pg_select","ms":820},{"node":"http_run_agent","ms":21000},{"node":"pg_insert","ms":510}]'::jsonb, 32100),

  ('davari-test-005', 'wf:04-weekly-metrics', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours' + INTERVAL '6 seconds',  6200, 'success', 1,
     '[{"node":"trigger","ms":11},{"node":"pg_select","ms":1100},{"node":"http_run_agent","ms":4900},{"node":"smtp_send","ms":150}]'::jsonb, 41800);

SELECT id, workflow, duration_ms, retries, status FROM n8n_executions WHERE id LIKE 'davari-test-%' ORDER BY id;
