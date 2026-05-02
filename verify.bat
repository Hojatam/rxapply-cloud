@echo off
title rxapply-test verify
set "LOG=%TEMP%\rxapply-verify.log"
> "%LOG%" echo === verify === %DATE% %TIME%

echo.
echo ===========================================================
echo  Verifying the test stack
echo  Log: %LOG%
echo ===========================================================
echo.

echo --- Docker containers --- >> "%LOG%"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" >> "%LOG%" 2>&1
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo. >> "%LOG%"
echo --- n8n :5678 --- >> "%LOG%"
echo. && echo --- n8n :5678 ---
curl.exe -sS -o nul -w "HTTP %%{http_code}\n" http://localhost:5678 >> "%LOG%" 2>&1
curl.exe -sS -o nul -w "n8n           : HTTP %%{http_code}\n" http://localhost:5678

echo. >> "%LOG%"
echo --- mailhog :8025 --- >> "%LOG%"
echo --- mailhog :8025 ---
curl.exe -sS -o nul -w "HTTP %%{http_code}\n" http://localhost:8025 >> "%LOG%" 2>&1
curl.exe -sS -o nul -w "mailhog UI    : HTTP %%{http_code}\n" http://localhost:8025

echo. >> "%LOG%"
echo --- cowork-proxy :7777/health --- >> "%LOG%"
echo --- cowork-proxy :7777/health ---
curl.exe -sS http://localhost:7777/health >> "%LOG%" 2>&1
curl.exe -sS -o nul -w "cowork-proxy  : HTTP %%{http_code}\n" http://localhost:7777/health
curl.exe -sS http://localhost:7777/health
echo.

echo.
echo ===========================================================
echo  See full log: %LOG%
echo  If cowork-proxy returns "Failed to connect", run start-proxy.bat first.
echo ===========================================================
echo.
pause
