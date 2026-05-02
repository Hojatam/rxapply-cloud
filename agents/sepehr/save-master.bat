@echo off
REM Saves article-001.md as the EN master for brief df7d2847... (NDEB AFK Iranian-Canada).
set "ROOT=%~dp0"
set "BRIEF=df7d2847-a0a9-4071-8cb7-17bf05ea779c"

echo Saving %ROOT%article-001.md
echo Brief id: %BRIEF%
echo.

python "%ROOT%sepehr.py" save --brief-id %BRIEF% --language en --kind master < "%ROOT%article-001.md"
echo.

echo --- Verifying with a SELECT ---
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT id, language, kind, status, length(body_md) AS chars, body_json FROM content_assets WHERE brief_id = '%BRIEF%' AND kind='master' ORDER BY created_at DESC LIMIT 3;"
echo.

echo --- T2 pass check ---
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT (body_json->>'word_count')::int AS words, (body_json->>'citation_count')::int AS citations, (body_json->>'h2_count')::int AS h2_sections, CASE WHEN (body_json->>'word_count')::int >= 1500 AND (body_json->>'citation_count')::int >= 3 THEN 'PASS' ELSE 'FAIL' END AS scorecard_t2 FROM content_assets WHERE brief_id = '%BRIEF%' AND kind='master' ORDER BY created_at DESC LIMIT 1;"
echo.

pause
