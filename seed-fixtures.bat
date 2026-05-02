@echo off
title seed fixtures
setlocal enabledelayedexpansion
set "LOG=%TEMP%\rxapply-seed.log"
set "ROOT=%~dp0"

> "%LOG%" echo === seed fixtures === %DATE% %TIME%

echo.
echo ===========================================================
echo  Seeding fixtures into local Supabase Postgres
echo  Log: %LOG%
echo ===========================================================

REM Find the supabase Postgres container (its name varies by project name)
echo.
echo --- Finding supabase_db container ---
for /f "tokens=*" %%c in ('docker ps --filter "name=supabase_db" --format "{{.Names}}"') do set "DB_CONTAINER=%%c"
if "%DB_CONTAINER%"=="" (
  echo ERROR: no running container matched name=supabase_db.
  echo Make sure 'supabase start' has been run.
  pause
  exit /b 1
)
echo Container: %DB_CONTAINER%
echo Container: %DB_CONTAINER% >> "%LOG%"

REM Helper: docker exec a SQL command into the container
set "PSQL=docker exec -i %DB_CONTAINER% psql -U postgres -d postgres"

echo.
echo --- 1. Counts BEFORE seeding ---
echo --- BEFORE --- >> "%LOG%"
%PSQL% -c "SELECT 'leads' AS t, COUNT(*) FROM leads UNION ALL SELECT 'intel_snapshots', COUNT(*) FROM intel_snapshots UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs UNION ALL SELECT 'engagement_events', COUNT(*) FROM engagement_events;" 2>>"%LOG%"

REM ---- Load leads ----
echo.
echo --- 2. Loading leads-3-personas.csv into leads ---
echo --- leads --- >> "%LOG%"
docker cp "%ROOT%fixtures\leads-3-personas.csv" "%DB_CONTAINER%:/tmp/leads.csv" 1>>"%LOG%" 2>&1
%PSQL% -c "\COPY leads (email,language,origin_country,destination_intent,experience_years,source) FROM '/tmp/leads.csv' WITH (FORMAT csv, HEADER)" 1>>"%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

REM ---- Load intel_snapshots ----
echo.
echo --- 3. Loading intel-snapshots-week.csv into intel_snapshots ---
echo --- intel_snapshots --- >> "%LOG%"
docker cp "%ROOT%fixtures\intel-snapshots-week.csv" "%DB_CONTAINER%:/tmp/intel.csv" 1>>"%LOG%" 2>&1
%PSQL% -c "\COPY intel_snapshots (agent,kind,payload) FROM '/tmp/intel.csv' WITH (FORMAT csv, HEADER)" 1>>"%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

REM ---- Load agent_runs ----
echo.
echo --- 4. Loading agent-runs-24h.csv into agent_runs ---
echo --- agent_runs --- >> "%LOG%"
docker cp "%ROOT%fixtures\agent-runs-24h.csv" "%DB_CONTAINER%:/tmp/runs.csv" 1>>"%LOG%" 2>&1
%PSQL% -c "\COPY agent_runs (agent,input_tokens,output_tokens,cost_usd,duration_ms,status) FROM '/tmp/runs.csv' WITH (FORMAT csv, HEADER)" 1>>"%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

REM ---- Load engagement_events: special — link by lead email lookup, not raw COPY ----
REM (the fabricated lead_id UUIDs in ig-dms-sample.csv won't match the real ones we just inserted)
REM Windows cmd doesn't have heredoc, so we ship a .sql file in and run it with psql -f.
echo.
echo --- 5. Loading engagement_events (3 DMs by email join) ---
echo --- engagement_events --- >> "%LOG%"
docker cp "%ROOT%fixtures\engagement-events.sql" "%DB_CONTAINER%:/tmp/eng.sql" 1>>"%LOG%" 2>&1
docker exec %DB_CONTAINER% psql -U postgres -d postgres -f /tmp/eng.sql 1>>"%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

echo.
echo --- 6. Counts AFTER seeding ---
echo --- AFTER --- >> "%LOG%"
%PSQL% -c "SELECT 'leads' AS t, COUNT(*) FROM leads UNION ALL SELECT 'intel_snapshots', COUNT(*) FROM intel_snapshots UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs UNION ALL SELECT 'engagement_events', COUNT(*) FROM engagement_events;"
%PSQL% -c "SELECT 'leads' AS t, COUNT(*) FROM leads UNION ALL SELECT 'intel_snapshots', COUNT(*) FROM intel_snapshots UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs UNION ALL SELECT 'engagement_events', COUNT(*) FROM engagement_events;" 1>>"%LOG%" 2>&1

echo.
echo ===========================================================
echo  Done. See %LOG% for the full transcript.
echo  Expected counts: leads=3, intel_snapshots=4, agent_runs=29, engagement_events=3
echo ===========================================================
echo.
pause
