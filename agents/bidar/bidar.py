"""
Bidar — nightly agent-efficiency audit.

Aggregates agent_runs (last 24h) into agent_efficiency rows, then emits
a JSON array of recommendations ranked by urgency.

Usage
-----
  python bidar.py run
      Aggregate, upsert, print ranked JSON to stdout, also save to bidar-output.json.

  python bidar.py preview
      Aggregate but DO NOT write; print what would be written.
"""
import sys
# Force UTF-8 stdout/stderr so non-ASCII (≥, →, Farsi, Arabic, em-dashes) doesn't
# crash on Windows cp1252. Safe on every platform; no-op if already UTF-8.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import json
import os
import subprocess
import sys

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

# Aggregation: one row per (agent, today). Falls back to status-based approval if
# founder_decision is null. Idempotent via the UNIQUE(agent, date) constraint.
AGGREGATE_SQL = r"""
WITH base AS (
  SELECT agent,
         COUNT(*)                                                                         AS runs,
         COUNT(*) FILTER (WHERE status='fail')::float / NULLIF(COUNT(*), 0)                AS fail_rate,
         COALESCE(
           COUNT(*) FILTER (WHERE founder_decision='approved')::float
             / NULLIF(COUNT(*) FILTER (WHERE founder_decision IS NOT NULL), 0),
           COUNT(*) FILTER (WHERE status='success')::float / NULLIF(COUNT(*), 0)
         )                                                                                AS approval_ratio,
         AVG(cost_usd)::numeric(8,4)                                                      AS avg_cost,
         AVG(duration_ms)::int                                                            AS avg_duration_ms
  FROM agent_runs
  WHERE created_at >= NOW() - INTERVAL '24 hours'
  GROUP BY agent
)
SELECT json_agg(row_to_json(b)) FROM base b;
"""

UPSERT_SQL = r"""
INSERT INTO agent_efficiency
  (agent, date, runs, approval_ratio, avg_cost_usd, avg_duration_ms, quality_score, bidar_recommendation)
VALUES
  (%(agent)s, CURRENT_DATE, %(runs)s, %(approval_ratio)s, %(avg_cost)s,
   %(avg_duration_ms)s, %(quality_score)s, %(recommendation)s)
ON CONFLICT (agent, date) DO UPDATE SET
  runs = EXCLUDED.runs,
  approval_ratio = EXCLUDED.approval_ratio,
  avg_cost_usd = EXCLUDED.avg_cost_usd,
  avg_duration_ms = EXCLUDED.avg_duration_ms,
  quality_score = EXCLUDED.quality_score,
  bidar_recommendation = EXCLUDED.bidar_recommendation;
"""


def _psql(sql: str, *, tA: bool = False, stdin: str = None) -> str:
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA:
        args += ["-tA"]
    if stdin is None:
        args += ["-c", sql]
        r = subprocess.run(args, capture_output=True, text=True)
    else:
        r = subprocess.run(args, input=stdin, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{r.stderr}\n"); sys.exit(r.returncode)
    return r.stdout


def aggregate():
    """Return a list of dicts: agent, runs, fail_rate, approval_ratio, avg_cost, avg_duration_ms."""
    out = _psql(AGGREGATE_SQL, tA=True).strip() or "[]"
    return json.loads(out)


def score(rows):
    """Compute quality_score + recommendation per row, return list of records sorted by urgency."""
    URGENCY = {"rewrite": 0, "demote": 1, "keep": 2, "promote": 3}
    out = []
    for r in rows:
        runs = r["runs"] or 0
        fail_rate = r.get("fail_rate") or 0
        approval = r.get("approval_ratio") or 0
        avg_cost = float(r.get("avg_cost") or 0)
        quality = round(0.6 * approval + 0.4 * (1 - fail_rate), 3)

        if runs == 0:
            rec, why = "keep", "no runs in window"
        elif fail_rate >= 0.5:
            rec, why = "rewrite", f"fail_rate {fail_rate:.0%} — majority of runs failed"
        elif runs == 1 and fail_rate == 1.0:
            rec, why = "rewrite", "single run failed; investigate before scaling up"
        elif approval < 0.6 and avg_cost > 0.03:
            rec, why = "rewrite", f"expensive (${avg_cost:.4f}) and rejected often (approval {approval:.0%})"
        elif approval > 0.85 and quality > 0.85:
            # 30-day rule: never promote in test phase
            rec, why = "keep", f"strong (approval {approval:.0%}) but needs ≥30d clean record before promote"
        elif approval < 0.5:
            rec, why = "demote", f"approval below 50% ({approval:.0%}) — add a gate"
        else:
            rec, why = "keep", f"steady at approval {approval:.0%}, cost ${avg_cost:.4f}"

        out.append({
            "agent": r["agent"],
            "action": rec,
            "rationale": why,
            "evidence": {
                "runs": runs,
                "fail_rate": round(fail_rate, 3),
                "approval_ratio": round(approval, 3),
                "avg_cost_usd": round(avg_cost, 4),
                "avg_duration_ms": r.get("avg_duration_ms"),
                "quality_score": quality,
            },
            "_quality": quality,
            "_recommendation": rec,
        })
    out.sort(key=lambda x: (URGENCY.get(x["_recommendation"], 9), -x["_quality"]))
    return out


def upsert(records):
    """Run the UPSERT for every record. Builds a single multi-statement script."""
    if not records:
        return 0
    parts = []
    for rec in records:
        ev = rec["evidence"]
        parts.append(
            "INSERT INTO agent_efficiency "
            "(agent, date, runs, approval_ratio, avg_cost_usd, avg_duration_ms, "
            " quality_score, bidar_recommendation) VALUES ("
            f"'{rec['agent']}', CURRENT_DATE, {ev['runs']}, {ev['approval_ratio']}, "
            f"{ev['avg_cost_usd']}, "
            f"{ev['avg_duration_ms'] if ev['avg_duration_ms'] is not None else 'NULL'}, "
            f"{rec['_quality']}, '{rec['action']}'"
            ") ON CONFLICT (agent, date) DO UPDATE SET "
            "runs = EXCLUDED.runs, approval_ratio = EXCLUDED.approval_ratio, "
            "avg_cost_usd = EXCLUDED.avg_cost_usd, "
            "avg_duration_ms = EXCLUDED.avg_duration_ms, "
            "quality_score = EXCLUDED.quality_score, "
            "bidar_recommendation = EXCLUDED.bidar_recommendation;"
        )
    script = "BEGIN;\n" + "\n".join(parts) + "\nCOMMIT;"
    _psql(script, tA=True, stdin=None) if False else None
    # Use stdin path for safety (large script)
    r = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql",
         "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True
    )
    if r.returncode != 0:
        sys.stderr.write(f"UPSERT failed:\n{r.stderr}\n"); sys.exit(r.returncode)
    return len(records)


def cmd_run(write: bool = True):
    rows = aggregate()
    if not rows:
        sys.stderr.write("No agent_runs in the last 24h — nothing to roll up.\n")
        return
    records = score(rows)
    # Strip private keys before JSON output
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in records]
    out = {
        "_meta": {
            "agent": "bidar",
            "scenario": "T11a",
            "rolled_up_agents": len(records),
            "recommendation_counts": {a: sum(1 for r in records if r["action"] == a)
                                       for a in ("rewrite", "demote", "keep", "promote")}
        },
        "ranking": clean,
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))

    # Save next to this script
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "bidar-output.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    if write:
        n = upsert(records)
        sys.stderr.write(f"\nUpserted {n} agent_efficiency rows for date=CURRENT_DATE.\n")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "run":
        cmd_run(write=True)
    elif cmd == "preview":
        cmd_run(write=False)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
