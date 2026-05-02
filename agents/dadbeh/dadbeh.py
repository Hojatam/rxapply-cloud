"""
Dadbeh helper — regulatory change intel agent.

Subcommands
-----------
  compose                   Print would-be writes as JSON array.
  run                       compose + paya bulk + zirak journal.
  upcoming [N]              All seed events in next N days (default 90), bypasses dedup.
  help

No pip deps. Uses paya/zirak helpers for persistence.
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PAYA  = os.path.join(ROOT, "agents", "paya",  "paya.py")
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"
CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

# Built-in seed for the local test phase. Plausible 2026 events.
DEFAULT_FIXTURE = [
    {"jurisdiction":"ON-Canada","what_changed":"NDEB AFK exam moves to monthly cadence",
     "effective_date":"2026-06-01","severity":"high",
     "source_url":"https://ndeb-bned.ca/example"},
    {"jurisdiction":"BC-Canada","what_changed":"Bridging program intake doubles",
     "effective_date":"2026-09-01","severity":"med",
     "source_url":"https://example/bc-bridging"},
    {"jurisdiction":"UAE-DHA","what_changed":"Dataflow primary-source verification fee revised",
     "effective_date":"2026-05-15","severity":"med",
     "source_url":"https://dha.gov.ae/example"},
    {"jurisdiction":"Australia-ADC","what_changed":"Written exam adds new oral-pathology section",
     "effective_date":"2026-07-12","severity":"high",
     "source_url":"https://adc.org.au/example"},
    {"jurisdiction":"UK-GDC","what_changed":"ORE Part 1 application portal migrates to new system",
     "effective_date":"2026-05-05","severity":"low",
     "source_url":"https://gdc-uk.org/example"},
    {"jurisdiction":"DE-ZAB","what_changed":"Approbation document checklist gets new German-language requirement",
     "effective_date":"2026-08-15","severity":"med",
     "source_url":"https://zab.de/example"},
]


def _load_fixture():
    fp = os.path.join(HERE, "regulatory_fixtures.json")
    if os.path.exists(fp):
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_FIXTURE


def _already_emitted_recently():
    """Set of (jurisdiction, what_changed) already snapshotted in last 14 days."""
    sql = (
        "SELECT COALESCE(json_agg(payload), '[]'::json) "
        "FROM intel_snapshots "
        "WHERE agent='dadbeh' AND kind='regulatory_change' "
        "  AND created_at >= NOW() - INTERVAL '14 days';"
    )
    psql = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-tA", "-c", sql]
    r = subprocess.run(psql, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    rows = json.loads(r.stdout.decode("utf-8","replace").strip() or "[]")
    return {(p.get("jurisdiction"), p.get("what_changed")) for p in rows}


def _filter_window(events, lookback=7, lookahead=90):
    today = date.today()
    lo = today - timedelta(days=lookback)
    hi = today + timedelta(days=lookahead)
    out = []
    for e in events:
        try:
            d = datetime.fromisoformat(e["effective_date"]).date()
        except Exception:
            continue
        if lo <= d <= hi:
            e2 = dict(e)
            e2["days_until_effective"] = (d - today).days
            out.append(e2)
    return out


def _compose():
    events_in_window = _filter_window(_load_fixture())
    seen = _already_emitted_recently()
    return [e for e in events_in_window
            if (e["jurisdiction"], e["what_changed"]) not in seen]


def _paya_bulk(events):
    p = subprocess.run(
        [PYBIN, "-X", "utf8", PAYA, "bulk", "--agent", "dadbeh", "--kind", "regulatory_change"],
        input=json.dumps(events, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
    )
    if p.returncode != 0:
        sys.stderr.write(f"paya bulk failed:\n{p.stderr.decode('utf-8','replace')}\n")
        sys.exit(p.returncode)
    return [l.strip() for l in p.stdout.decode("utf-8","replace").splitlines() if l.strip()]


def _zirak_log(status, output_summary, count=0, error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "dadbeh", "--status", status,
            "--input", "regulatory fixture, window -7..+90d",
            "--output", output_summary,
            "--table", "intel_snapshots", "--trigger", trigger]
    if count: args += ["--count", str(count)]
    if error: args += ["--error", error]
    subprocess.run(args, capture_output=True)


def cmd_compose(args):
    print(json.dumps(_compose(), ensure_ascii=False, indent=2))


def cmd_run(args):
    events = _compose()
    if not events:
        _zirak_log("success", "no regulatory changes in window", count=0, trigger=args.trigger)
        print(json.dumps({"ok": True, "events": 0,
                          "summary": "no events matched window or all already emitted"}, indent=2))
        return
    try:
        ids = _paya_bulk(events)
    except SystemExit:
        _zirak_log("fail", "paya rejected events", error="see paya stderr",
                   trigger=args.trigger)
        raise
    _zirak_log("success", f"{len(events)} regulatory change(s) inserted",
               count=len(events), trigger=args.trigger)
    print(json.dumps({"ok": True, "events": len(events), "ids": ids}, indent=2))


def cmd_upcoming(args):
    print(json.dumps(_filter_window(_load_fixture(), lookback=0, lookahead=args.n),
                     ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(prog="dadbeh")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("compose").set_defaults(func=cmd_compose)
    pr = sub.add_parser("run"); pr.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); pr.set_defaults(func=cmd_run)
    pu = sub.add_parser("upcoming"); pu.add_argument("n", nargs="?", type=int, default=90)
    pu.set_defaults(func=cmd_upcoming)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
