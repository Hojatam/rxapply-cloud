@echo off
:: Apply F6/F8b migration: image_model_defaults + pipelines table.
:: Idempotent: re-running is safe (IF NOT EXISTS everywhere).
title Apply F6+F8b migration
echo.
echo Applying 20260504000000_image_model_defaults.sql to local Supabase...
echo.

set MIG=%~dp0supabase\migrations\20260504000000_image_model_defaults.sql
if not exist "%MIG%" ( echo [FATAL] migration file not found: %MIG% & pause & exit /b 1 )

docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%MIG%"
if errorlevel 1 ( echo. & echo [FAIL] migration errored & pause & exit /b 1 )

echo.
echo [PASS] migration applied.
echo.
echo Verifying...
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\d dashboard_settings" | findstr "image_model_defaults"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\dt pipelines"
echo.
pause
