"""
Afshin helper — minimal CLI for inspecting / managing media_library rows.
The actual design generation (Claude draft + gpt-image-1 render) lives
in the proxy at cowork-proxy/afshin-router.js because it requires API
calls that benefit from the proxy's centralized cost tracking.

Usage
-----
  python afshin.py list [--kind=<k>] [--approved-only]
      Print media_library rows as JSON.

  python afshin.py latest <kind>
      Print the single latest approved asset of <kind> as JSON.

  python afshin.py mark-used <id> <agent>
      Append <agent> to the asset's used_by[] array.
"""
import json
import os
import subprocess
import sys

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
PSQL = ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres",
        "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1"]


def _q(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _exec(sql):
    r = subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql ({r.returncode}): {r.stderr[:500]}\n")
        sys.exit(r.returncode)
    return r.stdout.strip()


def list_media(kind=None, approved_only=False):
    where = ["archived = false"]
    if kind: where.append(f"kind = {_q(kind)}")
    if approved_only: where.append("approved = true")
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, kind, topic, language, draft_path, render_path, "
        "dimensions, approved, draft_cost_usd, render_cost_usd, used_by, created_at::text "
        f"FROM media_library WHERE {' AND '.join(where)}) s;"
    )
    out = _exec(sql)
    return json.loads(out) if out else []


def latest_approved(kind):
    sql = (
        "SELECT row_to_json(s) FROM (SELECT id::text, kind, topic, language, "
        "draft_path, render_path, dimensions, used_by FROM media_library "
        f"WHERE kind = {_q(kind)} AND approved = true AND archived = false "
        "ORDER BY created_at DESC LIMIT 1) s;"
    )
    out = _exec(sql)
    if not out:
        return None
    return json.loads(out)


def mark_used(media_id, agent):
    sql = (
        f"UPDATE media_library SET used_by = array_append(used_by, {_q(agent)}) "
        f"WHERE id = {_q(media_id)} AND NOT (used_by @> ARRAY[{_q(agent)}]) "
        "RETURNING id::text, used_by;"
    )
    out = _exec(sql)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd in ("help", "--help"):
        print(__doc__); return
    if cmd == "list":
        kind = None; approved_only = False
        for a in sys.argv[2:]:
            if a.startswith("--kind="): kind = a.split("=",1)[1]
            elif a == "--approved-only": approved_only = True
        print(json.dumps(list_media(kind, approved_only), indent=2, default=str))
    elif cmd == "latest":
        if len(sys.argv) < 3:
            sys.stderr.write("usage: afshin.py latest <kind>\n"); sys.exit(2)
        r = latest_approved(sys.argv[2])
        print(json.dumps(r, indent=2, default=str) if r else "null")
    elif cmd == "mark-used":
        if len(sys.argv) < 4:
            sys.stderr.write("usage: afshin.py mark-used <id> <agent>\n"); sys.exit(2)
        print(mark_used(sys.argv[2], sys.argv[3]))
    else:
        sys.stderr.write(f"Unknown: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
