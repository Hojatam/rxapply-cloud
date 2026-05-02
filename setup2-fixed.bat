@echo off
title rxapply-test setup v2
setlocal

REM Log to a non-OneDrive path so cloud sync can't lock it mid-run.
set "LOG=%TEMP%\rxapply-setup.log"
set "ROOT=%~dp0"

REM Reset log
> "%LOG%" echo === rxapply-test setup v2 ===
>> "%LOG%" echo Started: %DATE% %TIME%
>> "%LOG%" echo Root:    %ROOT%
>> "%LOG%" echo Log:     %LOG%
>> "%LOG%" echo.

echo.
echo ===========================================================
echo  rxapply-test setup v2
echo  Log file: %LOG%
echo ===========================================================

echo. >> "%LOG%"
echo --- 1/6 Versions ---  >> "%LOG%"
echo. >> "%LOG%"
echo === 1/6 Versions ===
echo $ node --version
node --version >> "%LOG%" 2>&1
echo $ npm --version
call npm --version >> "%LOG%" 2>&1
echo $ docker --version
docker --version >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo --- 2/6 cowork-proxy npm install ---  >> "%LOG%"
echo. >> "%LOG%"
echo === 2/6 cowork-proxy npm install ===
pushd "%ROOT%cowork-proxy"
echo $ npm install
call npm install --no-fund --no-audit --no-progress >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"
popd

echo. >> "%LOG%"
echo --- 3/6 docker pull n8n ---  >> "%LOG%"
echo. >> "%LOG%"
echo === 3/6 docker pull n8n ===
echo $ docker pull n8nio/n8n:latest
docker pull n8nio/n8n:latest >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

echo. >> "%LOG%"
echo --- 4/6 docker pull mailhog ---  >> "%LOG%"
echo. >> "%LOG%"
echo === 4/6 docker pull mailhog ===
echo $ docker pull mailhog/mailhog:latest
docker pull mailhog/mailhog:latest >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

echo. >> "%LOG%"
echo --- 5/6 start containers ---  >> "%LOG%"
echo. >> "%LOG%"
echo === 5/6 start containers ===
docker rm -f n8n-test     1>nul 2>nul
docker rm -f mailhog-test 1>nul 2>nul

echo $ docker run n8n
docker run -d --name n8n-test -p 5678:5678 -v "%USERPROFILE%\.n8n:/home/node/.n8n" --add-host=host.docker.internal:host-gateway n8nio/n8n:latest >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

echo $ docker run mailhog
docker run -d --name mailhog-test -p 1025:1025 -p 8025:8025 mailhog/mailhog:latest >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

echo $ docker ps
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo --- 6/6 supabase CLI ---  >> "%LOG%"
echo. >> "%LOG%"
echo === 6/6 supabase CLI ===
echo $ npm install -g supabase
call npm install -g supabase --no-fund --no-audit --no-progress >> "%LOG%" 2>&1
echo (exit=%errorlevel%) >> "%LOG%"

echo. >> "%LOG%"
echo === DONE %DATE% %TIME% === >> "%LOG%"
echo.
echo ===========================================================
echo  Setup finished. See log: %LOG%
echo ===========================================================
echo.
pause
