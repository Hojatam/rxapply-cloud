"""
Ramin helper — keyword candidate synthesizer.

Subcommands
-----------
  compose     Print would-be payload as JSON (no write).
  run         compose + paya write + zirak journal.
  help

No pip deps. Uses paya/zirak for persistence.
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PAYA  = os.path.join(ROOT, "agents", "paya",  "paya.py")
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"
CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

WINDOW_DAYS = 7

# Crude volume table for the test phase (real data would come from SerpAPI or similar).
VOLUME_HINTS = {
    "ndeb": 1100, "afk": 800, "adc": 950, "dha": 1300, "sdle": 600,
    "gdc": 700, "ore": 720, "ahpra": 500, "approbation": 900, "zab": 400,
    "bridging": 550, "license": 1500, "exam": 2000, "timeline": 600,
    "cost": 1900, "fees": 1500, "fast track": 1100, "2026": 250,
}
INTENT_VERBS = {
    "comparison": ["vs", "or", "best", "compare"],
    "commercial": ["cost", "fees", "price", "salary", "scholarship"],
    "transactional": ["apply", "register", "enroll", "book"],
}


def _run_psql_json(sql: str):
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    out = r.stdout.decode("utf-8","replace").strip()
    return json.loads(out) if out else []


def _intel_recent():
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, agent, kind, payload, created_at::text "
        "      FROM intel_snapshots "
        f"     WHERE created_at >= NOW() - INTERVAL '{WINDOW_DAYS} days' "
        "      ORDER BY created_at DESC) s;"
    )
    return _run_psql_json(sql)


def _est_volume(keyword: str) -> int:
    base = 100
    for k, v in VOLUME_HINTS.items():
        if k in keyword:
            base = max(base, v)
    if "2026" in keyword:
        base = int(base * 0.6)
    return base


def _classify_intent(keyword: str) -> str:
    kw = keyword.lower()
    for intent, verbs in INTENT_VERBS.items():
        for v in verbs:
            if re.search(rf"\b{v}\b", kw):
                return intent
    return "info"


def _compose():
    rows = _intel_recent()
    by_kind = {}
    for r in rows:
        by_kind.setdefault(r["kind"], []).append(r)

    # Top destinations from latest market_heatmap
    top_dests = []
    for r in by_kind.get("market_heatmap", [])[:1]:  # just newest
        for d in (r["payload"] or {}).get("destinations", []):
            top_dests.append((d.get("slug"), d.get("score", 0), r["id"]))
    top_dests = [(d, s, rid) for d, s, rid in top_dests if d][:5]

    # Recent regulatory hooks
    reg_hooks = []
    for r in by_kind.get("regulatory_change", []):
        p = r["payload"] or {}
        what = (p.get("what_changed") or "").lower()
        # Reduce to a 3-word hook
        words = re.findall(r"[a-z0-9]+", what)
        hook = " ".join(words[:3]) if words else None
        if hook:
            reg_hooks.append((hook, p.get("jurisdiction", ""), r["id"]))

    # Trend topics
    trend_topics = []
    for r in by_kind.get("trend_spike", []):
        p = r["payload"] or {}
        topic = p.get("topic")
        if topic:
            trend_topics.append((topic.lower(), r["id"]))

    # Competitor gaps — use the what_changed string verbatim as a candidate phrase
    comp_gaps = []
    for r in by_kind.get("competitor_diff", []):
        p = r["payload"] or {}
        wc = (p.get("what_changed") or "").lower()
        words = re.findall(r"[a-z0-9]+", wc)
        if 2 <= len(words) <= 6:
            comp_gaps.append((" ".join(words), r["id"]))

    candidates = []
    seen_kw = set()

    def _add(keyword, dests, anchor_ids):
        kw = re.sub(r"\s+", " ", keyword).strip().lower()
        if not kw or kw in seen_kw or len(kw) > 70:
            return
        seen_kw.add(kw)
        candidates.append({
            "keyword": kw,
            "est_volume": _est_volume(kw),
            "intent": _classify_intent(kw),
            "related_destinations": dests,
            "anchor_intel_ids": anchor_ids,
        })

    # destinations × regulatory hooks → "{hook} {dest} 2026"
    for dest, score, dest_id in top_dests:
        for hook, jur, hid in reg_hooks:
            _add(f"{hook} {dest} 2026", [dest], [hid, dest_id])
        for hook, jur, hid in reg_hooks:
            _add(f"{dest} {hook} timeline", [dest], [hid, dest_id])

    # destinations × trend topics
    for dest, score, dest_id in top_dests:
        for topic, tid in trend_topics:
            if dest in topic:
                _add(topic, [dest], [tid, dest_id])
            else:
                _add(f"{topic} {dest}", [dest], [tid, dest_id])

    # competitor gaps as standalone candidates
    for phrase, cid in comp_gaps:
        _add(phrase, [], [cid])

    # If nothing at all, fall back to a few destination basics
    if not candidates and top_dests:
        for dest, _, dest_id in top_dests:
            _add(f"dentist license {dest} 2026", [dest], [dest_id])
            _add(f"{dest} bridging program cost", [dest], [dest_id])

    candidates = sorted(candidates, key=lambda c: -c["est_volume"])[:20]
    anchor_ids = sorted({i for c in candidates for i in c["anchor_intel_ids"]})

    if candidates:
        top_dests_in_kw = []
        for c in candidates:
            top_dests_in_kw += c["related_destinations"]
        from collections import Counter
        common_dests = [d for d, _ in Counter(top_dests_in_kw).most_common(3)] or ["—"]
        summary = (f"{len(candidates)} candidates from {len(rows)} intel rows ({WINDOW_DAYS}d); "
                   f"anchors: {', '.join(common_dests)}")
    else:
        summary = "no recent intel — ramin idle"

    return {
        "keywords": candidates,
        "anchor_intel_ids": anchor_ids,
        "summary": summary,
    }


def _paya_write(payload):
    p = subprocess.run(
        [PYBIN, "-X", "utf8", PAYA, "write", "--agent", "ramin", "--kind", "keyword_candidates"],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
    )
    if p.returncode != 0:
        sys.stderr.write(f"paya write failed:\n{p.stderr.decode('utf-8','replace')}\n")
        sys.exit(p.returncode)
    out = p.stdout.decode("utf-8","replace").strip()
    return out.splitlines()[-1].strip() if out else ""


def _zirak_log(status, output_summary, ref_id="", count=0, error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "ramin", "--status", status,
            "--input", f"intel last-{WINDOW_DAYS}d",
            "--output", output_summary,
            "--table", "intel_snapshots", "--trigger", trigger]
    if ref_id: args += ["--ref-id", ref_id]
    if count:  args += ["--count", str(count)]
    if error:  args += ["--error", error]
    subprocess.run(args, capture_output=True)


def cmd_compose(args):
    print(json.dumps(_compose(), ensure_ascii=False, indent=2))


def cmd_run(args):
    payload = _compose()
    try:
        new_id = _paya_write(payload)
    except SystemExit:
        _zirak_log("fail", "paya rejected payload", error="see paya stderr",
                   trigger=args.trigger)
        raise
    n = len(payload.get("keywords", []))
    summary = f"keyword_candidates {new_id[:8]}… ({n} candidates)" if new_id else f"keyword_candidates ({n} candidates)"
    _zirak_log("success", summary, ref_id=new_id, count=1, trigger=args.trigger)
    print(json.dumps({"ok": True, "intel_snapshot_id": new_id,
                      "candidates": n, "summary": payload.get("summary")}, indent=2))


def main():
    p = argparse.ArgumentParser(prog="ramin")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("compose").set_defaults(func=cmd_compose)
    pr = sub.add_parser("run"); pr.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); pr.set_defaults(func=cmd_run)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
