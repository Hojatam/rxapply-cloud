@echo off
title RxApply V2 quickstart
color 0B
echo.
echo ╔══════════════════════════════════════════════════════════════════╗
echo ║   RxApply V2 — apply migrations + restart proxy + run smoke test ║
echo ╚══════════════════════════════════════════════════════════════════╝
echo.
echo This will:
echo   1. Apply 4 new migrations (idempotent — safe to re-run)
echo   2. Kill any running cowork-proxy
echo   3. Start cowork-proxy fresh in a new window
echo   4. Wait 4s for startup
echo   5. Run smoke-v2.bat
echo.
pause

echo.
echo [1/5] Applying migrations (idempotent)...
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%~dp0supabase\migrations\20260501000000_logs_l2.sql"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%~dp0supabase\migrations\20260502000000_prompts_chats.sql"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%~dp0supabase\migrations\20260503000000_media_library.sql"
docker exec -i supabase_db_rxapply-test psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "%~dp0supabase\migrations\20260504000000_image_model_defaults.sql"
echo [OK] All 4 migrations applied.

echo.
echo [2/5] Killing existing cowork-proxy on :7777...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7777 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo.
echo [3/5] Starting cowork-proxy in a new window...
start "cowork-proxy v2" cmd /k "cd /d %~dp0cowork-proxy && node server.js"

echo.
echo [4/5] Waiting 4s for proxy to come up...
timeout /t 4 /nobreak >nul

echo.
echo [5/5] Running smoke-v2.bat...
call "%~dp0smoke-v2.bat"
