@echo off
setlocal enabledelayedexpansion
title Move workspace OneDrive -> C:\dev\rxapply-test
color 0B

:: ============================================================
::  move-to-c-dev.bat
::  -----------------
::  Migrates the rxapply-test workspace from OneDrive to C:\dev\
::  Why: OneDrive's file locking + sync interferes with Docker
::  volumes, log writes, and concurrent file access. C:\dev\ is
::  outside any sync, fast, and predictable.
::
::  This script is idempotent up to the robocopy step. After
::  robocopy succeeds, the new folder becomes the source of truth.
::
::  WARNING: this stops Docker containers. n8n + Supabase have a
::  brief downtime. Run when no live work is in flight.
:: ============================================================

set SRC=C:\Users\Hojat\OneDrive\Desktop\rxapply-test
set DEST=C:\dev\rxapply-test

echo.
echo  ============================================================
echo   RxApply workspace move
echo   FROM: %SRC%
echo   TO  : %DEST%
echo  ============================================================
echo.

:: ── 0. Sanity ──────────────────────────────────────────────────
if not exist "%SRC%" ( echo [FATAL] source not found: %SRC% & pause & exit /b 1 )
if exist "%DEST%" (
  echo [WARN] destination already exists: %DEST%
  echo        If this is a re-run, the script can continue (robocopy /MIR is idempotent^).
  echo        If this is a fresh attempt, delete %DEST% first to avoid mixing states.
  set /p CONTINUE="Continue anyway (Y/N)? "
  if /I not "!CONTINUE!"=="Y" exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 ( echo [FATAL] docker not on PATH & pause & exit /b 1 )

where robocopy >nul 2>&1
if errorlevel 1 ( echo [FATAL] robocopy not found ^(comes with Windows^) & pause & exit /b 1 )

:: ── 1. Backup Postgres ─────────────────────────────────────────
echo.
echo [1/8] Backup Postgres via pg_dump
set BACKUP_FILE=%SRC%\backups\pre-move-%date:~10,4%%date:~4,2%%date:~7,2%-%time:~0,2%%time:~3,2%.sql
set BACKUP_FILE=%BACKUP_FILE: =0%
if not exist "%SRC%\backups" mkdir "%SRC%\backups"

docker exec supabase_db_rxapply-test pg_dump -U postgres -d postgres > "%BACKUP_FILE%" 2>nul
if errorlevel 1 (
  echo   [WARN] pg_dump failed ^(container may not be running^). Continuing without DB backup.
  echo   If you need the data, start Supabase first then re-run.
  set /p CONTINUE="Continue without DB backup (Y/N)? "
  if /I not "!CONTINUE!"=="Y" exit /b 1
) else (
  for %%I in ("%BACKUP_FILE%") do echo   ✓ DB dumped: %%~zI bytes -^> %BACKUP_FILE%
)

:: ── 2. Stop services in order ──────────────────────────────────
echo.
echo [2/8] Stop services
echo   - stopping cowork-proxy (kill node on :7777)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7777 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
echo   - stopping Supabase containers
cd /d "%SRC%"
call supabase stop >nul 2>&1
echo   - stopping n8n container
docker stop n8n >nul 2>&1
echo   - stopping MailHog container
docker stop mailhog >nul 2>&1
echo   ✓ services stopped

timeout /t 3 /nobreak >nul

:: ── 3. Make destination ────────────────────────────────────────
echo.
echo [3/8] Prepare destination
if not exist "C:\dev" mkdir C:\dev
if not exist "%DEST%" mkdir "%DEST%"
echo   ✓ %DEST% ready

:: ── 4. Robocopy ────────────────────────────────────────────────
echo.
echo [4/8] Copy files (robocopy /MIR, excludes node_modules + .git)
echo   This may take 2-5 minutes depending on your disk.
robocopy "%SRC%" "%DEST%" /MIR /XD node_modules .git /XF *.tmp /R:1 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP
:: robocopy exit codes: 0-7 are success-ish, 8+ are failures
if errorlevel 8 ( echo [FATAL] robocopy failed with exit %errorlevel% & pause & exit /b 1 )
echo   ✓ files copied

:: ── 5. Reinstall node deps in new location ─────────────────────
echo.
echo [5/8] Reinstall cowork-proxy node_modules
cd /d "%DEST%\cowork-proxy"
call npm install --silent
if errorlevel 1 ( echo [FATAL] npm install failed in new location & pause & exit /b 1 )
echo   ✓ node_modules installed

:: ── 6. Update .bat files that hardcode the old path ────────────
echo.
echo [6/8] Patch .bat files that reference the old path
:: We do this with a tiny PowerShell one-liner so we don't hand-roll sed
powershell -NoProfile -Command ^
  "Get-ChildItem -Path '%DEST%' -Recurse -Include *.bat | ForEach-Object { (Get-Content $_.FullName -Raw) -replace [regex]::Escape('%SRC%'), '%DEST%' | Set-Content $_.FullName -NoNewline }"
echo   ✓ paths updated

:: ── 7. Restart services from new location ──────────────────────
echo.
echo [7/8] Restart services from new location
cd /d "%DEST%"
echo   - supabase start (may take ~60s)
call supabase start
if errorlevel 1 ( echo [WARN] supabase start failed - check 'supabase status' )

echo   - n8n
docker start n8n >nul 2>&1
echo   - mailhog
docker start mailhog >nul 2>&1

:: cowork-proxy: prompt the user — it owns its own terminal window
echo.
echo   Cowork-proxy needs its own terminal. Run from %DEST%:
echo     start-proxy.bat
echo.

:: ── 8. Post-flight ─────────────────────────────────────────────
echo.
echo [8/8] Post-flight checks
echo   - Supabase health:
curl -s -o nul -w "    REST API: %%{http_code}\n" http://localhost:54321/rest/v1/ 2>nul
echo   - n8n health:
curl -s -o nul -w "    n8n     : %%{http_code}\n" http://localhost:5678/healthz 2>nul
echo   - MailHog health:
curl -s -o nul -w "    MailHog : %%{http_code}\n" http://localhost:8025/api/v2/messages?limit=1 2>nul

echo.
echo  ============================================================
echo   ✓ Move complete
echo  ============================================================
echo.
echo   Next:
echo     1. Open a new terminal in %DEST%
echo     2. Run: start-proxy.bat
echo     3. Open: %DEST%\dashboard.html
echo     4. Smoke: smoke-everything.bat
echo.
echo   The old folder still exists at %SRC% — verify the move worked
echo   for at least 1 day before deleting it.
echo.
pause
