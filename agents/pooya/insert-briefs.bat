@echo off
set "ROOT=%~dp0"
echo Inserting briefs from %ROOT%briefs.json into content_briefs ...
echo.
python "%ROOT%pooya.py" insert < "%ROOT%briefs.json"
echo.
echo --- Verifying with a SELECT ---
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT id, title, source, status, array_length(language_priorities, 1) AS langs FROM content_briefs WHERE source='pooya' ORDER BY created_at DESC LIMIT 5;"
echo.
pause
