@echo off
REM Smoke-test the 3 new cowork-proxy routes.
title smoke-test proxy routes
echo === /health ===
curl.exe -sS http://localhost:7777/health
echo.
echo.

echo === /agents (list known agent folders) ===
curl.exe -sS http://localhost:7777/agents
echo.
echo.

echo === GET /prompts/pooya (first 200 chars only) ===
curl.exe -sS http://localhost:7777/prompts/pooya | python -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok:', d.get('ok'), 'bytes:', d.get('bytes'), 'first 200:', d.get('markdown','')[:200])"
echo.

echo === POST /run-helper {agent:rahnama, command:list} ===
curl.exe -sS -X POST http://localhost:7777/run-helper ^
  -H "Content-Type: application/json" ^
  -d "{\"agent\":\"rahnama\",\"command\":\"list\"}"
echo.
echo.

echo === POST /run-helper {agent:bidar, command:preview}  (zero-LLM agent) ===
curl.exe -sS -X POST http://localhost:7777/run-helper ^
  -H "Content-Type: application/json" ^
  -d "{\"agent\":\"bidar\",\"command\":\"preview\"}" | python -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok:', d.get('ok'), 'exitCode:', d.get('exitCode'), 'output preview:', (d.get('output') or '')[:300])"
echo.
echo.

echo === POST /run-helper with invalid name (path-traversal block) ===
curl.exe -sS -X POST http://localhost:7777/run-helper ^
  -H "Content-Type: application/json" ^
  -d "{\"agent\":\"../../etc\",\"command\":\"help\"}"
echo.

pause
