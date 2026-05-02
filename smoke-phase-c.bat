@echo off
REM Phase C smoke test — exercise all 10 newly-built agents in dependency order.
REM Stops on the first non-zero exit so the failing agent surfaces immediately.
title smoke phase C — 10 agents
set "PYTHONIOENCODING=utf-8"
set "ROOT=C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents"

echo =================================================================
echo  PHASE C SMOKE — Zirak  Paya  Roya  Shahed  Dadbeh  Nasim  Ramin
echo                  Kherad  Payvand  Mehmandar
echo =================================================================

echo.
echo === [1/10] Zirak — single-shot log + tail 5 ===
python -X utf8 "%ROOT%\zirak\zirak.py" log --agent kherad --status success ^
  --input "phase-c smoke" --output "zirak alive" --trigger dashboard
python -X utf8 "%ROOT%\zirak\zirak.py" tail 5
echo.

echo === [2/10] Paya — schema lookup + write one market_heatmap row ===
python -X utf8 "%ROOT%\paya\paya.py" schema market_heatmap
echo {"destinations":[{"slug":"canada","score":0.9,"rationale":"phase-c smoke"}],"window_days":7,"summary":"phase-c smoke"} | python -X utf8 "%ROOT%\paya\paya.py" write --agent roya --kind market_heatmap
echo.

echo === [3/10] Roya — compose+write from local signals ===
python -X utf8 "%ROOT%\roya\roya.py" run --trigger dashboard
echo.

echo === [4/10] Shahed — competitor diff (first run = baseline diffs) ===
python -X utf8 "%ROOT%\shahed\shahed.py" run --trigger dashboard
echo.

echo === [5/10] Dadbeh — regulatory change (window -7d..+90d) ===
python -X utf8 "%ROOT%\dadbeh\dadbeh.py" run --trigger dashboard
echo.

echo === [6/10] Nasim — trend spike from engagement_events ===
python -X utf8 "%ROOT%\nasim\nasim.py" run --trigger dashboard
echo.

echo === [7/10] Ramin — keyword candidates synthesised from above ===
python -X utf8 "%ROOT%\ramin\ramin.py" run --trigger dashboard
echo.

echo === [8/10] Kherad — score every pending_g2 asset ===
python -X utf8 "%ROOT%\kherad\kherad.py" run --trigger dashboard
echo.

echo === [9/10] Payvand — draft outreach for status='targeted' partnerships ===
python -X utf8 "%ROOT%\payvand\payvand.py" run --trigger dashboard
echo.

echo === [10/10] Mehmandar — guest-pipeline digest + overdue emails to MailHog ===
python -X utf8 "%ROOT%\mehmandar\mehmandar.py" run --trigger dashboard
echo.

echo =================================================================
echo  Verify
echo =================================================================
echo.

echo === intel_snapshots (last 10) ===
python -X utf8 "%ROOT%\paya\paya.py" list 10
echo.

echo === agent_journal — last 12 (all 10 agents should appear) ===
python -X utf8 "%ROOT%\zirak\zirak.py" tail 12
echo.

echo === MailHog inbox ===
echo Open http://localhost:8025 to see emails sent by Mehmandar.
echo.
pause
