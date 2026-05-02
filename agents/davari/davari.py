"""
Davari — n8n flow-health audit over the last 24h of n8n_executions.

Usage
-----
  python davari.py run
      Read last-24h executions, compute per-workflow stats, output JSON.
"""
import json, os, statistics, subprocess, sys

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

FETCH_SQL = (
    "SELECT json_agg(row_to_json(e)) FROM ("
    " SELECT id, workflow, started_at::text, duration_ms, retries, status, "
    "        node_breakdown, payload_size_bytes "
    " FROM n8n_executions "
    " WHERE started_at >= NOW() - INTERVAL '24 hours' "
    " ORDER BY started_at DESC"
    ") e;"
)


def _psql(sql, *, tA=False):
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA:
        args += ["-tA"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed: {r.stderr}\n"); sys.exit(r.returncode)
    return r.stdout


def percentile(values, p):
    """Return the p-th percentile (0..100) of a list of numbers."""
    if not values:
        return 0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100)
    f, c = int(k), min(int(k) + 1, len(s) - 1)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)


def cmd_run():
    out = _psql(FETCH_SQL, tA=True).strip()
    rows = json.loads(out) if out and out != "" else []
    if not rows:
        print(json.dumps({"flow_health": [], "suggested_fixes": ["No executions in the last 24h."]},
                         indent=2))
        return

    # Group by workflow
    by_wf = {}
    for r in rows:
        by_wf.setdefault(r["workflow"], []).append(r)

    # Per-workflow node stats
    flow_health = []
    suggested_fixes = []
    for wf, execs in by_wf.items():
        # Collect node ms across executions
        node_ms = {}  # node -> list[int]
        retries_sum = 0
        for e in execs:
            for n in (e.get("node_breakdown") or []):
                node_ms.setdefault(n["node"], []).append(int(n["ms"]))
            retries_sum += int(e.get("retries") or 0)

        slow_nodes = []
        for node, msl in node_ms.items():
            if len(msl) >= 10:
                threshold = 2 * percentile(msl, 95)
                mode = "p95×2"
            else:
                threshold = 2 * statistics.median(msl) if msl else 0
                mode = "median×2"
            worst = max(msl) if msl else 0
            if threshold and worst >= threshold:
                slow_nodes.append({
                    "node": node,
                    "worst_ms": worst,
                    "threshold_ms": int(threshold),
                    "mode": mode,
                })

        retry_rate = retries_sum / max(len(execs), 1)
        retry_storms = []
        if retry_rate > 0.05:
            # Walk the executions to attribute retries to the slowest node (heuristic)
            slow_node_for_retry = None
            biggest = 0
            for e in execs:
                for n in (e.get("node_breakdown") or []):
                    if int(n["ms"]) > biggest and (e.get("retries") or 0) > 0:
                        biggest = int(n["ms"])
                        slow_node_for_retry = n["node"]
            if slow_node_for_retry:
                retry_storms.append({"node": slow_node_for_retry, "retries": retries_sum})
            else:
                retry_storms.append({"node": "(unattributed)", "retries": retries_sum})

        if slow_nodes and retry_storms:
            status = "red"
        elif slow_nodes or retry_storms:
            status = "amber"
        else:
            status = "green"

        flow_health.append({
            "workflow": wf,
            "status": status,
            "executions": len(execs),
            "slow_nodes": slow_nodes,
            "retry_storms": retry_storms,
        })

        if status == "red":
            sn = slow_nodes[0]
            suggested_fixes.append(
                f"{wf}: {sn['node']} hit {sn['worst_ms']}ms (threshold {sn['threshold_ms']}ms, {sn['mode']}) "
                f"AND retry rate {retry_rate:.0%} ({retries_sum} retries / {len(execs)} runs). "
                "Inspect the slowest run's full node trace; check cowork-proxy load if http_run_agent is involved."
            )
        elif status == "amber" and slow_nodes:
            sn = slow_nodes[0]
            suggested_fixes.append(
                f"{wf}: {sn['node']} latency outlier — {sn['worst_ms']}ms vs {sn['threshold_ms']}ms threshold "
                f"({sn['mode']}). Watch for trend; one outlier doesn't yet justify a fix."
            )
        elif status == "amber" and retry_storms:
            suggested_fixes.append(
                f"{wf}: retry rate {retry_rate:.0%} above 5% threshold. Investigate transient errors."
            )

    flow_health.sort(key=lambda f: {"red": 0, "amber": 1, "green": 2}[f["status"]])

    result = {
        "_meta": {
            "agent": "davari",
            "scenario": "T11b",
            "executions_seen": len(rows),
            "workflows_seen": len(by_wf),
            "status_counts": {s: sum(1 for f in flow_health if f["status"] == s)
                              for s in ("green", "amber", "red")},
        },
        "flow_health": flow_health,
        "suggested_fixes": suggested_fixes,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))

    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "davari-output.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "run":
        cmd_run()
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
