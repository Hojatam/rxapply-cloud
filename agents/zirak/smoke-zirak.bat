@echo off
REM Zirak smoke test:
REM   1. log a success row
REM   2. start a running row, then finish it
REM   3. log a fail row
REM   4. tail 5 + failures 5 to confirm
title smoke zirak — agent_journal
set "PYTHONIOENCODING=utf-8"
set "ZIRAK=C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents\zirak\zirak.py"

echo === 1. Single-shot log (success) ===
python -X utf8 "%ZIRAK%" log --agent pooya --status success ^
  --input "intel last-7d (smoke)" ^
  --output "3 briefs at pending_g1 (smoke)" ^
  --table content_briefs --count 3 ^
  --trigger manual
echo.

echo === 2. Start then finish ===
for /f "delims=" %%i in ('python -X utf8 "%ZIRAK%" start --agent sepehr --input "brief df7d2847 (smoke)" --trigger dashboard') do set RUNID=%%i
echo Got run id: %RUNID%
python -X utf8 "%ZIRAK%" finish %RUNID% --status success ^
  --output "1500-word EN master, 4 citations (smoke)" ^
  --table content_assets --count 1
echo.

echo === 3. Single-shot log (fail) ===
python -X utf8 "%ZIRAK%" log --agent goyesh --status fail ^
  --input "fa+ar from master 1c92e0 (smoke)" ^
  --output "translation pipeline aborted (smoke)" ^
  --error "ConnectionError: openai 502 (smoke)" ^
  --trigger cron
echo.

echo === 4. tail 5 ===
python -X utf8 "%ZIRAK%" tail 5
echo.

echo === 5. failures 5 ===
python -X utf8 "%ZIRAK%" failures 5
echo.

pause
