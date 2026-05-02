// cowork-proxy/cost.js
// =====================================================================
// F9 · Cost telemetry + monthly cap enforcement.  [cloud build]
//
// Two cost sources:
//   1. agent_runs.cost_usd_actual  — paid LLM/image calls inside helpers
//   2. agent_chats.total_cost      — Anthropic chat from the dashboard
//
// We aggregate both by date for the topbar widget. The cap is read
// from dashboard_settings.monthly_cap_usd (default $25). canSpend()
// returns false when 30d sum + projectedAddUsd would exceed cap.
// Anthropic chat + Afshin render call canSpend() before paid actions.
//
// Cloud build note: every public function is now async because the
// underlying pg client is async. Callers in server.js routes already
// run inside `async (req, res) => { … }` handlers — they just need to
// add `await` in front of these calls. canSpend() became async too; the
// runtime in tools/runtime.js awaits it.
// =====================================================================

const { queryValue, queryRows } = require('./db');

async function getCap() {
  try {
    const out = await queryValue(`SELECT monthly_cap_usd FROM dashboard_settings WHERE id = 1;`);
    const n = parseFloat(out);
    return Number.isFinite(n) ? n : 25.0;
  } catch (_) { return 25.0; }
}

async function getTotals() {
  // SUM helper-runs cost + chat cost grouped into today / 7d / 30d.
  // We use UNION ALL to merge rows so the SQL aggregates work uniformly.
  const sql = `
    WITH all_costs AS (
      SELECT cost_usd_actual AS cost, started_at AS at FROM agent_runs WHERE cost_usd_actual > 0
      UNION ALL
      SELECT total_cost AS cost, started_at AS at FROM agent_chats WHERE total_cost > 0
    )
    SELECT json_build_object(
      'today',   COALESCE((SELECT SUM(cost) FROM all_costs WHERE at >= CURRENT_DATE), 0),
      'week',    COALESCE((SELECT SUM(cost) FROM all_costs WHERE at >= CURRENT_DATE - INTERVAL '7 days'), 0),
      'month',   COALESCE((SELECT SUM(cost) FROM all_costs WHERE at >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'all_time',COALESCE((SELECT SUM(cost) FROM all_costs), 0)
    ) AS totals;
  `;
  try {
    const out = await queryValue(sql);
    const j = JSON.parse(out);
    return {
      today: Number(j.today) || 0,
      week:  Number(j.week)  || 0,
      month: Number(j.month) || 0,
      all_time: Number(j.all_time) || 0,
    };
  } catch (e) {
    return { today: 0, week: 0, month: 0, all_time: 0, error: e.message.slice(0, 200) };
  }
}

// M-8: cache the snapshot for a few seconds. The topbar polls /cost every
// 30s and renderOverview() also fires a fetch on page load — without
// caching that's 2 DB queries × ~3 callers per minute. The cap-enforcement
// path (canSpend) can also be served from cache; a few seconds of staleness
// is harmless for a $25/month budget guard.
const SNAPSHOT_TTL_MS = 5000;
let _snapCache = { value: null, until: 0 };

// Daily spend for the last 30 days as an array of {date, cost}. Days with
// no spend appear as zero so the sparkline / bar chart has continuous data.
async function dailyTrend(days = 30) {
  const sql = `
    WITH all_costs AS (
      SELECT cost_usd_actual AS cost, started_at AS at FROM agent_runs WHERE cost_usd_actual > 0
      UNION ALL
      SELECT total_cost     AS cost, started_at AS at FROM agent_chats WHERE total_cost > 0
    ),
    days AS (
      SELECT generate_series(CURRENT_DATE - INTERVAL '${days - 1} days', CURRENT_DATE, '1 day')::date AS d
    )
    SELECT json_agg(row_to_json(t) ORDER BY t.date) AS j FROM (
      SELECT d::text AS date, COALESCE((SELECT SUM(cost) FROM all_costs WHERE at::date = d), 0)::float AS cost
        FROM days
    ) t;`;
  try {
    const out = await queryValue(sql);
    const arr = JSON.parse(out || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

// Top-N spenders in the last `days` window. Used to power the agent-level
// breakdown on the Overview Cost card.
async function byAgent(days = 30, limit = 8) {
  const sql = `
    WITH all_costs AS (
      SELECT agent, cost_usd_actual AS cost FROM agent_runs WHERE cost_usd_actual > 0 AND started_at >= CURRENT_DATE - INTERVAL '${days} days'
      UNION ALL
      SELECT agent, total_cost     AS cost FROM agent_chats WHERE total_cost > 0 AND started_at >= CURRENT_DATE - INTERVAL '${days} days'
    )
    SELECT json_agg(row_to_json(t) ORDER BY t.cost DESC) AS j FROM (
      SELECT agent, SUM(cost)::float AS cost, COUNT(*)::int AS calls
        FROM all_costs GROUP BY agent ORDER BY SUM(cost) DESC LIMIT ${limit}
    ) t;`;
  try {
    const out = await queryValue(sql);
    const arr = JSON.parse(out || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

async function _freshSnapshot() {
  const [totals, cap, trend, agents] = await Promise.all([
    getTotals(), getCap(), dailyTrend(30), byAgent(30, 8),
  ]);
  return {
    ...totals,
    cap,
    pct_of_cap: cap > 0 ? Math.min(1, totals.month / cap) : 0,
    over_cap: totals.month >= cap,
    near_cap: totals.month >= cap * 0.8 && totals.month < cap,
    daily_trend: trend,
    by_agent: agents,
  };
}

async function snapshot() {
  const now = Date.now();
  if (_snapCache.value && now < _snapCache.until) return _snapCache.value;
  const v = await _freshSnapshot();
  _snapCache = { value: v, until: now + SNAPSHOT_TTL_MS };
  return v;
}

async function canSpend(projectedAddUsd = 0) {
  const snap = await snapshot();
  return (snap.month + projectedAddUsd) <= snap.cap;
}

// Allow callers that just paid to invalidate the cache so the next read
// reflects the new total. Optional — safe to skip; cache expires in 5s.
function invalidate() { _snapCache = { value: null, until: 0 }; }

module.exports = { getTotals, getCap, snapshot, canSpend, invalidate };
