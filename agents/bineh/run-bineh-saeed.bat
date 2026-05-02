@echo off
set "ROOT=%~dp0"
set "EMAIL=saeed.tehrani@example.com"

echo === 1. Topping up Saeed's engagement events ===
docker cp "%ROOT%seed-saeed-events.sql" supabase_db_rxapply-test:/tmp/seed-saeed.sql
docker exec supabase_db_rxapply-test psql -U postgres -d postgres -f /tmp/seed-saeed.sql
echo.

echo === 2. Fetching Saeed's events for Bineh ===
python "%ROOT%bineh.py" fetch %EMAIL% > "%ROOT%saeed-events.json"
type "%ROOT%saeed-events.json"
echo.
echo (Saved to: %ROOT%saeed-events.json)
echo.
pause
