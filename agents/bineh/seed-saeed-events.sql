-- Top up Saeed's engagement history so Bineh has at least 5 distinct signals to score on.
-- Idempotent: deletes any prior bineh-seed rows by payload tag, then re-inserts.
DELETE FROM engagement_events
 WHERE payload ? 'bineh_test_seed';

INSERT INTO engagement_events (lead_id, platform, kind, language, payload)
SELECT l.id, 'web', 'advisor_completion', 'fa',
       '{"bineh_test_seed":true,"score":78,"top_destination":"canada","completed_at":"2026-04-22T10:14:00Z"}'::jsonb
FROM leads l WHERE l.email='saeed.tehrani@example.com'
UNION ALL
SELECT l.id, 'web', 'page_view', 'fa',
       '{"bineh_test_seed":true,"path":"/guide/canada","time_on_page_s":420}'::jsonb
FROM leads l WHERE l.email='saeed.tehrani@example.com'
UNION ALL
SELECT l.id, 'email', 'open', 'fa',
       '{"bineh_test_seed":true,"sequence":"fa-canada-v1","step":2}'::jsonb
FROM leads l WHERE l.email='saeed.tehrani@example.com'
UNION ALL
SELECT l.id, 'email', 'click', 'fa',
       '{"bineh_test_seed":true,"sequence":"fa-canada-v1","step":2,"link":"/guide/ndeb-afk-monthly"}'::jsonb
FROM leads l WHERE l.email='saeed.tehrani@example.com'
UNION ALL
SELECT l.id, 'web', 'page_view', 'fa',
       '{"bineh_test_seed":true,"path":"/pricing","time_on_page_s":210}'::jsonb
FROM leads l WHERE l.email='saeed.tehrani@example.com';

SELECT lead_id, kind, payload->>'bineh_test_seed' AS test_seed
FROM engagement_events
WHERE lead_id = (SELECT id FROM leads WHERE email='saeed.tehrani@example.com')
ORDER BY created_at DESC;
