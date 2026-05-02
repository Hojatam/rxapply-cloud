"""
Bineh helper — fetch a lead's event history + persist an engagement score.

Usage
-----
  python bineh.py fetch <email-or-uuid>
      Returns {lead, events:[...]} as JSON.

  python bineh.py save --lead-id <uuid> --score 0.74
      UPDATE leads SET engagement_score = ... and prints the resulting row.
"""
import argparse, json, os, re, subprocess, sys

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _psql(sql: str, *, tA: bool = False, stdin: str = None) -> str:
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA:
        args += ["-tA"]
    if stdin is None:
        args += ["-c", sql]
        r = subprocess.run(args, capture_output=True, text=True)
    else:
        r = subprocess.run(args, input=stdin, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{r.stderr}\n"); sys.exit(r.returncode)
    return r.stdout


def cmd_fetch(key: str):
    where = f"id = '{key}'" if _UUID.match(key) else f"email = '{key.replace(chr(39), chr(39)*2)}'"
    # Two queries to keep uuid/text comparisons clean, then merge in Python.
    lead_sql = (
        "SELECT row_to_json(l) FROM (SELECT id::text, email, language, origin_country, "
        "       destination_intent, experience_years, source, engagement_score, "
        "       created_at::text "
        f"      FROM leads WHERE {where}) l;"
    )
    lead_out = _psql(lead_sql, tA=True).strip()
    if not lead_out:
        sys.stderr.write(f"No lead found matching: {key}\n"); sys.exit(1)
    lead = json.loads(lead_out)

    events_sql = (
        "SELECT COALESCE(json_agg(row_to_json(e) ORDER BY e.created_at DESC), '[]'::json) FROM ("
        " SELECT id::text, kind, platform, language, payload, created_at::text "
        f" FROM engagement_events WHERE lead_id = '{lead['id']}'::uuid"
        ") e;"
    )
    events_out = _psql(events_sql, tA=True).strip() or "[]"
    events = json.loads(events_out)

    print(json.dumps({"lead": lead, "events": events}, indent=2, ensure_ascii=False, default=str))


def cmd_save(lead_id: str, score: float):
    if not (0.0 <= score <= 1.0):
        sys.stderr.write(f"ERROR: score must be in [0,1], got {score}\n"); sys.exit(2)
    rounded = round(score, 2)
    sql = (
        f"UPDATE leads SET engagement_score = {rounded} "
        f"WHERE id = '{lead_id}'::uuid "
        "RETURNING id::text || '|' || email || '|' || engagement_score AS row;"
    )
    out = _psql(sql, tA=True).strip()
    if not out:
        sys.stderr.write(f"No lead with id {lead_id}\n"); sys.exit(1)
    print(out)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "fetch":
        if len(sys.argv) < 3:
            sys.stderr.write("Usage: bineh.py fetch <email-or-uuid>\n"); sys.exit(2)
        cmd_fetch(sys.argv[2])
    elif cmd == "save":
        ap = argparse.ArgumentParser(prog="bineh.py save")
        ap.add_argument("--lead-id", required=True)
        ap.add_argument("--score", required=True, type=float)
        args = ap.parse_args(sys.argv[2:])
        cmd_save(args.lead_id, args.score)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
