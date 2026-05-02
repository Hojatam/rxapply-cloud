@echo off
set "ROOT=%~dp0"
REM Saeed's most recent FA DM about AFK timing — pulled from saeed-events.json earlier.
REM Either DM id works (they're duplicates); using the more recent one.
set "DM_ID=8e3a870f-f853-4310-8952-6632561f131f"

echo === Saving Mehrban FA reply to Saeed's DM ===
python "%ROOT%mehrban.py" save --reply-to-event-id %DM_ID% --language fa --file "%ROOT%reply-saeed-fa.md"
echo.

echo === Verifying via SELECT ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT id::text AS id, kind, platform, language, payload->>'has_disclaimer' AS has_disclaimer, payload->>'has_target_script' AS has_target_script, payload->>'word_count' AS words FROM engagement_events WHERE kind='reply' AND payload->>'in_reply_to' = '%DM_ID%' ORDER BY created_at DESC LIMIT 3;"
echo.

echo === T8 pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT language, (payload->>'has_target_script')::bool AS farsi, (payload->>'has_disclaimer')::bool AS disclaimer, CASE WHEN language='fa' AND (payload->>'has_target_script')::bool AND (payload->>'has_disclaimer')::bool THEN 'PASS' ELSE 'FAIL' END AS scorecard_t8 FROM engagement_events WHERE kind='reply' AND payload->>'in_reply_to' = '%DM_ID%' ORDER BY created_at DESC LIMIT 1;"
echo.
pause
