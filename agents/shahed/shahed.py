"""
Shahed helper — competitor diff intel agent.

Subcommands
-----------
  compose     Read fixture + last snapshot, print diffs as JSON array (no write).
  run         compose + paya bulk write + zirak journal.
  snapshot    Write the current fixture as a single 'baseline' diff for each competitor.
  help

No pip deps. Uses paya/zirak helpers for persistence.
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PAYA  = os.path.join(ROOT, "agents", "paya",  "paya.py")
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

# Built-in default — used if competitor_fixtures.json is missing.
DEFAULT_FIXTURE = {
    "examplerival.com": {
        "topics": ["ndeb afk", "canada bridging"],
        "languages": ["en"],
        "last_known_url": "https://examplerival.com/dentists-canada"
    },
    "rivaldentmigrate.io": {
        "topics": ["dha license uae", "saudi sdle"],
        "languages": ["en", "ar"],
        "last_known_url": "https://rivaldentmigrate.io/uae"
    },
    "globaldentists.example": {
        "topics": ["adc australia", "germany approbation"],
        "languages": ["en", "de"],
        "last_known_url": "https://globaldentists.example/de"
    },
}


def _load_fixture():
    fp = os.path.join(HERE, "competitor_fixtures.json")
    if os.path.exists(fp):
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_FIXTURE


def _last_known_state():
    """Pull the most recent competitor_diff per competitor from intel_snapshots
    and reconstruct a {competitor: {topics, languages, ...}} dict.
    Returns {} if no priors exist."""
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT payload, created_at::text "
        "      FROM intel_snapshots "
        "      WHERE agent='shahed' AND kind='competitor_diff' "
        "      ORDER BY created_at DESC LIMIT 200) s;"
    )
    psql = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-tA", "-c", sql]
    r = subprocess.run(psql, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    rows = json.loads(r.stdout.decode("utf-8", "replace").strip() or "[]")
    state = {}
    # Newest-first, so the first time we see a competitor wins.
    for row in rows:
        p = row.get("payload") or {}
        c = p.get("competitor")
        if not c or c in state: continue
        # Reconstruct: snapshots may not carry full state — best-effort.
        state[c] = {
            "topics": p.get("topics_seen", []),
            "languages": p.get("languages_seen", []),
            "last_known_url": p.get("url", ""),
        }
    return state


def _diff(prev, cur):
    """Yield diff dicts for every competitor whose state changed."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    diffs = []
    for c, state in cur.items():
        prev_s = prev.get(c)
        if prev_s is None:
            diffs.append({
                "competitor": c,
                "what_changed": "first observation",
                "url": state.get("last_known_url", ""),
                "first_seen_at": now,
                "topics_seen": state.get("topics", []),
                "languages_seen": state.get("languages", []),
            })
            continue
        new_topics = sorted(set(state.get("topics", [])) - set(prev_s.get("topics", [])))
        new_langs  = sorted(set(state.get("languages", [])) - set(prev_s.get("languages", [])))
        url_changed = state.get("last_known_url") != prev_s.get("last_known_url")
        notes = []
        if new_topics: notes.append(f"new topic(s): {', '.join(new_topics)}")
        if new_langs:  notes.append(f"new language(s): {', '.join(new_langs)}")
        if url_changed and prev_s.get("last_known_url"):
            notes.append("primary URL changed")
        if not notes:
            continue
        diffs.append({
            "competitor": c,
            "what_changed": "; ".join(notes),
            "url": state.get("last_known_url", ""),
            "first_seen_at": now,
            "topics_seen": state.get("topics", []),
            "languages_seen": state.get("languages", []),
        })
    return diffs


def _paya_bulk(diffs):
    p = subprocess.run(
        [PYBIN, "-X", "utf8", PAYA, "bulk", "--agent", "shahed", "--kind", "competitor_diff"],
        input=json.dumps(diffs, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
    )
    if p.returncode != 0:
        sys.stderr.write(f"paya bulk failed:\n{p.stderr.decode('utf-8','replace')}\n")
        sys.exit(p.returncode)
    return [l.strip() for l in p.stdout.decode("utf-8","replace").splitlines() if l.strip()]


def _zirak_log(status, output_summary, count=0, error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "shahed", "--status", status,
            "--input", "competitor fixture vs last snapshot",
            "--output", output_summary,
            "--table", "intel_snapshots", "--trigger", trigger]
    if count: args += ["--count", str(count)]
    if error: args += ["--error", error]
    subprocess.run(args, capture_output=True)


# ─────────────── COMMANDS ───────────────

def cmd_compose(args):
    diffs = _diff(_last_known_state(), _load_fixture())
    print(json.dumps(diffs, ensure_ascii=False, indent=2))


def cmd_run(args):
    diffs = _diff(_last_known_state(), _load_fixture())
    if not diffs:
        _zirak_log("success", "no competitor diffs since last run", count=0, trigger=args.trigger)
        print(json.dumps({"ok": True, "diffs": 0,
                          "summary": "no changes detected since last run"}, indent=2))
        return
    try:
        ids = _paya_bulk(diffs)
    except SystemExit:
        _zirak_log("fail", "paya rejected one or more diffs",
                   error="see paya stderr", trigger=args.trigger)
        raise
    summary = f"{len(diffs)} competitor diff(s) inserted"
    _zirak_log("success", summary, count=len(diffs), trigger=args.trigger)
    print(json.dumps({"ok": True, "diffs": len(diffs), "ids": ids,
                      "summary": summary}, indent=2))


def cmd_snapshot(args):
    cur = _load_fixture()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = [{
        "competitor": c,
        "what_changed": "baseline snapshot (manual)",
        "url": s.get("last_known_url", ""),
        "first_seen_at": now,
        "topics_seen": s.get("topics", []),
        "languages_seen": s.get("languages", []),
    } for c, s in cur.items()]
    ids = _paya_bulk(rows) if rows else []
    _zirak_log("success", f"baseline snapshot ({len(rows)} competitors)",
               count=len(rows), trigger=args.trigger)
    print(json.dumps({"ok": True, "rows": len(rows), "ids": ids}, indent=2))


def main():
    p = argparse.ArgumentParser(prog="shahed")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("compose").set_defaults(func=cmd_compose)
    pr = sub.add_parser("run"); pr.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); pr.set_defaults(func=cmd_run)
    ps = sub.add_parser("snapshot"); ps.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); ps.set_defaults(func=cmd_snapshot)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
