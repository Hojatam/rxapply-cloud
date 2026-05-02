@echo off
set "ROOT=%~dp0"

echo === Running cross-post DRY_RUN ===
python "%ROOT%dryrun.py" run
echo.

echo === T5 pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT COUNT(*) FILTER (WHERE status='dry_run_logged') AS dry_run_logged, COUNT(*) FILTER (WHERE status='pending') AS still_pending, COUNT(*) AS total, CASE WHEN COUNT(*) FILTER (WHERE status='dry_run_logged') = 11 THEN 'PASS' ELSE 'FAIL' END AS scorecard_t5 FROM scheduled_posts;"
echo.
pause
