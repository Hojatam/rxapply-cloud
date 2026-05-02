"""
Paya helper — validate + insert + read intel_snapshots.

Subcommands
-----------
  write   --agent A --kind K           Read JSON object from stdin, validate, insert. Print new id.
  bulk    --agent A --kind K           Read JSON array from stdin, validate each, insert all. Print "id" per row.
  list    [N]                          Last N snapshots (default 20) as JSON.
  by-kind K [N]                        Last N snapshots of kind K.
  by-agent A [N]                       Last N snapshots written by agent A.
  since   D                            Snapshots created in the last D days (sorted desc).
  schema  K                            Print the required-keys schema for kind K.
  help                                 Print this docstring.

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

# kind → required top-level keys in payload
SCHEMA = {
    "market_heatmap":     {"destinations", "window_days", "summary"},
    "competitor_diff":    {"competitor", "what_changed"},
    "regulatory_change":  {"jurisdiction", "what_changed"},
    "trend_spike":        {"topic", "platform", "momentum_pct"},
    "keyword_candidates": {"keywords"},
}
# Aliases — incoming `kind` value normalized on write.
KIND_ALIAS = {
    "reg_change": "regulatory_change",
}

ALLOWED_AGENTS = {"roya", "shahed", "dadbeh", "nasim", "ramin"}


def _run_psql(sql: str, *, tA: bool = False) -> str:
    args = list(PSQL_BASE)
    if tA:
        args += ["-tA"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True)
    out = r.stdout.decode("utf-8", errors="replace")
    err = r.stderr.decode("utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{err}\n")
        sys.exit(r.returncode)
    return out


def _run_psql_file(sql: str) -> str:
    fd, host_tmp = tempfile.mkstemp(suffix=".sql", prefix="paya_")
    os.close(fd)
    try:
        with open(host_tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(sql)
        ctr_path = "/tmp/" + os.path.basename(host_tmp)
        cp = subprocess.run(["docker", "cp", host_tmp, f"{CONTAINER}:{ctr_path}"],
                            capture_output=True)
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed:\n{cp.stderr.decode('utf-8','replace')}\n")
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
    if s is None: return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def _normalize_kind(kind):
    return KIND_ALIAS.get(kind, kind)


def _validate(kind, payload, idx=None):
    if kind not in SCHEMA:
        ks = ", ".join(sorted(SCHEMA))
        sys.stderr.write(f"ERROR: unknown kind {kind!r} — accepted: {ks}\n")
        sys.exit(2)
    if not isinstance(payload, dict):
        loc = f" (index {idx})" if idx is not None else ""
        sys.stderr.write(f"ERROR: payload{loc} must be a JSON object\n")
        sys.exit(2)
    missing = SCHEMA[kind] - set(payload.keys())
    if missing:
        loc = f" (index {idx})" if idx is not None else ""
        sys.stderr.write(f"ERROR: kind={kind}{loc} missing keys: {sorted(missing)}\n")
        sys.exit(2)


def _read_stdin_json():
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    if not raw.strip():
        sys.stderr.write("ERROR: empty payload on stdin\n")
        sys.exit(2)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"ERROR: invalid JSON on stdin: {e}\n")
        sys.exit(2)


# ─────────────────────────── COMMANDS ──────────────────────────

def cmd_write(args):
    if args.agent not in ALLOWED_AGENTS:
        sys.stderr.write(f"WARN: agent {args.agent!r} not in {sorted(ALLOWED_AGENTS)} — proceeding anyway\n")
    kind = _normalize_kind(args.kind)
    payload = _read_stdin_json()
    _validate(kind, payload)
    payload_json = json.dumps(payload, ensure_ascii=False)
    sql = (f"INSERT INTO intel_snapshots (agent, kind, payload) VALUES "
           f"({_q(args.agent)}, {_q(kind)}, {_q(payload_json)}::jsonb) RETURNING id;")
    out = _run_psql_file(sql).strip()
    for line in out.splitlines():
        line = line.strip()
        if len(line) >= 32 and line.count("-") == 4:
            print(line)
            return
    print(out)


def cmd_bulk(args):
    if args.agent not in ALLOWED_AGENTS:
        sys.stderr.write(f"WARN: agent {args.agent!r} not in {sorted(ALLOWED_AGENTS)}\n")
    kind = _normalize_kind(args.kind)
    arr = _read_stdin_json()
    if not isinstance(arr, list):
        sys.stderr.write("ERROR: bulk requires a JSON array\n")
        sys.exit(2)
    if not arr:
        sys.stderr.write("ERROR: empty array — nothing to insert\n")
        sys.exit(2)
    for i, p in enumerate(arr):
        _validate(kind, p, idx=i)
    # Build a single multi-row INSERT inside a transaction so a mid-batch failure rolls back.
    values = []
    for p in arr:
        pj = json.dumps(p, ensure_ascii=False)
        values.append(f"({_q(args.agent)}, {_q(kind)}, {_q(pj)}::jsonb)")
    sql = ("BEGIN;\nINSERT INTO intel_snapshots (agent, kind, payload) VALUES\n  "
           + ",\n  ".join(values)
           + "\nRETURNING id;\nCOMMIT;")
    out = _run_psql_file(sql).strip()
    for line in out.splitlines():
        line = line.strip()
        if len(line) >= 32 and line.count("-") == 4:
            print(line)


def _read_rows(where: str = "", n: int = 20) -> list:
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, agent, kind, payload, created_at::text "
        "      FROM intel_snapshots "
        f"     {where} "
        f"     ORDER BY created_at DESC LIMIT {int(n)}) s;"
    )
    out = _run_psql(sql, tA=True).strip()
    return json.loads(out) if out else []


def cmd_list(args):
    print(json.dumps(_read_rows("", args.n), ensure_ascii=False, indent=2))


def cmd_by_kind(args):
    k = _normalize_kind(args.kind)
    print(json.dumps(_read_rows(f"WHERE kind = {_q(k)}", args.n), ensure_ascii=False, indent=2))


def cmd_by_agent(args):
    print(json.dumps(_read_rows(f"WHERE agent = {_q(args.agent)}", args.n), ensure_ascii=False, indent=2))


def cmd_since(args):
    days = max(1, int(args.days))
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, agent, kind, payload, created_at::text "
        "      FROM intel_snapshots "
        f"     WHERE created_at >= NOW() - INTERVAL '{days} days' "
        "      ORDER BY created_at DESC) s;"
    )
    out = _run_psql(sql, tA=True).strip()
    rows = json.loads(out) if out else []
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def cmd_schema(args):
    k = _normalize_kind(args.kind)
    if k not in SCHEMA:
        sys.stderr.write(f"ERROR: unknown kind {k!r} — accepted: {sorted(SCHEMA)}\n")
        sys.exit(2)
    print(json.dumps({"kind": k, "required_keys": sorted(SCHEMA[k])},
                     ensure_ascii=False, indent=2))


# ─────────────────────────── ARG PARSING ──────────────────────────

def main():
    p = argparse.ArgumentParser(prog="paya", description="intel_snapshots writer/reader")
    sub = p.add_subparsers(dest="cmd")

    pw = sub.add_parser("write", help="single insert from stdin JSON object")
    pw.add_argument("--agent", required=True)
    pw.add_argument("--kind", required=True)
    pw.set_defaults(func=cmd_write)

    pb = sub.add_parser("bulk", help="multi-insert from stdin JSON array")
    pb.add_argument("--agent", required=True)
    pb.add_argument("--kind", required=True)
    pb.set_defaults(func=cmd_bulk)

    pl = sub.add_parser("list", help="last N rows as JSON")
    pl.add_argument("n", nargs="?", type=int, default=20)
    pl.set_defaults(func=cmd_list)

    pk = sub.add_parser("by-kind", help="last N rows for kind K")
    pk.add_argument("kind")
    pk.add_argument("n", nargs="?", type=int, default=20)
    pk.set_defaults(func=cmd_by_kind)

    pa = sub.add_parser("by-agent", help="last N rows by agent A")
    pa.add_argument("agent")
    pa.add_argument("n", nargs="?", type=int, default=20)
    pa.set_defaults(func=cmd_by_agent)

    ps = sub.add_parser("since", help="rows in last D days")
    ps.add_argument("days", type=int)
    ps.set_defaults(func=cmd_since)

    psc = sub.add_parser("schema", help="show required keys for a kind")
    psc.add_argument("kind")
    psc.set_defaults(func=cmd_schema)

    sub.add_parser("help")

    args = p.parse_args()
    if not args.cmd or args.cmd == "help":
        print(__doc__)
        return
    args.func(args)


if __name__ == "__main__":
    main()
