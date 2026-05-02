@echo off
REM Run the 5 intel agents in dependency order:
REM   Roya, Shahed, Dadbeh, Nasim → all write their own snapshots
REM   Ramin → reads the others' last-7d output and synthesizes keyword candidates
REM Then dump:
REM   - last 10 intel_snapshots (any kind)
REM   - last 10 agent_journal rows (every step should leave a row)
title smoke intel pipeline
set "PYTHONIOENCODING=utf-8"
set "ROOT=C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents"

echo ===========================================================
echo  Intel pipeline smoke — Roya  Shahed  Dadbeh  Nasim  Ramin
echo ===========================================================

echo.
echo === Roya (market heatmap) ===
python -X utf8 "%ROOT%\roya\roya.py" run --trigger dashboard
echo.

echo === Shahed (competitor diff) ===
python -X utf8 "%ROOT%\shahed\shahed.py" run --trigger dashboard
echo.

echo === Dadbeh (regulatory change) ===
python -X utf8 "%ROOT%\dadbeh\dadbeh.py" run --trigger dashboard
echo.

echo === Nasim (trend spike) ===
python -X utf8 "%ROOT%\nasim\nasim.py" run --trigger dashboard
echo.

echo === Ramin (keyword candidates) — reads the four above ===
python -X utf8 "%ROOT%\ramin\ramin.py" run --trigger dashboard
echo.

echo ===========================================================
echo  Verify in Postgres
echo ===========================================================

echo.
echo === intel_snapshots (last 10) ===
python -X utf8 "%ROOT%\paya\paya.py" list 10
echo.

echo === agent_journal (last 10 — Zirak entries from each step) ===
python -X utf8 "%ROOT%\zirak\zirak.py" tail 10
echo.

pause
