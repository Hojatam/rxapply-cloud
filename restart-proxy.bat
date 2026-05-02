@echo off
REM Kill any process listening on port 7777, then re-launch start-proxy.bat in a new window.
title restart cowork-proxy

echo Killing any existing process on port 7777 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":7777" ^| findstr LISTENING') do (
  echo Found PID %%p — terminating
  taskkill /F /PID %%p 1>nul 2>nul
)
echo.

echo Starting cowork-proxy in a new window ...
start "cowork-proxy" cmd /c "%~dp0start-proxy.bat"
echo.

echo Waiting 3 seconds for startup ...
timeout /t 3 /nobreak >nul

echo === Hitting /health to confirm new build ===
curl.exe -sS http://localhost:7777/health
echo.
echo.

echo If the response above lists routes including /run-helper and /prompts/:agent,
echo the new build is live.
pause
