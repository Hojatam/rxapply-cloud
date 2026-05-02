"""
Cross-post DRY_RUN — read pending scheduled_posts, log each, mark dry_run_logged.
"""
import json, os, subprocess, sys

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")


def _psql(sql, *, tA=False, stdin=None):
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA: args += ["-tA"]
    if stdin is None:
        args += ["-c", sql]
        r = subprocess.run(args, capture_output=True)
    else:
        r = subprocess.run(args, input=stdin.encode("utf-8"), capture_output=True)
    out = r.stdout.decode("utf-8", errors="replace")
    err = r.stderr.decode("utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(f"psql failed:\n{err}\n"); sys.exit(r.returncode)
    return out


def cmd_run():
    sql = (
        "SELECT json_agg(row_to_json(p)) FROM ("
        " SELECT id::text, platform, account_key, language, "
        "        scheduled_at::text, LEFT(text, 100) AS text_preview, "
        "        length(text) AS chars "
        " FROM scheduled_posts "
        " WHERE status = 'pending' "
        " ORDER BY scheduled_at"
        ") p;"
    )
    out = _psql(sql, tA=True).strip()
    if not out or out == "":
        print("No pending scheduled_posts to dry-run.")
        return
    rows = json.loads(out) or []
    if not rows:
        print("No pending scheduled_posts to dry-run.")
        return

    print(f"=== DRY_RUN — {len(rows)} pending posts ===\n")
    for r in rows:
        preview = r["text_preview"].replace("\n", " ")
        print(f"[DRY_RUN] platform={r['platform']} account={r['account_key']} "
              f"language={r['language']} scheduled_at={r['scheduled_at']} "
              f"chars={r['chars']} text=\"{preview}…\"")

    # Mark them all dry_run_logged
    update_sql = "UPDATE scheduled_posts SET status='dry_run_logged' WHERE status='pending' RETURNING id;"
    out = _psql(update_sql, tA=True).strip()
    n = len([ln for ln in out.splitlines() if ln.strip()])
    print(f"\n→ Marked {n} rows as dry_run_logged.")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd in ("run", "help", "--help", "-h"):
        cmd_run() if cmd == "run" else print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
