@echo off
set "ROOT=%~dp0"

echo === 1. Sequence picks for the 3 fixture leads ===
python "%ROOT%rahbar.py" leads
echo.

echo === 2. Enrolling all 3 leads ===
python "%ROOT%rahbar.py" enroll-all
echo.

echo === 3. Verifying via SELECT ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT lead_id::text AS lead_id, sequence_id, step_number, send_at::date AS send_date, LEFT(email_subject, 60) AS subject FROM nurture_schedule ORDER BY lead_id, step_number;"
echo.

echo === 4. T7 pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT lead_id) AS distinct_leads, COUNT(DISTINCT sequence_id) AS distinct_sequences, COUNT(DISTINCT step_number) AS distinct_steps, CASE WHEN COUNT(*) = 15 AND COUNT(DISTINCT lead_id) = 3 AND COUNT(DISTINCT step_number) = 5 THEN 'PASS' ELSE 'FAIL' END AS scorecard_t7 FROM nurture_schedule;"
echo.
echo === Send-at staggering per lead ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT lead_id::text AS lead_id, MIN(send_at)::date AS day0, MAX(send_at)::date AS day14, MAX(send_at) - MIN(send_at) AS span FROM nurture_schedule GROUP BY 1 ORDER BY 1;"
echo.
pause
