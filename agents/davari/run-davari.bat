@echo off
set "ROOT=%~dp0"

echo === 1. Seeding 5 fake n8n_executions (one P95-slow) ===
docker cp "%ROOT%seed-executions.sql" supabase_db_rxapply-test:/tmp/davari-seed.sql
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -f /tmp/davari-seed.sql
echo.

echo === 2. Running Davari ===
python "%ROOT%davari.py" run
echo.

echo === 3. T11b pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT COUNT(*) AS rows_seen FROM n8n_executions WHERE id LIKE 'davari-test-%%' AND started_at >= NOW() - INTERVAL '24 hours';"

REM Check the JSON output for at least one slow_node flagged
python -c "import json; d=json.load(open(r'%ROOT%davari-output.json',encoding='utf-8')); slow=any(f['slow_nodes'] for f in d['flow_health']); red_or_amber=any(f['status']!='green' for f in d['flow_health']); print('scorecard_t11b:', 'PASS' if slow and red_or_amber else 'FAIL'); print('  slow_nodes flagged:', slow); print('  status counts:', d['_meta']['status_counts'])"
echo.
pause
