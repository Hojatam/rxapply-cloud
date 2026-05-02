@echo off
title smoke roya — market heatmap
set "PYTHONIOENCODING=utf-8"
set "ROYA=C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents\roya\roya.py"

echo === 1. compose only (no write) ===
python -X utf8 "%ROYA%" compose
echo.

echo === 2. run (compose + paya write + zirak log) ===
python -X utf8 "%ROYA%" run --trigger manual
echo.

echo === 3. confirm: last 3 market_heatmap rows via paya ===
python -X utf8 "C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents\paya\paya.py" by-kind market_heatmap 3
echo.

pause
