@echo off
title status check
set "OUT=%~dp0last-status.txt"

> "%OUT%" echo ================================================================
>> "%OUT%" echo  rxapply-test status check
>> "%OUT%" echo  Generated: %DATE% %TIME%
>> "%OUT%" echo ================================================================
>> "%OUT%" echo.

>> "%OUT%" echo [1] Docker containers
>> "%OUT%" echo ----------------------
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo [2] HTTP endpoints (HTTP code only)
>> "%OUT%" echo --------------------------------------
for %%U in ("http://localhost:5678" "http://localhost:8025" "http://localhost:7777/health" "http://127.0.0.1:54323") do (
  curl.exe -sS -o nul -w "%%~U  =  HTTP %%{http_code}\n" %%U >> "%OUT%" 2>&1
)
>> "%OUT%" echo.

>> "%OUT%" echo [3] cowork-proxy /health body
>> "%OUT%" echo --------------------------------
curl.exe -sS http://localhost:7777/health >> "%OUT%" 2>&1
>> "%OUT%" echo.
>> "%OUT%" echo.

REM Find supabase_db container
for /f "tokens=*" %%c in ('docker ps --filter "name=supabase_db" --format "{{.Names}}"') do set "DBC=%%c"

>> "%OUT%" echo [4] Supabase: public-schema table count (expect 16)
>> "%OUT%" echo --------------------------------------------------
if not "%DBC%"=="" (
  docker exec %DBC% psql -U postgres -d postgres -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" >> "%OUT%" 2>&1
) else (
  >> "%OUT%" echo SUPABASE NOT RUNNING — no container matched name=supabase_db
)
>> "%OUT%" echo.

>> "%OUT%" echo [5] Fixture row counts
>> "%OUT%" echo ------------------------
if not "%DBC%"=="" (
  docker exec %DBC% psql -U postgres -d postgres -c "SELECT 'leads' AS t, COUNT(*) FROM leads UNION ALL SELECT 'intel_snapshots', COUNT(*) FROM intel_snapshots UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs UNION ALL SELECT 'engagement_events', COUNT(*) FROM engagement_events;" >> "%OUT%" 2>&1
)
>> "%OUT%" echo.

>> "%OUT%" echo [6] n8n credentials in DB
>> "%OUT%" echo ----------------------------
docker exec n8n-test node -e "const Database=require('better-sqlite3');const db=new Database('/home/node/.n8n/database.sqlite',{readonly:true});console.log(JSON.stringify(db.prepare('SELECT id,name,type FROM credentials_entity').all(),null,2));" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo === END ===

echo Status written to: %OUT%
type "%OUT%"
echo.
pause
