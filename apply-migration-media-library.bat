@echo off
title Apply F8 media_library migration
echo Applying 20260503000000_media_library.sql ...
echo.
set MIG=%~dp0supabase\migrations\20260503000000_media_library.sql
if not exist "%MIG%" ( echo [FATAL] migration file not found: %MIG% & pause & exit /b 1 )
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%MIG%"
if errorlevel 1 ( echo [FAIL] migration errored & pause & exit /b 1 )
echo.
echo [PASS] migration applied. Verify:
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\dt media_library"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -c "\d media_library"
echo.
pause
