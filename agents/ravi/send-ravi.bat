@echo off
set "ROOT=%~dp0"

echo === 1. Fetching weekly metrics ===
python "%ROOT%ravi.py" fetch
echo.

echo === 2. Sending email via MailHog ===
python "%ROOT%ravi.py" send --to founder@rxapply.test --subject "RxApply weekly . week of 2026-04-22 to 2026-04-28" --file "%ROOT%ravi-email.md"
echo.

echo === 3. T10 pass check ===
echo Checking MailHog inbox count ...
curl.exe -sS http://localhost:8025/api/v2/messages | python -c "import sys,json; d=json.loads(sys.stdin.read()); n=d.get('total',0); print(f'  MailHog total messages: {n}'); print(f'  scorecard_t10: {\"PASS (email landed)\" if n >= 1 else \"FAIL\"}')"
echo.

echo Word count check:
python -c "import re; t=open(r'%ROOT%ravi-email.md',encoding='utf-8').read(); w=len(re.findall(r'\S+',t)); n=len(re.findall(r'\d[\d,]*',t)); print(f'  words: {w} (target 500-700)'); print(f'  numbers cited: {n} (target >=3)'); print(f'  scorecard_t10_content:', 'PASS' if 500<=w<=700 and n>=3 else 'FAIL')"
echo.
echo Open http://localhost:8025 to read the email visually.
pause
