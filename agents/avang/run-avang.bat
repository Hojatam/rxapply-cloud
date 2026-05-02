@echo off
set "ROOT=%~dp0"
set "BRIEF=df7d2847-a0a9-4071-8cb7-17bf05ea779c"

echo === Running Avang fan-out for brief %BRIEF% ===
python "%ROOT%avang.py" run --brief-id %BRIEF%
echo.

echo === Verifying scheduled_posts for this brief ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT platform, account_key, language, status, scheduled_at::timestamp(0) AS scheduled_at, length(text) AS chars FROM scheduled_posts WHERE asset_id IN (SELECT id FROM content_assets WHERE brief_id='%BRIEF%' AND kind='master') ORDER BY platform, language;"
echo.

echo === T4 pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT COUNT(*) AS rows_for_brief, COUNT(*) FILTER (WHERE platform='ig') AS ig, COUNT(*) FILTER (WHERE platform='fb') AS fb, COUNT(*) FILTER (WHERE platform='telegram') AS tg, COUNT(*) FILTER (WHERE platform='linkedin') AS li, COUNT(*) FILTER (WHERE platform='youtube') AS yt, CASE WHEN COUNT(*) = 11 THEN 'PASS' ELSE 'FAIL' END AS scorecard_t4 FROM scheduled_posts WHERE asset_id IN (SELECT id FROM content_assets WHERE brief_id='%BRIEF%' AND kind='master');"
echo.
pause
