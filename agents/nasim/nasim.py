"""
Nasim helper — trend-spike intel agent.

Subcommands
-----------
  compose            Print would-be spikes as JSON array.
  run                compose + paya bulk + zirak journal.
  topics [DAYS]      Raw topic-frequency table over the last DAYS days (default 30).
  help

No pip deps. Uses paya/zirak for persistence.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PAYA  = os.path.join(ROOT, "agents", "paya",  "paya.py")
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"
CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

RECENT_DAYS   = 3
BASELINE_DAYS = 14
MIN_RECENT    = 3

# Stopwords kept very small — we want "uae fast track" to survive but boilerplate to die.
STOP = set("""
a an the and or but if for to of in on at with by from as is are was were be been being do
does did doing have has had having i you we they it this that those these my our your their
about into out up down then so just like can will would should could may might dont do
just really actually basically anyway also too only very got get gets getting one two three
hi hello hey thanks thank ok okay yes no yep nope please pls
http https www com org net io
""".split())


def _run_psql_json(sql: str):
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    out = r.stdout.decode("utf-8","replace").strip()
    return json.loads(out) if out else []


def _events_window(days: int):
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json) "
        "FROM (SELECT platform, kind, language, payload, created_at::text "
        "      FROM engagement_events "
        f"     WHERE created_at >= NOW() - INTERVAL '{int(days)} days') s;"
    )
    return _run_psql_json(sql)


def _phrases(events, max_per_event=8):
    """Yield phrase strings (1-2-word lowercase) extracted from each event's text."""
    for e in events:
        text = ""
        p = e.get("payload") or {}
        if isinstance(p, dict):
            text = p.get("text") or p.get("body") or p.get("message") or ""
        if not text and e.get("kind"):
            text = e["kind"]
        text = text.lower()
        # Strip URLs, punctuation
        text = re.sub(r"https?://\S+", " ", text)
        text = re.sub(r"[^\w\s']", " ", text, flags=re.UNICODE)
        toks = [t for t in text.split() if t not in STOP and len(t) > 2]
        seen = 0
        # Single tokens
        for t in toks:
            yield t, e.get("platform") or "?"
            seen += 1
            if seen >= max_per_event: break
        if seen >= max_per_event: continue
        # Bigrams
        for i in range(len(toks) - 1):
            bg = toks[i] + " " + toks[i+1]
            yield bg, e.get("platform") or "?"
            seen += 1
            if seen >= max_per_event: break


def _topic_counts(days: int):
    """Return ({topic: count}, {topic: [sample_phrases]}, {topic: top_platform})."""
    events = _events_window(days)
    counts = Counter()
    samples = {}
    plat = {}
    plat_counter = {}
    for e in events:
        for phrase, platform in _phrases([e]):
            counts[phrase] += 1
            plat_counter.setdefault(phrase, Counter())[platform] += 1
            text = (e.get("payload") or {}).get("text") if isinstance(e.get("payload"), dict) else None
            if text and len(samples.setdefault(phrase, [])) < 3:
                samples[phrase].append(text[:140])
    for t, pc in plat_counter.items():
        plat[t] = pc.most_common(1)[0][0]
    return counts, samples, plat


def _compose():
    recent_counts, samples, top_plat = _topic_counts(RECENT_DAYS)
    base_counts, _,   _              = _topic_counts(BASELINE_DAYS)
    if not recent_counts:
        return []

    spikes = []
    for topic, n_recent in recent_counts.most_common():
        if n_recent < MIN_RECENT:
            continue
        recent_rate = n_recent / RECENT_DAYS
        baseline_rate = base_counts.get(topic, 0) / BASELINE_DAYS
        if baseline_rate <= 0:
            momentum = 999
        else:
            ratio = recent_rate / baseline_rate
            if ratio < 2.0:
                continue
            momentum = min(999, int(round((ratio - 1) * 100)))

        spikes.append({
            "topic": topic,
            "platform": top_plat.get(topic, "unknown"),
            "momentum_pct": momentum,
            "sample_phrases": samples.get(topic, [])[:3] or [f"first observation of '{topic}'"],
            "recent_count": n_recent,
            "baseline_rate_per_day": round(baseline_rate, 3),
        })
        if len(spikes) >= 10: break  # cap output
    return spikes


def _paya_bulk(rows):
    p = subprocess.run(
        [PYBIN, "-X", "utf8", PAYA, "bulk", "--agent", "nasim", "--kind", "trend_spike"],
        input=json.dumps(rows, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
    )
    if p.returncode != 0:
        sys.stderr.write(f"paya bulk failed:\n{p.stderr.decode('utf-8','replace')}\n")
        sys.exit(p.returncode)
    return [l.strip() for l in p.stdout.decode("utf-8","replace").splitlines() if l.strip()]


def _zirak_log(status, output_summary, count=0, error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "nasim", "--status", status,
            "--input", f"engagement_events recent={RECENT_DAYS}d baseline={BASELINE_DAYS}d",
            "--output", output_summary,
            "--table", "intel_snapshots", "--trigger", trigger]
    if count: args += ["--count", str(count)]
    if error: args += ["--error", error]
    subprocess.run(args, capture_output=True)


# ─────────────── COMMANDS ───────────────

def cmd_compose(args):
    print(json.dumps(_compose(), ensure_ascii=False, indent=2))


def cmd_run(args):
    spikes = _compose()
    if not spikes:
        _zirak_log("success", "no trend spikes detected", count=0, trigger=args.trigger)
        print(json.dumps({"ok": True, "spikes": 0,
                          "summary": "no engagement signal or nothing crossed 2x baseline"}, indent=2))
        return
    try:
        ids = _paya_bulk(spikes)
    except SystemExit:
        _zirak_log("fail", "paya rejected spikes", error="see paya stderr",
                   trigger=args.trigger)
        raise
    top = spikes[0]
    summary = f"{len(spikes)} trend spike(s); top: {top['topic']} +{top['momentum_pct']}% on {top['platform']}"
    _zirak_log("success", summary, count=len(spikes), trigger=args.trigger)
    print(json.dumps({"ok": True, "spikes": len(spikes), "ids": ids, "summary": summary},
                     indent=2))


def cmd_topics(args):
    counts, _, plat = _topic_counts(args.n)
    top = [{"topic": t, "count": c, "top_platform": plat.get(t, "?")}
           for t, c in counts.most_common(40)]
    print(json.dumps(top, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(prog="nasim")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("compose").set_defaults(func=cmd_compose)
    pr = sub.add_parser("run"); pr.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); pr.set_defaults(func=cmd_run)
    pt = sub.add_parser("topics"); pt.add_argument("n", nargs="?", type=int, default=30)
    pt.set_defaults(func=cmd_topics)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
