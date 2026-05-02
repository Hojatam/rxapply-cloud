"""
Kherad helper — content quality scorer (drives the G2 gate).

Subcommands
-----------
  run                  Score every pending_g2 asset, write corrections, advance status.
  score <asset_id>     Score one asset, no DB writes.
  issues <asset_id>    Per-rule breakdown for one asset.
  help

No pip deps. Reads content_assets, content_briefs, intel_snapshots; writes corrections,
updates content_assets.status, journals via Zirak.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"
CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
PSQL_BASE = ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]

PASS_THRESHOLD = 0.7

BANNED = {
    "absolutely", "ultimate", "game-changing", "game-changer", "supercharge",
    "supercharged", "world-class", "best-in-class", "revolutionary", "groundbreaking",
    "literally", "obviously", "simply put", "in conclusion",
    "as we all know", "needless to say",
}


def _run_psql_json(sql: str):
    args = list(PSQL_BASE) + ["-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    out = r.stdout.decode("utf-8","replace").strip()
    return json.loads(out) if out else []


def _run_psql_file(sql: str) -> str:
    fd, host_tmp = tempfile.mkstemp(suffix=".sql", prefix="kherad_")
    os.close(fd)
    try:
        with open(host_tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(sql)
        ctr = "/tmp/" + os.path.basename(host_tmp)
        cp = subprocess.run(["docker", "cp", host_tmp, f"{CONTAINER}:{ctr}"], capture_output=True)
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed:\n{cp.stderr.decode('utf-8','replace')}\n")
            sys.exit(cp.returncode)
        args = list(PSQL_BASE) + ["-tA", "-f", ctr]
        r = subprocess.run(args, capture_output=True)
        if r.returncode != 0:
            sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
            sys.exit(r.returncode)
        return r.stdout.decode("utf-8","replace")
    finally:
        try: os.remove(host_tmp)
        except OSError: pass


def _q(s):
    if s is None: return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def _pending_assets():
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, brief_id::text, language, kind, body_md, citations, status "
        "      FROM content_assets WHERE status='pending_g2') s;"
    )
    return _run_psql_json(sql)


def _asset_by_id(asset_id):
    sql = ("SELECT row_to_json(s) FROM (SELECT id::text, brief_id::text, language, kind, "
           "                                  body_md, citations, status FROM content_assets "
           f"                          WHERE id = {_q(asset_id)}::uuid) s;")
    out = _run_psql_json(sql)
    return out if isinstance(out, dict) else (out[0] if out else None)


def _brief_for(asset):
    if not asset.get("brief_id"): return None
    sql = ("SELECT row_to_json(s) FROM (SELECT id::text, title, source_citations FROM content_briefs "
           f"                          WHERE id = {_q(asset['brief_id'])}::uuid) s;")
    out = _run_psql_json(sql)
    return out if isinstance(out, dict) else (out[0] if out else None)


def _ramin_keywords():
    """Latest Ramin keyword_candidates payload, or None."""
    sql = ("SELECT payload FROM intel_snapshots "
           "WHERE agent='ramin' AND kind='keyword_candidates' "
           "ORDER BY created_at DESC LIMIT 1;")
    args = list(PSQL_BASE) + ["-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0: return None
    out = r.stdout.decode("utf-8","replace").strip()
    if not out: return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _intel_id_exists(uuid_str):
    sql = (f"SELECT EXISTS (SELECT 1 FROM intel_snapshots WHERE id = {_q(uuid_str)}::uuid);")
    args = list(PSQL_BASE) + ["-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    return r.stdout.decode("utf-8","replace").strip() == "t"


# ─────────────── SCORING ───────────────

def _score(asset):
    body = (asset.get("body_md") or "").strip()
    citations = asset.get("citations") or []
    if isinstance(citations, str):
        try: citations = json.loads(citations)
        except Exception: citations = []
    word_count = max(1, len(re.findall(r"\b\w+\b", body)))

    issues = []
    score = 1.0

    # Rule 1 — citation density
    cit_n = len(citations)
    target_cits = max(1, word_count // 400)
    if cit_n == 0:
        issues.append(f"no citations (have {word_count} words)")
        score -= 0.30
    else:
        density = word_count / cit_n
        if density > 800:
            issues.append(f"citation density 1/{int(density)}w (target 1/400w)")
            score -= 0.20
        elif density > 400:
            issues.append(f"citation density 1/{int(density)}w (low; target 1/400w)")
            score -= 0.10

    # Rule 2 — banned-word filler
    body_l = body.lower()
    hits = sorted({b for b in BANNED if re.search(rf"\b{re.escape(b)}\b", body_l)})
    if hits:
        issues.append(f"banned-words: {', '.join(hits[:6])}{'…' if len(hits)>6 else ''}")
        score -= min(0.30, 0.05 * len(hits))

    # Rule 3 — keyword coverage
    ramin = _ramin_keywords()
    if not ramin or not ramin.get("keywords"):
        issues.append("no keyword baseline (ramin not run yet)")
    else:
        kws = [k.get("keyword","").lower() for k in ramin["keywords"][:20] if k.get("keyword")]
        present = sum(1 for kw in kws if kw and kw in body_l)
        coverage = (present / max(1, len(kws))) if kws else 0
        if coverage < 0.30:
            issues.append(f"keyword coverage {int(coverage*100)}% (need ≥30%)")
            score -= 0.15

    # Rule 4 — factual anchoring (citations point at real snapshots)
    bad_anchors = []
    brief = _brief_for(asset)
    sources = []
    if brief and brief.get("source_citations"):
        sc = brief["source_citations"]
        if isinstance(sc, str):
            try: sc = json.loads(sc)
            except Exception: sc = []
        sources = sc
    for s in sources or []:
        if not isinstance(s, str): continue
        m = re.match(r"intel_snapshot:([0-9a-f-]{36})", s)
        if m and not _intel_id_exists(m.group(1)):
            bad_anchors.append(m.group(1)[:8])
    if bad_anchors:
        issues.append(f"dead anchors: {', '.join(bad_anchors)}")
        score -= 0.20 * len(bad_anchors)

    score = max(0.0, min(1.0, round(score, 2)))
    return score, issues


# ─────────────── WRITES ───────────────

def _write_corrections(asset_id, issues, language):
    if not issues: return 0
    parts = []
    for i in issues:
        parts.append(f"({_q(asset_id)}::uuid, {_q(language)}, {_q(i)}, NULL, NULL, NOW())")
    sql = ("INSERT INTO corrections (asset_id, language, before_text, after_text, applied_at, created_at) "
           f"VALUES {', '.join(parts)} RETURNING id;")
    out = _run_psql_file(sql)
    return len([l for l in out.splitlines() if l.strip() and l.strip().count("-")==4])


def _update_asset_status(asset_id, new_status):
    sql = (f"UPDATE content_assets SET status = {_q(new_status)} "
           f"WHERE id = {_q(asset_id)}::uuid RETURNING id;")
    _run_psql_file(sql)


def _zirak_log(status, output_summary, ref_id="", count=0, error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "kherad", "--status", status,
            "--input", "content_assets pending_g2",
            "--output", output_summary,
            "--table", "content_assets", "--trigger", trigger]
    if ref_id: args += ["--ref-id", ref_id]
    if count:  args += ["--count", str(count)]
    if error:  args += ["--error", error]
    subprocess.run(args, capture_output=True)


# ─────────────── COMMANDS ───────────────

def cmd_run(args):
    assets = _pending_assets()
    if not assets:
        _zirak_log("success", "no assets to score (queue empty)", count=0, trigger=args.trigger)
        print(json.dumps({"ok": True, "scored": 0,
                          "summary": "no pending_g2 assets"}, indent=2))
        return
    summary_rows = []
    pass_n = fail_n = 0
    for a in assets:
        score, issues = _score(a)
        if score >= PASS_THRESHOLD:
            _update_asset_status(a["id"], "g2_ready")
            pass_n += 1
            new_status = "g2_ready"
        else:
            _update_asset_status(a["id"], "needs_refine")
            _write_corrections(a["id"], issues, a.get("language") or "en")
            fail_n += 1
            new_status = "needs_refine"
        summary_rows.append({
            "asset_id": a["id"], "lang": a.get("language"), "kind": a.get("kind"),
            "score": score, "status": new_status, "issues": issues,
        })
    summary = (f"{len(assets)} scored: {pass_n} g2_ready, {fail_n} needs_refine")
    _zirak_log("success" if fail_n == 0 else "fail",
               summary, count=len(assets), trigger=args.trigger,
               error=("some assets below 0.7" if fail_n else ""))
    print(json.dumps({"ok": True, "scored": len(assets),
                      "passed": pass_n, "failed": fail_n,
                      "rows": summary_rows}, ensure_ascii=False, indent=2))


def cmd_score(args):
    a = _asset_by_id(args.asset_id)
    if not a:
        sys.stderr.write(f"ERROR: no asset with id {args.asset_id}\n"); sys.exit(2)
    score, issues = _score(a)
    print(json.dumps({"asset_id": a["id"], "score": score,
                      "verdict": "g2_ready" if score >= PASS_THRESHOLD else "needs_refine",
                      "issues": issues}, ensure_ascii=False, indent=2))


def cmd_issues(args):
    cmd_score(args)  # same shape, but explicit alias


def main():
    p = argparse.ArgumentParser(prog="kherad")
    sub = p.add_subparsers(dest="cmd")
    pr = sub.add_parser("run"); pr.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); pr.set_defaults(func=cmd_run)
    ps = sub.add_parser("score"); ps.add_argument("asset_id"); ps.set_defaults(func=cmd_score)
    pi = sub.add_parser("issues"); pi.add_argument("asset_id"); pi.set_defaults(func=cmd_issues)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
