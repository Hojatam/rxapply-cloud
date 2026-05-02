@echo off
REM Round-trip test: GET → PUT same content back → GET again. Idempotent on byte content.
REM IMPORTANT: PYTHONIOENCODING=utf-8 forces stdin/stdout to UTF-8 on Windows.
REM Without that, Python decodes stdin as cp1252 and mangles em-dashes / arrows / non-ASCII.
title smoke PUT /prompts/:agent
set "TMP=%TEMP%\smoke-pooya-skill.md"
set "PYTHONIOENCODING=utf-8"

echo === 1. GET /prompts/pooya, save raw bytes to %TMP% ===
REM Use curl -o to write the JSON response straight to disk (no Python decode in the path),
REM then python (in utf-8 mode) extracts the markdown field.
REM CRITICAL: open(...,'wb') — binary mode, no \n→\r\n translation. Text mode would expand
REM the file by ~one byte per newline on Windows and produce a false round-trip mismatch.
curl.exe -sS http://localhost:7777/prompts/pooya -o "%TEMP%\smoke-pooya-resp.json"
python -X utf8 -c "import json; d=json.load(open(r'%TEMP%\smoke-pooya-resp.json',encoding='utf-8')); open(r'%TMP%','wb').write(d['markdown'].encode('utf-8')); print('saved bytes:', d['bytes'])"
echo.

echo === 2. PUT same content back via Content-Type: text/markdown ===
curl.exe -sS -X PUT http://localhost:7777/prompts/pooya ^
  -H "Content-Type: text/markdown; charset=utf-8" ^
  --data-binary "@%TMP%"
echo.
echo.

echo === 3. GET again and byte-compare ===
REM Read original back as bytes (binary) so we compare exactly what we PUT.
curl.exe -sS http://localhost:7777/prompts/pooya -o "%TEMP%\smoke-pooya-resp2.json"
python -X utf8 -c "import json; d=json.load(open(r'%TEMP%\smoke-pooya-resp2.json',encoding='utf-8')); orig=open(r'%TMP%','rb').read(); new=d['markdown'].encode('utf-8'); print('GET bytes after PUT:', d['bytes']); print('orig bytes len:', len(orig), '  new bytes len:', len(new)); print('round-trip identical:', orig==new); print('first 80 chars:', d['markdown'][:80])"
echo.

echo === 4. PUT with bad payload (no frontmatter) — should 400 ===
curl.exe -sS -X PUT http://localhost:7777/prompts/pooya ^
  -H "Content-Type: text/markdown" ^
  --data-binary "no frontmatter here just plain text"
echo.
echo.

echo === 5. PUT with invalid agent name — should 400 ===
curl.exe -sS -X PUT http://localhost:7777/prompts/..hax ^
  -H "Content-Type: text/markdown" ^
  --data-binary "anything"
echo.
echo.

pause
