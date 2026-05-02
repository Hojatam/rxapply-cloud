"""
Mehmandar helper — guest pipeline curator.

Subcommands
-----------
  run              Build digest + send overdue emails to MailHog + journal.
  digest           Print digest only, no emails.
  overdue          Print overdue rows as JSON.
  help

No pip deps — uses smtplib (stdlib) for MailHog (port 1025) and docker exec psql.
"""
import argparse
import json
import os
import smtplib
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ZIRAK = os.path.join(ROOT, "agents", "zirak", "zirak.py")
PYBIN = sys.executable or "python"
CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
PSQL_BASE = ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1"]
SMTP_HOST = os.environ.get("MAILHOG_HOST", "localhost")
SMTP_PORT = int(os.environ.get("MAILHOG_PORT", "1025"))
FROM_ADDR = "mehmandar@rxapply.local"
FOUNDER_ADDR = "hojat@rxapply.local"

# Stage SLAs (days since created_at after which the row is overdue at that stage)
SLA_DAYS = {
    "invited":    7,
    "scheduling": 5,
    "scheduled":  1,   # if recording hasn't moved status within a day of scheduled time
    "recorded":   3,   # if not released within 3 days of recording
}


def _q(s):
    if s is None: return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def _run_psql_json(sql: str):
    args = list(PSQL_BASE) + ["-c", sql]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{r.stderr.decode('utf-8','replace')}\n")
        sys.exit(r.returncode)
    out = r.stdout.decode("utf-8","replace").strip()
    return json.loads(out) if out else []


def _pipeline_with_lead():
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY g.created_at DESC), '[]'::json) "
        "FROM (SELECT g.id::text, g.status, g.origin_country, g.destination_country, "
        "             g.story_summary, g.episode_id, g.release_form_signed, "
        "             g.created_at::text, "
        "             COALESCE(l.full_name, '(unknown)') AS guest_name, "
        "             l.email AS guest_email "
        "      FROM guest_pipeline g LEFT JOIN leads l ON l.id = g.lead_id) s;"
    )
    return _run_psql_json(sql)


def _classify(rows):
    """Group rows by stage and mark each as on-track or overdue."""
    by_stage = {"invited": [], "scheduling": [], "scheduled": [],
                "recorded": [], "released": []}
    overdue = []
    now = datetime.now(timezone.utc)
    for r in rows:
        stage = (r.get("status") or "invited").lower()
        if stage not in by_stage:
            stage = "invited"
        by_stage[stage].append(r)
        try:
            created = datetime.fromisoformat(r["created_at"].replace(" ", "T"))
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        sla = SLA_DAYS.get(stage)
        if sla is None: continue
        age_days = (now - created).total_seconds() / 86400
        # Special case: 'scheduled' with no signed release form is overdue regardless of age.
        if stage == "scheduled" and not r.get("release_form_signed"):
            overdue.append({**r, "_reason": "release form not signed"})
        elif age_days > sla:
            overdue.append({**r, "_reason": f"in {stage} for {int(age_days)}d (SLA {sla}d)"})
    return by_stage, overdue


def _digest_text(by_stage, overdue):
    counts = {k: len(v) for k, v in by_stage.items()}
    total = sum(counts.values())
    lines = [
        f"Guest pipeline · {total} total guests across stages",
        f"  invited:    {counts['invited']}",
        f"  scheduling: {counts['scheduling']}",
        f"  scheduled:  {counts['scheduled']}",
        f"  recorded:   {counts['recorded']}",
        f"  released:   {counts['released']}",
    ]
    if overdue:
        lines.append(f"\nOverdue ({len(overdue)}):")
        for r in overdue[:10]:
            who = r.get("guest_name") or "(unknown)"
            lines.append(f"  - {who} · {r.get('status')} · {r.get('_reason')}")
    else:
        lines.append("\nOverdue: none")
    return "\n".join(lines)


# ─────────────── EMAIL TEMPLATES ───────────────

def _email_for_overdue(row):
    name = row.get("guest_name") or "there"
    stage = row.get("status")
    if stage == "invited":
        subject = f"RxApply guest spot · scheduling check-in for {name}"
        body = (f"Hi {name},\n\nQuick check-in on your RxApply guest spot. We invited you "
                f"a little while back; if you can send two 30-min slots that work in the "
                f"next two weeks, I'll lock one and send the recording link.\n\n— Hojat / RxApply\n")
    elif stage == "scheduling":
        subject = f"RxApply · two slots from you and we're set"
        body = (f"Hi {name},\n\nThanks again for being open to recording with us. Could you "
                f"send two 30-min windows in the next 7 days? Once I have those I'll send a "
                f"calendar invite and the prep doc.\n\n— Hojat / RxApply\n")
    elif stage == "scheduled" and not row.get("release_form_signed"):
        subject = f"RxApply · release form for our recording"
        body = (f"Hi {name},\n\nLooking forward to recording with you. One housekeeping item: "
                f"please sign the simple release form (link in our last email) so we can publish "
                f"the conversation. Takes 30 seconds.\n\n— Hojat / RxApply\n")
    elif stage == "recorded":
        subject = f"RxApply · publication slot for our episode"
        body = (f"Hi {name},\n\nGreat conversation — thanks again. We're targeting publication "
                f"for next week and I'll send you the final cut for review 48h before it goes "
                f"live.\n\n— Hojat / RxApply\n")
    else:
        subject = f"RxApply · checking in"
        body = (f"Hi {name},\n\nJust touching base on your RxApply guest spot — happy to help "
                f"unblock anything on your side.\n\n— Hojat / RxApply\n")
    return subject, body


def _send(to_addr, subject, body):
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = FROM_ADDR
    msg["To"] = to_addr
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
        s.send_message(msg)


def _zirak_log(status, output_summary, count=0, error="", trigger="manual"):
    args = [PYBIN, "-X", "utf8", ZIRAK, "log",
            "--agent", "mehmandar", "--status", status,
            "--input", "guest_pipeline",
            "--output", output_summary,
            "--table", "guest_pipeline", "--trigger", trigger]
    if count: args += ["--count", str(count)]
    if error: args += ["--error", error]
    subprocess.run(args, capture_output=True)


# ─────────────── COMMANDS ───────────────

def cmd_digest(args):
    rows = _pipeline_with_lead()
    by_stage, overdue = _classify(rows)
    print(_digest_text(by_stage, overdue))


def cmd_overdue(args):
    rows = _pipeline_with_lead()
    _, overdue = _classify(rows)
    print(json.dumps(overdue, ensure_ascii=False, indent=2))


def cmd_run(args):
    rows = _pipeline_with_lead()
    if not rows:
        _zirak_log("success", "guest pipeline empty", count=0, trigger=args.trigger)
        print("Guest pipeline empty.")
        return
    by_stage, overdue = _classify(rows)
    digest = _digest_text(by_stage, overdue)
    sent = 0
    failed = []
    for r in overdue:
        addr = r.get("guest_email") or FOUNDER_ADDR  # fall back to founder if no contact email
        subject, body = _email_for_overdue(r)
        try:
            _send(addr, subject, body)
            sent += 1
        except Exception as e:
            failed.append(f"{r.get('guest_name')}: {e}")
    # Always send digest to founder
    try:
        _send(FOUNDER_ADDR, "RxApply guest pipeline · weekly digest", digest)
        sent += 1
    except Exception as e:
        failed.append(f"founder digest: {e}")

    summary = (f"{sent} email(s) sent; {len(overdue)} overdue; "
               f"{sum(len(v) for v in by_stage.values())} total guests")
    if failed:
        _zirak_log("fail", summary + f" ({len(failed)} email failures)",
                   count=sent, error="; ".join(failed)[:480], trigger=args.trigger)
    else:
        _zirak_log("success", summary, count=sent, trigger=args.trigger)
    print(digest)
    print("\n" + summary)
    if failed:
        print("Failed sends:\n  - " + "\n  - ".join(failed))


def main():
    p = argparse.ArgumentParser(prog="mehmandar")
    sub = p.add_subparsers(dest="cmd")
    pr = sub.add_parser("run"); pr.add_argument("--trigger", default="manual",
        choices=["manual","cron","webhook","dashboard"]); pr.set_defaults(func=cmd_run)
    sub.add_parser("digest").set_defaults(func=cmd_digest)
    sub.add_parser("overdue").set_defaults(func=cmd_overdue)
    sub.add_parser("help")
    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__); return
    args.func(args)


if __name__ == "__main__":
    main()
