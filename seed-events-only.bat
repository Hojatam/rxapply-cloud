@echo off
title seed engagement_events only
set "LOG=%TEMP%\rxapply-seed-events.log"
set "ROOT=%~dp0"

> "%LOG%" echo === seed engagement_events === %DATE% %TIME%

echo Finding supabase_db container ...
for /f "tokens=*" %%c in ('docker ps --filter "name=supabase_db" --format "{{.Names}}"') do set "DB_CONTAINER=%%c"
if "%DB_CONTAINER%"=="" (
  echo ERROR: no supabase_db container running.
  pause
  exit /b 1
)
echo Container: %DB_CONTAINER%

echo.
echo --- Copying SQL into container ---
docker cp "%ROOT%fixtures\engagement-events.sql" "%DB_CONTAINER%:/tmp/eng.sql" >> "%LOG%" 2>&1

echo --- Running INSERT ---
docker exec %DB_CONTAINER% psql -U postgres -d postgres -f /tmp/eng.sql 2>&1 | tee -a "%LOG%" 2>nul || docker exec %DB_CONTAINER% psql -U postgres -d postgres -f /tmp/eng.sql >> "%LOG%" 2>&1

echo.
echo --- Verifying counts ---
docker exec %DB_CONTAINER% psql -U postgres -d postgres -c "SELECT 'leads' AS t, COUNT(*) FROM leads UNION ALL SELECT 'intel_snapshots', COUNT(*) FROM intel_snapshots UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs UNION ALL SELECT 'engagement_events', COUNT(*) FROM engagement_events;"

echo.
echo Log: %LOG%
pause
