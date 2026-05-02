@echo off
:: Apply F2 Logs L2 migration to the local Supabase Postgres.
:: Idempotent: re-running is safe (uses ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).
title Apply F2 logs-l2 migration
echo.
echo Applying 20260501000000_logs_l2.sql to local Supabase...
echo.

set MIG=%~dp0supabase\migrations\20260501000000_logs_l2.sql
if not exist "%MIG%" ( echo [FATAL] migration file not found: %MIG% & pause & exit /b 1 )

docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%MIG%"
if errorlevel 1 ( echo. & echo [FAIL] migration errored & pause & exit /b 1 )

echo.
echo [PASS] migration applied. Verify:
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\d+ agent_runs" | findstr "input_payload output_payload error_payload log_file_path cost_usd_actual"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\dt agent_actions"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\dv v_run_log_summary"

echo.
pause
