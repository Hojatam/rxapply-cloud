@echo off
setlocal enabledelayedexpansion
title smoke-v2 (Phase F end-to-end)
color 0B

:: =========================================================================
::  smoke-v2.bat — verifies Phase F additions land cleanly.
::
::  Checks (each step prints PASS/FAIL):
::    1. cowork-proxy is listening on :7777 (and reports F2/F7 features)
::    2. Four migrations are applied
::         a. agent_actions + agent_runs.{input/output/error/log/cost} columns
::         b. prompt_versions, agent_chats, dashboard_settings
::         c. media_library
::         d. pipelines + image_model_defaults column
::    3. F2 — /logs route returns shape; a /run-helper invocation creates
::            a log file under logs/YYYY-MM-DD/
::    4. F3 — /services lists 4 services with status
::    5. F4 — /n8n/workflows responds (200 or clear "key missing" error)
::    6. F5 — /agent/zirak/chat responds (200 or 503 if no Anthropic key)
::    7. F7 — /auth/status responds
::    8. F8 — /afshin/gallery responds
::    9. F9 — /cost responds
::   10. F6 — /pipelines responds with pipelines array
::   11. F8b — /afshin/models registry includes gpt-image-1 + recraft-v3
:: =========================================================================

set PROXY=http://localhost:7777
set CONTAINER=supabase_db_rxapply-test
set FAILS=0

echo.
echo ╔══════════════════════════════════════════════════════════════════╗
echo ║   smoke-v2 · phase F verification                                ║
echo ╚══════════════════════════════════════════════════════════════════╝

:: ── 1. Proxy alive ─────────────────────────────────────────────────────
echo.
echo [1] Proxy /health
curl -s -o "%TEMP%\health.json" -w "  HTTP %%{http_code}" %PROXY%/health > "%TEMP%\health.code"
type "%TEMP%\health.code"
echo.
findstr /C:"\"ok\":true" "%TEMP%\health.json" >nul
if errorlevel 1 (echo   [FAIL] proxy not responding & set /a FAILS+=1) else (echo   [PASS] proxy is up)
findstr /C:"logsL2" "%TEMP%\health.json" >nul
if errorlevel 1 (echo   [FAIL] /health does not list F2 logsL2 feature & set /a FAILS+=1) else (echo   [PASS] features field present)

:: ── 2. Migrations ──────────────────────────────────────────────────────
echo.
echo [2a] Migration: agent_actions table
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT 1 FROM information_schema.tables WHERE table_name='agent_actions';" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] agent_actions missing - run apply-migration-logs-l2.bat & set /a FAILS+=1) else (echo   [PASS] agent_actions exists)

echo [2a] Migration: agent_runs.input_payload column
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT 1 FROM information_schema.columns WHERE table_name='agent_runs' AND column_name='input_payload';" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] agent_runs.input_payload missing - run apply-migration-logs-l2.bat & set /a FAILS+=1) else (echo   [PASS] L2 columns present)

echo [2b] Migration: prompt_versions table
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT 1 FROM information_schema.tables WHERE table_name='prompt_versions';" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] prompt_versions missing - run apply-migration-prompts-chats.bat & set /a FAILS+=1) else (echo   [PASS] prompt_versions exists)

echo [2b] Migration: dashboard_settings singleton
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT id FROM dashboard_settings WHERE id=1;" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] dashboard_settings row missing - run apply-migration-prompts-chats.bat & set /a FAILS+=1) else (echo   [PASS] dashboard_settings seeded)

echo [2c] Migration: media_library table
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT 1 FROM information_schema.tables WHERE table_name='media_library';" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] media_library missing - run apply-migration-media-library.bat & set /a FAILS+=1) else (echo   [PASS] media_library exists)

echo [2d] Migration: pipelines table + image_model_defaults column
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT 1 FROM information_schema.tables WHERE table_name='pipelines';" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] pipelines table missing - run apply-migration-f6-models.bat & set /a FAILS+=1) else (echo   [PASS] pipelines table exists)
docker exec %CONTAINER% psql -U postgres -d postgres -tA -c "SELECT 1 FROM information_schema.columns WHERE table_name='dashboard_settings' AND column_name='image_model_defaults';" 2>nul | findstr "1" >nul
if errorlevel 1 (echo   [FAIL] image_model_defaults column missing - run apply-migration-f6-models.bat & set /a FAILS+=1) else (echo   [PASS] image_model_defaults column exists)

:: ── 3. F2 logs round-trip ──────────────────────────────────────────────
echo.
echo [3] F2 logs round-trip — invoke zirak then check it appears in /logs
curl -s -o "%TEMP%\zirak.json" -X POST -H "Content-Type: application/json" ^
  -d "{\"agent\":\"zirak\",\"command\":\"help\"}" %PROXY%/run-helper > nul
findstr /C:"\"ok\":true" "%TEMP%\zirak.json" >nul
if errorlevel 1 (
  echo   [WARN] zirak help failed - skipping log roundtrip check
) else (
  for /f "tokens=2 delims=:," %%a in ('findstr "runId" "%TEMP%\zirak.json"') do set RUN_ID=%%a
  set RUN_ID=!RUN_ID:"=!
  set RUN_ID=!RUN_ID: =!
  echo   created run: !RUN_ID!
  curl -s "%PROXY%/logs?agent=zirak&limit=5" -o "%TEMP%\logs.json"
  findstr /C:"\"agent\":\"zirak\"" "%TEMP%\logs.json" >nul
  if errorlevel 1 (echo   [FAIL] zirak run not in /logs response & set /a FAILS+=1) else (echo   [PASS] log appears in /logs)
)

:: ── 4. F3 services ─────────────────────────────────────────────────────
echo.
echo [4] F3 services
curl -s "%PROXY%/services" -o "%TEMP%\services.json"
findstr /C:"supabase" "%TEMP%\services.json" >nul
if errorlevel 1 (echo   [FAIL] /services missing supabase entry & set /a FAILS+=1) else (echo   [PASS] /services lists supabase)
findstr /C:"cowork-proxy" "%TEMP%\services.json" >nul
if errorlevel 1 (echo   [FAIL] /services missing cowork-proxy entry & set /a FAILS+=1) else (echo   [PASS] /services lists self)

:: ── 5. F4 n8n workflows ────────────────────────────────────────────────
echo.
echo [5] F4 n8n workflows
curl -s "%PROXY%/n8n/workflows" -o "%TEMP%\n8n.json"
findstr /C:"\"ok\":true" "%TEMP%\n8n.json" >nul
if errorlevel 1 (
  findstr /C:"N8N_API_KEY" "%TEMP%\n8n.json" >nul
  if errorlevel 1 (echo   [FAIL] /n8n/workflows neither succeeded nor returned a clear key-missing error & set /a FAILS+=1) ^
                  else (echo   [PASS] /n8n/workflows returns clear "set N8N_API_KEY" error)
) else (
  echo   [PASS] /n8n/workflows succeeded (key configured)
)

:: ── 6. F5 chat (Anthropic) ─────────────────────────────────────────────
echo.
echo [6] F5 agent chat — POST /agent/zirak/chat
curl -s -X POST -H "Content-Type: application/json" -d "{\"message\":\"ping\"}" "%PROXY%/agent/zirak/chat" -o "%TEMP%\chat.txt" -w "  HTTP %%{http_code}"
echo.
findstr /C:"data:" "%TEMP%\chat.txt" >nul
if errorlevel 1 (
  findstr /C:"ANTHROPIC_API_KEY not set" "%TEMP%\chat.txt" >nul
  if errorlevel 1 (echo   [WARN] /agent/zirak/chat unexpected response - check ANTHROPIC_API_KEY in .env) ^
                  else (echo   [PASS] returns clear "ANTHROPIC_API_KEY not set" message)
) else (
  echo   [PASS] streaming chat events emitted
)

:: ── 7. F7 auth ─────────────────────────────────────────────────────────
echo.
echo [7] F7 auth status
curl -s "%PROXY%/auth/status" -o "%TEMP%\auth.json"
findstr /C:"\"ok\":true" "%TEMP%\auth.json" >nul
if errorlevel 1 (echo   [FAIL] /auth/status not OK & set /a FAILS+=1) else (echo   [PASS] /auth/status responds)
findstr /C:"\"initialized\"" "%TEMP%\auth.json" >nul
if errorlevel 1 (echo   [FAIL] /auth/status missing initialized field & set /a FAILS+=1) else (echo   [PASS] initialized field present)

:: ── 8. F8 afshin gallery ───────────────────────────────────────────────
echo.
echo [8] F8 afshin /afshin/gallery
curl -s "%PROXY%/afshin/gallery" -o "%TEMP%\afshin.json"
findstr /C:"\"ok\":true" "%TEMP%\afshin.json" >nul
if errorlevel 1 (echo   [FAIL] /afshin/gallery not OK & set /a FAILS+=1) else (echo   [PASS] /afshin/gallery responds)
findstr /C:"ig_carousel_slide" "%TEMP%\afshin.json" >nul
if errorlevel 1 (echo   [FAIL] kinds list missing - server may not be running new code & set /a FAILS+=1) else (echo   [PASS] kinds list includes ig_carousel_slide)

:: ── 9. F9 cost ─────────────────────────────────────────────────────────
echo.
echo [9] F9 cost telemetry
curl -s "%PROXY%/cost" -o "%TEMP%\cost.json"
findstr /C:"\"ok\":true" "%TEMP%\cost.json" >nul
if errorlevel 1 (echo   [FAIL] /cost not OK & set /a FAILS+=1) else (echo   [PASS] /cost responds)
findstr /C:"\"cap\":" "%TEMP%\cost.json" >nul
if errorlevel 1 (echo   [FAIL] /cost missing cap field & set /a FAILS+=1) else (echo   [PASS] cap field present)

:: ── 10. F6 pipelines ────────────────────────────────────────────────────
echo.
echo [10] F6 pipeline editor — /pipelines
curl -s "%PROXY%/pipelines" -o "%TEMP%\pipelines.json"
findstr /C:"\"ok\":true" "%TEMP%\pipelines.json" >nul
if errorlevel 1 (echo   [FAIL] /pipelines not OK & set /a FAILS+=1) else (echo   [PASS] /pipelines responds)
findstr /C:"\"pipelines\":" "%TEMP%\pipelines.json" >nul
if errorlevel 1 (echo   [FAIL] /pipelines missing pipelines array & set /a FAILS+=1) else (echo   [PASS] pipelines array present)

:: ── 11. F8b multi-model ─────────────────────────────────────────────────
echo.
echo [11] F8b multi-model /afshin/models
curl -s "%PROXY%/afshin/models" -o "%TEMP%\models.json"
findstr /C:"\"ok\":true" "%TEMP%\models.json" >nul
if errorlevel 1 (echo   [FAIL] /afshin/models not OK & set /a FAILS+=1) else (echo   [PASS] /afshin/models responds)
findstr /C:"gpt-image-1" "%TEMP%\models.json" >nul
if errorlevel 1 (echo   [FAIL] model registry missing gpt-image-1 & set /a FAILS+=1) else (echo   [PASS] model registry has gpt-image-1)
findstr /C:"recraft-v3" "%TEMP%\models.json" >nul
if errorlevel 1 (echo   [FAIL] model registry missing recraft-v3 & set /a FAILS+=1) else (echo   [PASS] model registry has recraft-v3)

:: ── Summary ────────────────────────────────────────────────────────────
echo.
echo ╔══════════════════════════════════════════════════════════════════╗
if %FAILS% equ 0 (
  echo ║   ✓ ALL CHECKS PASSED                                            ║
) else (
  echo ║   ✕ %FAILS% CHECKS FAILED                                                   ║
)
echo ╚══════════════════════════════════════════════════════════════════╝
echo.
if %FAILS% equ 0 ( echo Phase F is wired up. Open dashboard.html and explore. ) ^
                else ( echo Run the relevant apply-migration-*.bat for failing items, then re-run. )
echo.
pause
