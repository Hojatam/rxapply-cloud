@echo off
title import n8n credentials via CLI
set "LOG=%TEMP%\rxapply-import-creds.log"
set "ROOT=%~dp0"
set "SRC=%ROOT%n8n\credentials.json"
set "DST=/home/node/credentials.json"

> "%LOG%" echo === import n8n creds === %DATE% %TIME%

echo.
echo ===========================================================
echo  Importing Postgres + SMTP credentials into n8n
echo  Source: %SRC%
echo  Log:    %LOG%
echo ===========================================================

REM 1. Confirm container is up
echo.
echo --- Container status ---
docker ps --filter "name=n8n-test" --format "table {{.Names}}\t{{.Status}}"
docker ps --filter "name=n8n-test" --format "{{.Names}}|{{.Status}}" >> "%LOG%" 2>&1

REM 2. Copy credentials file into container
echo.
echo --- Copying credentials.json into container ---
echo $ docker cp %SRC% n8n-test:%DST%
docker cp "%SRC%" n8n-test:%DST% >> "%LOG%" 2>&1
echo (cp exit=%errorlevel%) >> "%LOG%"

REM 3. Run the import (the n8n CLI is on PATH inside the container)
echo.
echo --- Running n8n import:credentials ---
echo $ docker exec n8n-test n8n import:credentials --input=%DST%
docker exec n8n-test n8n import:credentials --input=%DST% >> "%LOG%" 2>&1
set IMPORT_EXIT=%errorlevel%
echo (import exit=%IMPORT_EXIT%) >> "%LOG%"

REM 4. Verify by querying the SQLite DB directly (list:credentials doesn't exist in newer n8n)
echo.
echo --- Verifying credentials in DB ---
echo $ docker exec n8n-test sqlite3 /home/node/.n8n/database.sqlite "SELECT id, name, type FROM credentials_entity"
docker exec n8n-test sqlite3 /home/node/.n8n/database.sqlite "SELECT id, name, type FROM credentials_entity" >> "%LOG%" 2>&1
docker exec n8n-test sqlite3 /home/node/.n8n/database.sqlite "SELECT id, name, type FROM credentials_entity"

REM 5. Clean up the file inside container
docker exec n8n-test rm -f %DST% >> "%LOG%" 2>&1

echo.
echo ===========================================================
if %IMPORT_EXIT% EQU 0 (
  echo  IMPORT SUCCEEDED. Check the list above.
) else (
  echo  IMPORT FAILED with exit %IMPORT_EXIT%. See: %LOG%
  echo  Common cause: credential type names may have changed across n8n versions.
)
echo ===========================================================
echo.
pause
