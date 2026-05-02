@echo off
set "ROOT=%~dp0"
set "SAEED=d6e4be83-8f84-43ab-ba08-59e029e5cd27"

echo === Saving Bineh score for Saeed ===
python "%ROOT%bineh.py" save --lead-id %SAEED% --score 0.80
echo.

echo === Verifying via SELECT ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT id::text AS id, email, language, origin_country, engagement_score FROM leads WHERE id = '%SAEED%';"
echo.

echo === T9 pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT email, engagement_score, CASE WHEN engagement_score IS NOT NULL AND engagement_score BETWEEN 0 AND 1 THEN 'PASS (numeric in [0,1])' ELSE 'FAIL' END AS scorecard_t9 FROM leads WHERE id = '%SAEED%';"
echo.
pause
