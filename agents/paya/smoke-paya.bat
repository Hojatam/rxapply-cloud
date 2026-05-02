@echo off
REM Paya smoke test: write one snapshot per kind via stdin pipe, then list.
title smoke paya — intel_snapshots
set "PYTHONIOENCODING=utf-8"
set "PAYA=C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents\paya\paya.py"

echo === 1. schema lookup (sanity) ===
python -X utf8 "%PAYA%" schema market_heatmap
echo.

echo === 2. write a market_heatmap row (roya) ===
echo {"destinations":[{"slug":"canada","score":0.83,"rationale":"smoke"}],"window_days":7,"summary":"canada leading - smoke"} | python -X utf8 "%PAYA%" write --agent roya --kind market_heatmap
echo.

echo === 3. write a competitor_diff row (shahed) ===
echo {"competitor":"examplerival.com","what_changed":"smoke test entry","url":"https://example.com"} | python -X utf8 "%PAYA%" write --agent shahed --kind competitor_diff
echo.

echo === 4. write a regulatory_change row (dadbeh) ===
echo {"jurisdiction":"ON-Canada","what_changed":"NDEB AFK monthly cohorts (smoke)","effective_date":"2026-06-01","severity":"high"} | python -X utf8 "%PAYA%" write --agent dadbeh --kind regulatory_change
echo.

echo === 5. by-kind market_heatmap 3 ===
python -X utf8 "%PAYA%" by-kind market_heatmap 3
echo.

echo === 6. since 1 day ===
python -X utf8 "%PAYA%" since 1
echo.

pause
