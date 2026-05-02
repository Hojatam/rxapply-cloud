"""
Ravi — fetch weekly metrics + send the Monday narrative via MailHog SMTP.

Usage
-----
  python ravi.py fetch
      Returns {funnel, agent_runs} as JSON. funnel is read from
      fixtures/funnel-14d.csv (relative path resolved from the rxapply-test root).

  python ravi.py send --to <addr> --subject <s> --file <path/to/email.md>
      Sends the email to host.docker.internal:1025 (MailHog SMTP). Plain text
      body uses the markdown as-is (MailHog doesn't render Markdown but that's
      fine — the Founder previews it as text).
"""
import argparse, csv, json, os, smtplib, subprocess, sys
from email.message import EmailMessage

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
HERE = os.path.dirname(os.path.abspath(__file__))
RXAPPLY_ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
FUNNEL_CSV = os.path.join(RXAPPLY_ROOT, "fixtures", "funnel-14d.csv")
SMTP_HOST = os.environ.get("SMTP_HOST", "localhost")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "1025"))


def _psql(sql: str, *, tA: bool = False) -> str:
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA:
        args += ["-tA"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed: {r.stderr}\n"); sys.exit(r.returncode)
    return r.stdout


def cmd_fetch():
    # 1. Funnel from CSV
    funnel = []
    with open(FUNNEL_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            funnel.append({k: (int(v) if v.isdigit() else v) for k, v in row.items()})

    # Split into last week (most recent 7) vs prior week (next 7)
    funnel_sorted = sorted(funnel, key=lambda r: r["date"])
    last_week = funnel_sorted[-7:]
    prior_week = funnel_sorted[-14:-7]

    def total(rows, key):
        return sum(int(r[key]) for r in rows)

    metrics = {}
    for k in ("sessions", "advisor_completions", "email_signups",
              "guide_page_views", "purchases"):
        cur, prev = total(last_week, k), total(prior_week, k)
        metrics[k] = {
            "this_week": cur,
            "prior_week": prev,
            "delta": cur - prev,
            "delta_pct": round(100 * (cur - prev) / max(prev, 1), 1),
        }

    # 2. Agent runs summary (last 24h)
    sql = (
        "SELECT json_build_object("
        " 'total_runs', COUNT(*),"
        " 'fail_count', COUNT(*) FILTER (WHERE status='fail'),"
        " 'total_cost_usd', ROUND(SUM(cost_usd)::numeric, 4),"
        " 'avg_duration_ms', ROUND(AVG(duration_ms)::numeric, 0),"
        " 'unique_agents', COUNT(DISTINCT agent)"
        ") FROM agent_runs WHERE created_at >= NOW() - INTERVAL '24 hours';"
    )
    agent_summary = json.loads(_psql(sql, tA=True).strip())

    print(json.dumps({
        "funnel_weekly": metrics,
        "funnel_dates": {"this_week_start": last_week[0]["date"],
                         "this_week_end": last_week[-1]["date"]},
        "agent_runs_24h": agent_summary,
    }, indent=2, ensure_ascii=False))


def cmd_send(to_addr: str, subject: str, file_path: str):
    with open(file_path, "r", encoding="utf-8") as f:
        body = f.read()

    msg = EmailMessage()
    msg["From"] = "ravi@rxapply.test"
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
        s.send_message(msg)
        print(f"sent to {to_addr} via {SMTP_HOST}:{SMTP_PORT}")
    print(f"subject: {subject}")
    print(f"body chars: {len(body)}")
    print(f"body words: {len(body.split())}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "fetch":
        cmd_fetch()
    elif cmd == "send":
        ap = argparse.ArgumentParser(prog="ravi.py send")
        ap.add_argument("--to", required=True)
        ap.add_argument("--subject", required=True)
        ap.add_argument("--file", required=True)
        args = ap.parse_args(sys.argv[2:])
        cmd_send(args.to, args.subject, args.file)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
