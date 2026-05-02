@echo off
set "ROOT=%~dp0"

echo === Running Bidar nightly audit ===
python "%ROOT%bidar.py" run
echo.

echo === T11a pass check ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT COUNT(*) AS rollup_rows_today, COUNT(*) FILTER (WHERE bidar_recommendation='rewrite') AS rewrite_count, COUNT(*) FILTER (WHERE bidar_recommendation='keep') AS keep_count, COUNT(*) FILTER (WHERE bidar_recommendation='demote') AS demote_count, CASE WHEN COUNT(*) >= 21 AND COUNT(*) FILTER (WHERE bidar_recommendation='rewrite') >= 1 THEN 'PASS' ELSE 'FAIL' END AS scorecard_t11a FROM agent_efficiency WHERE date = CURRENT_DATE;"
echo.

echo === Sample rows from agent_efficiency ===
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -c "SELECT agent, runs, ROUND(approval_ratio::numeric, 2) AS approval, avg_cost_usd, quality_score, bidar_recommendation FROM agent_efficiency WHERE date = CURRENT_DATE ORDER BY CASE bidar_recommendation WHEN 'rewrite' THEN 0 WHEN 'demote' THEN 1 ELSE 2 END, agent LIMIT 25;"
echo.
pause
