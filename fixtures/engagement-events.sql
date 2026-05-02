-- Insert 3 engagement events (Instagram DMs) joined to existing leads by email.
-- Replaces the broken \COPY approach: ig-dms-sample.csv had fabricated lead_ids that
-- don't match the real UUIDs Postgres assigns at insert time.

INSERT INTO engagement_events (lead_id, platform, kind, language, payload)
SELECT l.id, 'instagram', 'dm', 'fa',
       '{"text":"salam, tarikh emtahan AFK chand mahe digar mishe?","sender_handle":"@saeed_dent"}'::jsonb
FROM leads l WHERE l.email = 'saeed.tehrani@example.com'
UNION ALL
SELECT l.id, 'instagram', 'dm', 'ar',
       '{"text":"hi, do I need DHA license to work in Dubai as a dentist trained in Egypt?","sender_handle":"@dr_amira"}'::jsonb
FROM leads l WHERE l.email = 'amira.hassan@example.com'
UNION ALL
SELECT l.id, 'instagram', 'dm', 'en',
       '{"text":"is RxApply guide updated for the 2026 NDEB changes?","sender_handle":"@jbrown_dds"}'::jsonb
FROM leads l WHERE l.email = 'james.brown@example.com';
