@echo off
:: Apply F7 prompt-versions + agent-chats + dashboard-settings.
:: Idempotent (CREATE TABLE IF NOT EXISTS).
title Apply F7 prompts-chats migration
echo Applying 20260502000000_prompts_chats.sql ...
echo.
set MIG=%~dp0supabase\migrations\20260502000000_prompts_chats.sql
if not exist "%MIG%" ( echo [FATAL] migration file not found: %MIG% & pause & exit /b 1 )
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%MIG%"
if errorlevel 1 ( echo [FAIL] migration errored & pause & exit /b 1 )
echo.
echo [PASS] migration applied. Verify:
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\dt prompt_versions agent_chats dashboard_settings"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT id, sandbox_mode, monthly_cap_usd FROM dashboard_settings;"
echo.
pause
