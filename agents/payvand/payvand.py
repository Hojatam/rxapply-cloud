"""
Payvand helper — partnership outreach drafter.

Subcommands
-----------
  run                     Draft for every partnerships.status='targeted' row.
  draft <partnership_id>  Draft for one partnership row, write to DB.
  preview <id>            Show would-be draft (no write).
  help

No pip deps. Templates only — never calls an LLM. Every draft sits at status
'pending_human_review' inside partnerships.outreach_drafts; nothing is sent.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"
CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
PSQL_BASE = ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]


def _q(s):
    if s is None: return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def _run_psql_json(sql: str):
    args = list(PSQL_BASE) + ["-tA", "-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    out = r.stdout.decode("utf-8","replace").strip()
    return json.loads(out) if out else []


def _run_psql_file(sql: str) -> str:
    fd, host_tmp = tempfile.mkstemp(suffix=".sql", prefix="payvand_")
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


# ─────────────── TEMPLATES ───────────────

OPENERS = {
    "rcic":      "Quick note from RxApply — we're matching Iranian-trained dentists with {country_path} and your RCIC practice keeps surfacing in our research.",
    "oisc":      "Hi from RxApply — we route foreign-trained dentists toward UK ORE pathways and your OISC work overlaps a lot of our pipeline.",
    "mara":      "Hi from RxApply — we route foreign-trained dentists toward Australian ADC assessment and your MARA expertise is squarely in that lane.",
    "exam_prep": "Hi from RxApply — we send Iranian-trained dentists into the {country_path} every month, and your exam-prep cohort keeps coming up when they ask who to study with.",
    "university":"Hi from RxApply — we direct Iranian-trained dentists evaluating {country} qualifying programs to short-listed schools, and yours is on our list.",
    "recruiter": "Hi from RxApply — we maintain a vetted bench of foreign-trained dentists targeting {country}, and we suspect there's pipeline overlap with your recruiting work.",
}
COUNTRY_PATHS = {
    "canada":   "NDEB AFK and bridging-program admission",
    "uk":       "ORE Part 1 / Part 2 preparation",
    "uae":      "DHA / Dataflow primary-source verification",
    "australia":"ADC written + practical assessment",
    "germany":  "ZAB / approbation document compilation",
    "saudi":    "SDLE preparation",
    "usa":      "INBDE pathway",
}
DEFAULT_OPENER = "Hi from RxApply — we work with Iranian-trained dentists planning to practice abroad, and your work in {country} keeps coming up in our research."


def _draft_for(p: dict) -> dict:
    p_type   = (p.get("type") or "").lower()
    country  = (p.get("country") or "").lower()
    contact  = p.get("contact_name") or "there"
    org      = p.get("org_name") or "your organization"
    notes    = p.get("notes") or ""

    country_path = COUNTRY_PATHS.get(country.split("-")[0], f"{country or 'foreign'} licensing pathways")
    country_disp = country.title() if country else "your country"

    opener = OPENERS.get(p_type, DEFAULT_OPENER).format(country_path=country_path, country=country_disp)

    body_lines = [f"Hi {contact},", "", opener, ""]
    if notes:
        body_lines += [
            f"Some context I want to acknowledge: {notes.strip()[:240]}",
            "",
        ]
    body_lines += [
        "Two ways we usually structure these partnerships: (1) we refer qualified leads to you and you cover one piece of the journey we don't, (2) we co-author a short evidence-based explainer your audience can use too.",
        "",
        "Would a 20-min intro call next week make sense? If yes, reply with two slots that work and I'll lock one.",
        "",
        "— Hojat / RxApply",
    ]
    body = "\n".join(body_lines)

    subject = f"RxApply ↔ {org} · partnership re: {country_disp}-bound dentists"
    return {
        "drafted_by":   "payvand",
        "drafted_at":   datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "channel":      "email",
        "subject":      subject,
        "body":         body,
        "status":       "pending_human_review",
    }


# ─────────────── DB ───────────────

def _list_targeted():
    sql = ("SELECT COALESCE(json_agg(row_to_json(p) ORDER BY created_at), '[]'::json) "
           "FROM (SELECT id::text, org_name, contact_name, country, type, status, "
           "             outreach_drafts, notes "
           "      FROM partnerships WHERE status='targeted') p;")
    return _run_psql_json(sql)


def _get(partnership_id):
    sql = ("SELECT row_to_json(p) FROM (SELECT id::text, org_name, contact_name, country, "
           "                                  type, status, outreach_drafts, notes "
           f"                          FROM partnerships WHERE id = {_q(partnership_id)}::uuid) p;")
    out = _run_psql_json(sql)
    return out if isinstance(out, dict) else (out[0] if out else None)


def _append_draft(partnership_id, draft):
    """Append `draft` (a dict) onto the outreach_drafts JSONB array, advance status."""
    draft_json = json.dumps(draft, ensure_ascii=False)
    sql = (
        "UPDATE partnerships SET "
        f"  outreach_drafts = COALESCE(outreach_drafts, '[]'::jsonb) || {_q(draft_json)}::jsonb, "
        "  status = 'draft_ready' "
        f"WHERE id = {_q(partnership_id)}::uuid "
        "RETURNING id;"
    )
    _run_psql_file(sql)


def _zirak_log(status, output_summary, count=0, ref_id="", error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "payvand", "--status", status,
            "--input", "partnerships status=targeted",
            "--output", output_summary,
            "--table", "partnerships", "--trigger", trigger]
    if ref_id: args += ["--ref-id", ref_id]
    if count:  args += ["--count", str(count)]
    if error:  args += ["--error", error]
    subprocess.run(args, capture_output=True)


# ─────────────── COMMANDS ───────────────

def cmd_run(args):
    rows = _list_targeted()
    if not rows:
        _zirak_log("success", "no targeted partnerships to draft", count=0, trigger=args.trigger)
        print(json.dumps({"ok": True, "drafted": 0,
                          "summary": "no partnerships at status='targeted'"}, indent=2))
        return
    drafted = []
    for p in rows:
        existing = p.get("outreach_drafts") or []
        if isinstance(existing, str):
            try: existing = json.loads(existing)
            except Exception: existing = []
        if existing and not args.force:
            continue
        d = _draft_for(p)
        _append_draft(p["id"], d)
        drafted.append({"partnership_id": p["id"], "subject": d["subject"]})
    summary = f"{len(drafted)} draft(s) written; {len(rows) - len(drafted)} skipped (already drafted)"
    _zirak_log("success", summary, count=len(drafted), trigger=args.trigger)
    print(json.dumps({"ok": True, "drafted": len(drafted), "rows": drafted, "summary": summary},
                     ensure_ascii=False, indent=2))


def cmd_draft(args):
    p = _get(args.partnership_id)
    if not p:
        sys.stderr.write(f"ERROR: no partnership with id {args.partnership_id}\n"); sys.exit(2)
    d = _draft_for(p)
    _append_draft(p["id"], d)
    _zirak_log("success", f"draft for {p.get('org_name')}", count=1,
               ref_id=p["id"], trigger=args.trigger)
    print(json.dumps({"ok": True, "partnership_id": p["id"], "draft": d},
                     ensure_ascii=False, indent=2))


def cmd_preview(args):
    p = _get(args.partnership_id)
    if not p:
        sys.stderr.write(f"ERROR: no partnership with id {args.partnership_id}\n"); sys.exit(2)
    d = _draft_for(p)
    print(json.dumps({"partnership_id": p["id"], "preview": d},
                     ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(prog="payvand")
    sub = p.add_subparsers(dest="cmd")
    pr = sub.add_parser("run")
    pr.add_argument("--force", action="store_true",
                    help="redraft even if outreach_drafts is non-empty")
    pr.add_argument("--trigger", default="manual",
                    choices=["manual","cron","webhook","dashboard"])
    pr.set_defaults(func=cmd_run)
    pd = sub.add_parser("draft"); pd.add_argument("partnership_id")
    pd.add_argument("--trigger", default="manual",
                    choices=["manual","cron","webhook","dashboard"])
    pd.set_defaults(func=cmd_draft)
    pp = sub.add_parser("preview"); pp.add_argument("partnership_id")
    pp.set_defaults(func=cmd_preview)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
