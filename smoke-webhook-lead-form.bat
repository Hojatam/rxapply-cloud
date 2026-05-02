@echo off
REM Quick smoke for D5: POST a fake lead form to the webhook and confirm
REM the proxy was invoked. Assumes the webhook is active in n8n.
REM
REM If you see a 404, the webhook isn't activated yet — open
REM http://localhost:5678/workflow and toggle webhook-lead-form ON.
title smoke webhook-lead-form
set "PYTHONIOENCODING=utf-8"

echo === POST /webhook/lead-form ===
curl.exe -sS -X POST http://localhost:5678/webhook/lead-form ^
  -H "Content-Type: application/json" ^
  --data-binary "{\"full_name\":\"Smoke Test\",\"email\":\"smoke@test.local\",\"country_of_interest\":\"canada\",\"language_pref\":\"en\",\"lead_source\":\"webhook-smoke\"}"
echo.
echo.

echo === Confirm via journal: rahbar's last 3 entries ===
python -X utf8 "%~dp0agents\zirak\zirak.py" for-agent rahbar 3
echo.

echo === Confirm via leads count ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -tAc "SELECT count(*) FROM leads;"
echo.
pause
