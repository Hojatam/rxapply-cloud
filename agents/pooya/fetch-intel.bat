@echo off
REM Dumps the last-7-day intel snapshots to last-intel.json and prints to console.
set "ROOT=%~dp0"
set "OUT=%ROOT%last-intel.json"
python "%ROOT%pooya.py" fetch > "%OUT%" 2>&1
type "%OUT%"
echo.
echo (Saved to: %OUT%)
pause
