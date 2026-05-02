@echo off
set "ROOT=%~dp0"
set "OUT=%ROOT%personas-quiz.json"

echo Fetching all 3 personas as quiz JSONs ...
echo. > "%OUT%"
echo [ >> "%OUT%"

for %%E in (saeed.tehrani@example.com amira.hassan@example.com james.brown@example.com) do (
  echo --- %%E ---
  python "%ROOT%rahnama.py" persona %%E
  python "%ROOT%rahnama.py" persona %%E >> "%OUT%"
  echo , >> "%OUT%"
)

echo ] >> "%OUT%"

echo.
echo (Saved combined to: %OUT%)
echo Note: combined file may need manual JSON cleanup since it contains 3 separate objects with trailing commas — read the per-persona output above instead.
pause
