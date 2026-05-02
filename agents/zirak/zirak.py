"""
Zirak helper — append + read the agent_journal table.

Subcommands
-----------
  log     --agent A --status success|fail [--input STR --output STR
                                            --table T --ref-id UUID --count N
                                            --error STR --trigger SRC
                                            --duration-ms INT]
          Insert one already-finished row. Prints the new row's UUID.

  start   --agent A [--input STR --trigger SRC]
          Insert a row with status='running'. Prints the new row's UUID.

  finish  <id> --status success|fail [--output STR --table T --ref-id UUID
                                       --count N --error STR]
          UPDATE the row: set finished_at = now(), recompute duration_ms,
          set status + the optional fields. Prints "<id>|<status>|<duration_ms>".

  tail    [N]                Last N rows (default 20) as a JSON array.
  for-agent <agent> [N]      Last N rows for that agent (default 20).
  failures [N]               Last N rows with status='fail' (default 20).
  help                       Print this docstring.

No pip dependencies — uses subprocess + docker exec to reach Postgres.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
PSQL_BASE = ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]


def _run_psql(sql: str, *, tA: bool = False) -> str:
    args = list(PSQL_BASE)
    if tA:
        args += ["-tA"]
    args += ["-c", sql]
    # Force UTF-8 on Windows: don't pass text=True, decode bytes ourselves.
    r = subprocess.run(args, capture_output=True)
    out = r.stdout.decode("utf-8", errors="replace")
    err = r.stderr.decode("utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{err}\n")
        sys.exit(r.returncode)
    return out


def _run_psql_file(sql: str) -> str:
    """Write SQL to a temp file, docker cp into the container, run psql -f.

    Use this when the SQL contains arbitrary text (input_summary, output_summary,
    error) that we want to pass without worrying about shell quoting.
    """
    fd, host_tmp = tempfile.mkstemp(suffix=".sql", prefix="zirak_")
    os.close(fd)
    try:
        with open(host_tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(sql)
        ctr_path = "/tmp/" + os.path.basename(host_tmp)
        cp = subprocess.run(["docker", "cp", host_tmp, f"{CONTAINER}:{ctr_path}"],
                            capture_output=True)
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed:\n{cp.stderr.decode('utf-8', 'replace')}\n")
            sys.exit(cp.returncode)
        args = list(PSQL_BASE) + ["-tA", "-f", ctr_path]
        r = subprocess.run(args, capture_output=True)
        out = r.stdout.decode("utf-8", errors="replace")
        err = r.stderr.decode("utf-8", errors="replace")
        if r.returncode != 0:
            sys.stderr.write(f"psql failed (exit {r.returncode}):\n{err}\n")
            sys.exit(r.returncode)
        return out
    finally:
        try: os.remove(host_tmp)
        except OSError: pass


def _q(s):
    """SQL-escape a string for a single-quoted literal. None → NULL."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def _qi(n):
    """Integer literal or NULL."""
    if n is None or n == "":
        return "NULL"
    return str(int(n))


def _qu(u):
    """UUID literal (cast) or NULL."""
    if u is None or u == "":
        return "NULL"
    return _q(u) + "::uuid"


def _validate_status(s):
    if s not in ("running", "success", "fail"):
        sys.stderr.write(f"ERROR: status must be running|success|fail, got {s!r}\n")
        sys.exit(2)


def _trim(s, n):
    if s is None: return None
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


# ─────────────────────────── COMMANDS ──────────────────────────

def cmd_log(args):
    _validate_status(args.status)
    a = _trim(args.input, 200)
    o = _trim(args.output, 200)
    err = _trim(args.error, 500)
    sql = f"""
INSERT INTO agent_journal
  (agent, status, started_at, finished_at, duration_ms,
   input_summary, output_summary, output_table, output_id, output_count,
   error, trigger_source)
VALUES
  ({_q(args.agent)}, {_q(args.status)},
   NOW(), NOW(), {_qi(args.duration_ms)},
   {_q(a)}, {_q(o)},
   {_q(args.table)}, {_qu(args.ref_id)}, {_qi(args.count)},
   {_q(err)}, {_q(args.trigger or 'manual')})
RETURNING id;
""".strip()
    out = _run_psql_file(sql).strip()
    # psql -tA returns just the UUID (and maybe a trailing newline / "INSERT 0 1" depending on settings).
    # With -tA -f, psql prints the result rows; pick the first non-empty line that looks like a UUID.
    for line in out.splitlines():
        line = line.strip()
        if len(line) >= 32 and line.count("-") == 4:
            print(line)
            return
    print(out.strip())


def cmd_start(args):
    a = _trim(args.input, 200)
    sql = f"""
INSERT INTO agent_journal (agent, status, started_at,
                           input_summary, trigger_source)
VALUES ({_q(args.agent)}, 'running', NOW(),
        {_q(a)}, {_q(args.trigger or 'manual')})
RETURNING id;
""".strip()
    out = _run_psql_file(sql).strip()
    for line in out.splitlines():
        line = line.strip()
        if len(line) >= 32 and line.count("-") == 4:
            print(line)
            return
    print(out.strip())


def cmd_finish(args):
    _validate_status(args.status)
    if args.status == "running":
        sys.stderr.write("ERROR: finish requires --status success or fail\n")
        sys.exit(2)
    o = _trim(args.output, 200)
    err = _trim(args.error, 500)
    # duration_ms = (NOW() - started_at) in ms; Postgres EPOCH from interval
    sql = f"""
UPDATE agent_journal SET
  finished_at    = NOW(),
  duration_ms    = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
  status         = {_q(args.status)},
  output_summary = COALESCE({_q(o)}, output_summary),
  output_table   = COALESCE({_q(args.table)}, output_table),
  output_id      = COALESCE({_qu(args.ref_id)}, output_id),
  output_count   = COALESCE({_qi(args.count)}, output_count),
  error          = {_q(err)}
WHERE id = {_q(args.id)}::uuid
RETURNING id || '|' || status || '|' || COALESCE(duration_ms::text, 'null');
""".strip()
    out = _run_psql_file(sql).strip()
    if not out:
        sys.stderr.write(f"ERROR: no row updated for id {args.id}\n")
        sys.exit(2)
    print(out.splitlines()[0].strip())


def _read_rows(where: str = "", n: int = 20) -> list:
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, agent, status, "
        "             started_at::text, finished_at::text, duration_ms, "
        "             input_summary, output_summary, "
        "             output_table, output_id::text, output_count, "
        "             error, trigger_source, created_at::text "
        "      FROM agent_journal "
        f"      {where} "
        f"      ORDER BY created_at DESC LIMIT {int(n)}) s;"
    )
    out = _run_psql(sql, tA=True).strip()
    return json.loads(out) if out else []


def cmd_tail(args):
    rows = _read_rows("", args.n)
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def cmd_for_agent(args):
    rows = _read_rows(f"WHERE agent = {_q(args.agent)}", args.n)
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def cmd_failures(args):
    rows = _read_rows("WHERE status = 'fail'", args.n)
    print(json.dumps(rows, ensure_ascii=False, indent=2))


# ─────────────────────────── ARG PARSING ──────────────────────────

def main():
    p = argparse.ArgumentParser(prog="zirak", description="agent_journal writer/reader")
    sub = p.add_subparsers(dest="cmd")

    pl = sub.add_parser("log", help="single-shot: insert a finished row")
    pl.add_argument("--agent", required=True)
    pl.add_argument("--status", required=True, choices=["success", "fail"])
    pl.add_argument("--input", default=None)
    pl.add_argument("--output", default=None)
    pl.add_argument("--table", default=None)
    pl.add_argument("--ref-id", dest="ref_id", default=None)
    pl.add_argument("--count", type=int, default=None)
    pl.add_argument("--error", default=None)
    pl.add_argument("--trigger", default="manual",
                    choices=["manual", "cron", "webhook", "dashboard"])
    pl.add_argument("--duration-ms", dest="duration_ms", type=int, default=None)
    pl.set_defaults(func=cmd_log)

    ps = sub.add_parser("start", help="insert a row with status=running")
    ps.add_argument("--agent", required=True)
    ps.add_argument("--input", default=None)
    ps.add_argument("--trigger", default="manual",
                    choices=["manual", "cron", "webhook", "dashboard"])
    ps.set_defaults(func=cmd_start)

    pf = sub.add_parser("finish", help="UPDATE a running row to success or fail")
    pf.add_argument("id")
    pf.add_argument("--status", required=True, choices=["success", "fail"])
    pf.add_argument("--output", default=None)
    pf.add_argument("--table", default=None)
    pf.add_argument("--ref-id", dest="ref_id", default=None)
    pf.add_argument("--count", type=int, default=None)
    pf.add_argument("--error", default=None)
    pf.set_defaults(func=cmd_finish)

    pt = sub.add_parser("tail", help="last N rows as JSON")
    pt.add_argument("n", nargs="?", type=int, default=20)
    pt.set_defaults(func=cmd_tail)

    pfa = sub.add_parser("for-agent", help="last N rows for one agent")
    pfa.add_argument("agent")
    pfa.add_argument("n", nargs="?", type=int, default=20)
    pfa.set_defaults(func=cmd_for_agent)

    pff = sub.add_parser("failures", help="last N failure rows")
    pff.add_argument("n", nargs="?", type=int, default=20)
    pff.set_defaults(func=cmd_failures)

    sub.add_parser("help")

    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__)
        return
    args.func(args)


if __name__ == "__main__":
    main()
