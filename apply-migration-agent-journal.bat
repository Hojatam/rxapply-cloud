@echo off
REM Applies the agent_journal migration WITHOUT wiping existing data.
REM (supabase db reset would replay all migrations on a fresh DB — destroys our test data.)
set "ROOT=%~dp0"
set "SQL=%ROOT%supabase\migrations\20260430000000_agent_journal.sql"

echo === Applying %SQL% ===
docker cp "%SQL%" supabase_db_rxapply-test:/tmp/agent_journal.sql
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -f /tmp/agent_journal.sql
echo.

echo === Verifying ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'agent_journal' ORDER BY ordinal_position;"
echo.

echo === Indexes ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_journal';"
echo.

echo === Confirm public-schema table count is now 17 (was 16) ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT count(*) AS public_tables FROM information_schema.tables WHERE table_schema='public';"
echo.

echo === Smoke insert + select ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "INSERT INTO agent_journal (agent, status, input_summary, output_summary, trigger_source) VALUES ('a1-migration-test', 'success', 'migration smoke test', 'agent_journal table is live', 'manual') RETURNING id;"
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT id, agent, status, input_summary, output_summary, created_at FROM agent_journal ORDER BY created_at DESC LIMIT 1;"
echo.
pause
