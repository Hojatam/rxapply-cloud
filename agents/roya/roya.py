"""
Roya helper — market heatmap intel agent.

Subcommands
-----------
  compose                  Build the market_heatmap JSON object from local DB signals; print to stdout.
  run                      Compose + insert via Paya + journal via Zirak (the usual case).
  run --from-stdin         Skip the composer; read a hand-crafted JSON payload from stdin.
  help

No pip dependencies — uses subprocess + docker exec to reach Postgres,
and shells out to paya.py / zirak.py for persistence.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PAYA  = os.path.join(ROOT, "agents", "paya",  "paya.py")
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
PSQL_BASE = ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
PYBIN = sys.executable or "python"

WINDOW_DAYS = 14


def _run_psql(sql: str) -> str:
    args = list(PSQL_BASE) + ["-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    return r.stdout.decode("utf-8", errors="replace")


def _fetch_signals():
    """Return (leads_by_dest, customers_by_dest, leads_by_source) over WINDOW_DAYS.

    Schema mapping (plan-v3 spec → actual columns from migrations/20260429):
      - leads.country_of_interest     → leads.destination_intent (text[])
      - customers.target_destination  → customers.products (jsonb) — destinations
                                         live inside the products array per row
      - leads.lead_source             → leads.source
    Each lead can target multiple destinations, so we UNNEST the array.
    """
    sql_leads = (
        "SELECT COALESCE(json_object_agg(dest, n), '{}'::json) "
        "FROM (SELECT unnest(destination_intent) AS dest, COUNT(*) AS n "
        "      FROM leads "
        f"     WHERE created_at >= NOW() - INTERVAL '{WINDOW_DAYS} days' "
        "        AND destination_intent IS NOT NULL "
        "        AND array_length(destination_intent, 1) > 0 "
        "      GROUP BY dest) s;"
    )
    # customers.products is jsonb — destination slug lives at $.destination per
    # product. Pull text out of the array, fall back to no rows if shape differs.
    sql_customers = (
        "SELECT COALESCE(json_object_agg(dest, n), '{}'::json) "
        "FROM ("
        "  SELECT (p->>'destination') AS dest, COUNT(*) AS n "
        "  FROM customers c, jsonb_array_elements(c.products) p "
        f" WHERE c.created_at >= NOW() - INTERVAL '{WINDOW_DAYS} days' "
        "    AND p ? 'destination' "
        "  GROUP BY p->>'destination'"
        ") s;"
    )
    sql_sources = (
        "SELECT COALESCE(json_object_agg(source, n), '{}'::json) "
        "FROM (SELECT source, COUNT(*) AS n "
        "      FROM leads "
        f"     WHERE created_at >= NOW() - INTERVAL '{WINDOW_DAYS} days' "
        "        AND source IS NOT NULL "
        "      GROUP BY source) s;"
    )
    def _safe(sql):
        # _run_psql sys.exits on non-zero, so catch SystemExit too.
        try:
            return json.loads(_run_psql(sql).strip() or "{}")
        except (Exception, SystemExit):
            return {}
    return (_safe(sql_leads), _safe(sql_customers), _safe(sql_sources))


def _compose_payload():
    leads_by_dest, custs_by_dest, leads_by_source = _fetch_signals()
    weighted = {}
    all_dests = set(leads_by_dest) | set(custs_by_dest)
    for d in all_dests:
        weighted[d] = leads_by_dest.get(d, 0) + 3 * custs_by_dest.get(d, 0)

    if not weighted:
        return {
            "destinations": [],
            "window_days": WINDOW_DAYS,
            "summary": f"No destination signal in last {WINDOW_DAYS}d. "
                       f"Seed leads/customers or wait. (local-signals only)",
            "raw": {
                "leads_by_destination": leads_by_dest,
                "customers_by_destination": custs_by_dest,
                "leads_by_source": leads_by_source,
            },
        }

    top = max(weighted.values()) or 1
    dests = []
    for d, w in sorted(weighted.items(), key=lambda kv: -kv[1]):
        score = round(w / top, 2)
        if score < 0.10:
            continue
        rationale = (
            f"{leads_by_dest.get(d,0)} leads"
            + (f" + {custs_by_dest.get(d,0)} customers" if custs_by_dest.get(d) else "")
            + f" in {WINDOW_DAYS}d"
        )
        dests.append({"slug": d, "score": score, "rationale": rationale})

    # Build the human summary
    if dests:
        head = ", ".join(f"{d['slug']} ({leads_by_dest.get(d['slug'],0)} leads"
                         + (f"+{custs_by_dest.get(d['slug'],0)}c" if custs_by_dest.get(d['slug']) else "")
                         + ")"
                         for d in dests[:3])
        tail = "" if len(dests) <= 3 else f"; {len(dests)-3} more below"
        # Top source for color
        top_source = (max(leads_by_source.items(), key=lambda kv: kv[1])[0]
                      if leads_by_source else None)
        src = f" Top source: {top_source}." if top_source else ""
        summary = f"{head}{tail}.{src} (local-signals only)"
    else:
        summary = "No destination cleared 0.10 threshold. (local-signals only)"

    return {
        "destinations": dests,
        "window_days": WINDOW_DAYS,
        "summary": summary,
        "raw": {
            "leads_by_destination": leads_by_dest,
            "customers_by_destination": custs_by_dest,
            "leads_by_source": leads_by_source,
        },
    }


def _read_stdin_json():
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    if not raw.strip():
        sys.stderr.write("ERROR: --from-stdin set but stdin was empty\n")
        sys.exit(2)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"ERROR: invalid JSON on stdin: {e}\n")
        sys.exit(2)


def _paya_write(payload: dict) -> str:
    """POST payload to paya. Returns the new intel_snapshots.id."""
    p = subprocess.run(
        [PYBIN, "-X", "utf8", PAYA, "write", "--agent", "roya", "--kind", "market_heatmap"],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
    )
    out = p.stdout.decode("utf-8", errors="replace").strip()
    err = p.stderr.decode("utf-8", errors="replace").strip()
    if p.returncode != 0:
        sys.stderr.write(f"paya write failed (exit {p.returncode}):\n{err}\n")
        sys.exit(p.returncode)
    if err:
        sys.stderr.write(err + "\n")
    return out.splitlines()[-1].strip() if out else ""


def _zirak_log(status: str, output_summary: str, ref_id: str = "", count: int = 0,
               error: str = "", trigger: str = "manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "roya", "--status", status,
            "--input", f"local-signals last-{WINDOW_DAYS}d",
            "--output", output_summary,
            "--table", "intel_snapshots",
            "--trigger", trigger]
    if ref_id: args += ["--ref-id", ref_id]
    if count:  args += ["--count", str(count)]
    if error:  args += ["--error", error]
    p = subprocess.run(args, capture_output=True)
    if p.returncode != 0:
        sys.stderr.write(f"zirak log failed (non-fatal):\n{p.stderr.decode('utf-8','replace')}\n")


# ─────────────────────────── COMMANDS ──────────────────────────

def cmd_compose(args):
    payload = _compose_payload()
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def cmd_run(args):
    try:
        payload = _read_stdin_json() if args.from_stdin else _compose_payload()
    except SystemExit:
        raise
    # For local-only test phase: snapshot the raw counts but strip them from what Pooya reads
    # by keeping them under "raw"; Paya only validates the required keys, "raw" is fine.
    try:
        new_id = _paya_write(payload)
    except SystemExit:
        _zirak_log("fail", "paya validation rejected payload",
                   error="see paya stderr above", trigger=args.trigger)
        raise
    n = len(payload.get("destinations", []))
    summary = (f"market_heatmap snapshot {new_id[:8]}… ({n} destinations)"
               if new_id else f"market_heatmap snapshot ({n} destinations)")
    _zirak_log("success", summary, ref_id=new_id, count=1, trigger=args.trigger)
    print(json.dumps({
        "ok": True,
        "intel_snapshot_id": new_id,
        "destinations": n,
        "summary": payload.get("summary"),
    }, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(prog="roya")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("compose", help="build payload from local signals; print only").set_defaults(func=cmd_compose)
    pr = sub.add_parser("run", help="compose + insert via paya + journal via zirak")
    pr.add_argument("--from-stdin", action="store_true",
                    help="read payload from stdin instead of composing from DB signals")
    pr.add_argument("--trigger", default="manual",
                    choices=["manual", "cron", "webhook", "dashboard"])
    pr.set_defaults(func=cmd_run)
    sub.add_parser("help")

    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__)
        return
    args.func(args)


if __name__ == "__main__":
    main()
