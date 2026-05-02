@echo off
REM Import the 5 Phase D workflows into the running n8n container.
REM Strategy:
REM   1. Find the n8n container name (looks for any container with 'n8n' in the name).
REM   2. docker cp the workflows/ folder into /tmp inside the container.
REM   3. Run `n8n import:workflow --input=...` for each one.
REM   4. Print the import outcome and a reminder to activate them in the UI.
REM
REM After import, workflows show up at http://localhost:5678/workflows but are INACTIVE.
REM Activate them manually (toggle in the workflow editor) — that's intentional, so a
REM stray cron doesn't fire on first run.

setlocal ENABLEDELAYEDEXPANSION
title import n8n workflows

set "ROOT=%~dp0"
set "WF=%ROOT%n8n-workflows"

echo === Locate n8n container ===
for /f "delims=" %%c in ('docker ps --format "{{.Names}}" ^| findstr /R /I "n8n"') do (
  set "N8N_CTR=%%c"
  goto :found
)
echo ERROR: no running container with 'n8n' in its name. Start n8n first.
echo (e.g. via docker compose up, or your start-n8n.bat if you have one.)
pause
exit /b 1

:found
echo Found n8n container: !N8N_CTR!
echo.

echo === Copy workflow JSONs into container ===
docker exec !N8N_CTR! mkdir -p /tmp/workflows
for %%f in ("%WF%\*.json") do (
  echo   copying %%~nxf
  docker cp "%%f" !N8N_CTR!:/tmp/workflows/%%~nxf
)
echo.

echo === Import each workflow via n8n CLI ===
for %%f in ("%WF%\*.json") do (
  echo   importing %%~nxf
  docker exec !N8N_CTR! n8n import:workflow --input=/tmp/workflows/%%~nxf
)
echo.

echo === Listing workflows in n8n ===
docker exec !N8N_CTR! n8n list:workflow 2>nul
echo.

echo ===========================================================
echo  Imported. All workflows imported as INACTIVE on purpose.
echo  Open http://localhost:5678 and toggle each one to active
echo  after you've sanity-checked the URL/cron expressions.
echo ===========================================================
pause
