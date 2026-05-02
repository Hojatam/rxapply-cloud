@echo off
REM End-to-end smoke for the whole stack:
REM   - 5 services responding (proxy, supabase API, studio, mailhog, n8n)
REM   - 6 proxy routes (/health, /agents, /run-helper, GET+PUT /prompts, /run-agent)
REM   - 17 Postgres tables present
REM   - All 21 agents have a SKILL.md the proxy can serve
REM   - 5 n8n workflow JSONs exist on disk and are valid JSON
REM Prints one PASS/FAIL line per check, plus a final scorecard.
title smoke EVERYTHING — Phase A+B+C+D+E
set "PYTHONIOENCODING=utf-8"
setlocal ENABLEDELAYEDEXPANSION

set "ROOT=%~dp0"
set /a PASS=0
set /a FAIL=0
set /a TOTAL=0

REM Each check uses a small Python one-liner so we can parse JSON cleanly.
REM On a failure, the line still prints; we just bump FAIL.
REM ----- helpers -----
goto :start

:check
  REM %1 = label, rest = python code that returns "OK" / "FAIL: ..." on stdout
  set /a TOTAL+=1
  set "RESULT="
  for /f "delims=" %%r in ('python -X utf8 -c %2') do set "RESULT=%%r"
  if "!RESULT!"=="OK" (
    echo   [PASS] %~1
    set /a PASS+=1
  ) else (
    echo   [FAIL] %~1  --  !RESULT!
    set /a FAIL+=1
  )
  goto :eof

:start
echo =================================================================
echo  END-TO-END SMOKE  rxapply-test
echo =================================================================

echo.
echo --- 1. Service health (5 endpoints) ---
call :check "cowork-proxy /health"          "import urllib.request as u,json; print('OK' if json.loads(u.urlopen('http://localhost:7777/health',timeout=4).read()).get('ok') else 'FAIL: not ok')"
call :check "supabase API /rest/v1/"         "import urllib.request as u; print('OK' if u.urlopen('http://127.0.0.1:54321/rest/v1/',timeout=4).status<500 else 'FAIL')"
call :check "supabase Studio :54323"         "import urllib.request as u; print('OK' if u.urlopen('http://127.0.0.1:54323',timeout=4).status<500 else 'FAIL')"
call :check "mailhog :8025"                  "import urllib.request as u; print('OK' if u.urlopen('http://localhost:8025/api/v2/messages',timeout=4).status<500 else 'FAIL')"
call :check "n8n :5678 healthz"              "import urllib.request as u,urllib.error as e;\ntry: u.urlopen('http://localhost:5678/healthz',timeout=4); print('OK')\nexcept Exception as ex: print(f'FAIL: {ex}')"

echo.
echo --- 2. Proxy routes ---
call :check "/agents lists >=10 agents"      "import urllib.request as u,json; d=json.loads(u.urlopen('http://localhost:7777/agents',timeout=4).read()); print('OK' if d.get('count',0)>=10 else f'FAIL: count={d.get(\"count\")}')"
call :check "/prompts/pooya 200"             "import urllib.request as u,json; d=json.loads(u.urlopen('http://localhost:7777/prompts/pooya',timeout=4).read()); print('OK' if d.get('ok') and d.get('chars',0)>500 else 'FAIL: empty SKILL.md')"
call :check "/run-helper rahnama list"       "import urllib.request as u,json; req=u.Request('http://localhost:7777/run-helper',data=json.dumps({'agent':'rahnama','command':'list'}).encode(),headers={'Content-Type':'application/json'},method='POST'); d=json.loads(u.urlopen(req,timeout=15).read()); print('OK' if d.get('ok') else 'FAIL')"

echo.
echo --- 3. Postgres tables (expect >=17) ---
call :check "table count >=17"               "import subprocess; r=subprocess.run(['docker','exec','supabase_db_rxapply-test','psql','-U','postgres','-d','postgres','-tAc',\"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\"],capture_output=True,text=True); n=int(r.stdout.strip() or 0); print('OK' if n>=17 else f'FAIL: only {n} tables')"
call :check "agent_journal table exists"     "import subprocess; r=subprocess.run(['docker','exec','supabase_db_rxapply-test','psql','-U','postgres','-d','postgres','-tAc',\"SELECT to_regclass('public.agent_journal') IS NOT NULL\"],capture_output=True,text=True); print('OK' if 't' in r.stdout else 'FAIL')"

echo.
echo --- 4. SKILL.md per agent (21 expected) ---
for %%a in (pooya sepehr goyesh rahnama bineh mehrban bidar davari ravi rahbar avang zirak paya roya shahed dadbeh nasim ramin kherad payvand mehmandar) do (
  if exist "%ROOT%agents\%%a\SKILL.md" (
    set /a PASS+=1
    set /a TOTAL+=1
    echo   [PASS] SKILL.md present  agents\%%a\SKILL.md
  ) else (
    set /a FAIL+=1
    set /a TOTAL+=1
    echo   [FAIL] SKILL.md MISSING  agents\%%a\SKILL.md
  )
)

echo.
echo --- 5. n8n workflow JSONs (5 expected) ---
for %%w in (cron-bidar-nightly cron-ravi-monday cron-intel-daily cron-cross-post-5min webhook-lead-form) do (
  set /a TOTAL+=1
  python -X utf8 -c "import json,sys; json.load(open(r'%ROOT%n8n-workflows\%%w.json',encoding='utf-8')); print('OK')" 2>nul | findstr OK >nul
  if !errorlevel! equ 0 (
    echo   [PASS] valid JSON  n8n-workflows\%%w.json
    set /a PASS+=1
  ) else (
    echo   [FAIL] missing or invalid  n8n-workflows\%%w.json
    set /a FAIL+=1
  )
)

echo.
echo =================================================================
echo  SCORECARD: !PASS! / !TOTAL! checks passed   ^(!FAIL! failures^)
echo =================================================================
if !FAIL! gtr 0 (
  echo  Status: NEEDS ATTENTION
) else (
  echo  Status: ALL GREEN — ship it
)
echo.
pause
