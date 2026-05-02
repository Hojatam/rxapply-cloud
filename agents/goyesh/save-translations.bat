@echo off
REM Saves the FA + AR translations as content_assets rows tied to brief df7d2847.
set "ROOT=%~dp0"
set "MASTER=c8b76465-7c29-4730-81fb-12b85ee97db1"

echo === Saving FA translation ===
python "%ROOT%goyesh.py" save --master-id %MASTER% --language fa --file "%ROOT%article-001-fa.md"
echo.

echo === Saving AR translation ===
python "%ROOT%goyesh.py" save --master-id %MASTER% --language ar --file "%ROOT%article-001-ar.md"
echo.

echo === All masters for the brief ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT language, kind, status, length(body_md) AS chars, body_json FROM content_assets WHERE brief_id = (SELECT brief_id FROM content_assets WHERE id = '%MASTER%') AND kind='master' ORDER BY language;"
echo.

echo === T3 pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "WITH en AS (SELECT (body_json->>'word_count')::int AS w, (body_json->>'citation_count')::int AS c FROM content_assets WHERE id = '%MASTER%') SELECT a.language, (a.body_json->>'word_count')::int AS words, (a.body_json->>'citation_count')::int AS citations, (a.body_json->>'h2_count')::int AS h2, (a.body_json->>'has_target_script')::bool AS has_script, ROUND(100.0 * (a.body_json->>'word_count')::int / en.w, 0) || '%%' AS pct_of_en, CASE WHEN a.language='en' THEN '(baseline)' WHEN (a.body_json->>'has_target_script')::bool AND (a.body_json->>'word_count')::int >= en.w * 0.8 AND (a.body_json->>'citation_count')::int >= en.c * 0.8 THEN 'PASS' ELSE 'FAIL' END AS scorecard FROM content_assets a CROSS JOIN en WHERE a.brief_id = (SELECT brief_id FROM content_assets WHERE id = '%MASTER%') AND a.kind='master' ORDER BY a.language;"
echo.

pause
