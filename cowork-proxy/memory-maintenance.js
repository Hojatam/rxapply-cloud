// cowork-proxy/memory-maintenance.js
// =====================================================================
// M51 · Nightly memory decay + promotion.
//
// Two passes:
//   1. DECAY  — episodic items un-used for N days AND low promotion_score
//               get archived (still in DB, excluded from retrieval).
//   2. PROMOTE — episodic items with promotion_score >= threshold graduate
//                to semantic + importance bump. Once promoted, they survive
//                future decay cycles.
//
// Plus: a `health()` snapshot for the dashboard memory-health widget.
//
// Intended to be called nightly via Railway cron OR n8n. Manual trigger
// via POST /memory/maintenance/run.
// =====================================================================

'use strict';

const { query, queryRows, queryValue, queryReturning, q, qJson } = require('./db');

// ── Config (overridable via env / args) ──────────────────────────────
const DECAY_THRESHOLD_DAYS = 60;     // episodic untouched this long → archive
const DECAY_IMPORTANCE_MAX = 3;      // only decay items with importance ≤ this
const PROMOTE_SCORE_MIN    = 5;      // episodic ref'd in this many runs → promote

// ── Maintenance pass ─────────────────────────────────────────────────

async function run({ thresholdDays = DECAY_THRESHOLD_DAYS,
                      promoteScoreMin = PROMOTE_SCORE_MIN } = {}) {
  const before = await _counts();

  // ── Decay ────
  // Archive episodic items that haven't been used in N days AND don't have
  // a high promotion score AND are not high-importance hand-curated.
  const decayed = await queryValue(`
    WITH d AS (
      UPDATE agent_memory
         SET archived = true
       WHERE type = 'episodic'
         AND archived = false
         AND last_used_at < NOW() - INTERVAL '${thresholdDays} days'
         AND COALESCE(importance, 3) <= ${DECAY_IMPORTANCE_MAX}
         AND COALESCE(promotion_score, 0) < ${promoteScoreMin}
       RETURNING 1
    )
    SELECT COUNT(*)::int FROM d;`);

  // ── Promote ───
  // Episodic items with promotion_score >= threshold graduate to semantic.
  // They get an importance bump (+1, capped at 5) and their score reset to 0
  // (so future maintenance treats them as fresh semantic items).
  const promoted = await queryValue(`
    WITH p AS (
      UPDATE agent_memory
         SET type = 'semantic',
             importance = LEAST(5, COALESCE(importance, 3) + 1),
             promotion_score = 0,
             last_used_at = NOW()
       WHERE type = 'episodic'
         AND archived = false
         AND COALESCE(promotion_score, 0) >= ${promoteScoreMin}
       RETURNING 1
    )
    SELECT COUNT(*)::int FROM p;`);

  const after = await _counts();
  const dn = parseInt(decayed, 10) || 0;
  const pn = parseInt(promoted, 10) || 0;

  // Persist audit trail
  await query(`
    INSERT INTO memory_maintenance_runs
      (decay_threshold_days, promote_score_min, decayed_count, promoted_count,
        total_episodic_before, total_semantic_before,
        total_episodic_after,  total_semantic_after,
        details)
    VALUES (${thresholdDays}, ${promoteScoreMin}, ${dn}, ${pn},
            ${before.episodic}, ${before.semantic},
            ${after.episodic},  ${after.semantic},
            ${qJson({ before, after })});`);

  return {
    ok: true,
    decay_threshold_days: thresholdDays,
    promote_score_min: promoteScoreMin,
    decayed: dn,
    promoted: pn,
    before, after,
  };
}

async function _counts() {
  const rows = await queryRows(`
    SELECT type, COUNT(*) FILTER (WHERE archived = false)::int AS n
      FROM agent_memory
     GROUP BY type;`);
  const out = { episodic: 0, semantic: 0, procedural: 0 };
  for (const r of rows) if (out[r.type] != null) out[r.type] = r.n;
  return out;
}

// ── Promotion-score updates ──────────────────────────────────────────
//
// Other modules (compose orchestrator after a successful run, eval harness
// after a candidate wins, etc.) call this to bump scores on memories that
// were referenced in a high-quality output.
async function bumpPromotionScore({ memoryIds = [], by = 1 }) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) return { ok: true, updated: 0 };
  const ids = memoryIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
  const updated = await queryValue(`
    WITH u AS (
      UPDATE agent_memory
         SET promotion_score = COALESCE(promotion_score, 0) + ${parseInt(by, 10) || 1},
             last_used_at = NOW()
       WHERE id IN (${ids})
       RETURNING 1
    )
    SELECT COUNT(*)::int FROM u;`);
  return { ok: true, updated: parseInt(updated, 10) || 0 };
}

// ── Health snapshot (for the dashboard memory-health widget) ────────
async function health() {
  const counts = await _counts();
  const archived = await queryValue(`SELECT COUNT(*)::int FROM agent_memory WHERE archived = true;`);
  const lastRunRow = await queryValue(`
    SELECT row_to_json(r) FROM (
      SELECT ran_at::text, decayed_count, promoted_count,
              total_episodic_after, total_semantic_after
        FROM memory_maintenance_runs
       ORDER BY ran_at DESC LIMIT 1
    ) r;`);
  let last_run = null;
  try { last_run = lastRunRow ? JSON.parse(lastRunRow) : null; } catch (_) {}

  // Per-agent breakdown of unarchived memory
  const perAgent = await queryRows(`
    SELECT agent, type, COUNT(*) FILTER (WHERE archived = false)::int AS n
      FROM agent_memory
     GROUP BY agent, type
     ORDER BY agent, type;`);

  return {
    counts,
    archived: parseInt(archived, 10) || 0,
    last_run,
    per_agent: perAgent,
  };
}

async function listMaintenanceRuns({ limit = 30 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  return await queryRows(`
    SELECT id::text, ran_at::text, decay_threshold_days, promote_score_min,
            decayed_count, promoted_count,
            total_episodic_before, total_semantic_before,
            total_episodic_after, total_semantic_after
      FROM memory_maintenance_runs
     ORDER BY ran_at DESC LIMIT ${limit};`);
}

module.exports = { run, health, bumpPromotionScore, listMaintenanceRuns };
