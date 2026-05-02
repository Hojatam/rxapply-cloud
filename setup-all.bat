@echo off
title rxapply-test setup
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
set "LOG=%ROOT%setup.log"

REM Reset log
echo === rxapply-test setup === > "%LOG%"
echo Started at %DATE% %TIME% >> "%LOG%"
echo Working dir: %ROOT% >> "%LOG%"
echo. >> "%LOG%"

call :section "1/6  Versions sanity check"
call :run "node --version"
call :run "npm --version"
call :run "docker --version"

call :section "2/6  cowork-proxy: npm install"
cd /d "%ROOT%cowork-proxy"
call :run "npm install --no-fund --no-audit"
cd /d "%ROOT%"

call :section "3/6  Docker: pull n8n image"
call :run "docker pull n8nio/n8n:latest"

call :section "4/6  Docker: pull mailhog image"
call :run "docker pull mailhog/mailhog:latest"

call :section "5/6  Docker: start n8n + mailhog containers"
REM Stop+remove anything that already exists with the same name (idempotent)
docker rm -f n8n-test       >nul 2>&1
docker rm -f mailhog-test   >nul 2>&1

call :run "docker run -d --name n8n-test -p 5678:5678 -v %USERPROFILE%\.n8n:/home/node/.n8n --add-host=host.docker.internal:host-gateway n8nio/n8n:latest"

call :run "docker run -d --name mailhog-test -p 1025:1025 -p 8025:8025 mailhog/mailhog:latest"

REM Verify they're running
call :run "docker ps --format \"table {{.Names}}\t{{.Status}}\t{{.Ports}}\""

call :section "6/6  Supabase CLI: install globally"
call :run "npm install -g supabase --no-fund --no-audit"

call :section "DONE"
echo Completed at %DATE% %TIME% >> "%LOG%"
echo. >> "%LOG%"
echo See setup.log for full output.
echo.
echo You can close this window.
pause
goto :eof

REM ---- helpers ----
:section
echo. >> "%LOG%"
echo --------------------------------------------------------- >> "%LOG%"
echo  %~1 >> "%LOG%"
echo --------------------------------------------------------- >> "%LOG%"
echo. >> "%LOG%"
echo.
echo === %~1 ===
goto :eof

:run
echo $ %~1 >> "%LOG%"
echo $ %~1
%~1 >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"
echo. >> "%LOG%"
goto :eof
