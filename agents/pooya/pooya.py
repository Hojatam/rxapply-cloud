"""
Pooya helper — fetch intel + insert briefs via the local Supabase Postgres.

Usage
-----
  python pooya.py fetch
      Prints a JSON array of last-7-day intel snapshots to stdout.

  python pooya.py insert < briefs.json
  echo '<json-array>' | python pooya.py insert
      Reads a JSON array of brief objects from stdin and INSERTs them
      into content_briefs with source='pooya', status='pending_g1'.
      Prints "<id>|<title>" per row.

No pip dependencies — uses subprocess + docker exec to reach Postgres.
"""
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
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{r.stderr}\n")
        sys.exit(r.returncode)
    return r.stdout


def fetch_intel() -> list:
    """Return last-7-day intel_snapshots as a list of dicts."""
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(s) ORDER BY created_at DESC), '[]'::json) "
        "FROM (SELECT id::text, agent, kind, payload, created_at::text "
        "      FROM intel_snapshots "
        "      WHERE created_at >= NOW() - INTERVAL '7 days') s;"
    )
    out = _run_psql(sql, tA=True).strip()
    return json.loads(out) if out else []


def _validate_briefs(briefs):
    if not isinstance(briefs, list):
        sys.stderr.write("ERROR: expected a JSON array of brief objects.\n")
        sys.exit(2)
    if len(briefs) == 0:
        sys.stderr.write("ERROR: empty briefs array — nothing to insert.\n")
        sys.exit(2)
    required = {"title", "language_priorities", "target_destinations",
                "suggested_angle", "predicted_seo_yield", "source_citations"}
    for i, b in enumerate(briefs):
        missing = required - set(b.keys())
        if missing:
            sys.stderr.write(f"ERROR: brief #{i} is missing keys: {sorted(missing)}\n")
            sys.exit(2)
        if not isinstance(b.get("language_priorities"), list):
            sys.stderr.write(f"ERROR: brief #{i}: language_priorities must be an array\n")
            sys.exit(2)
        if not isinstance(b.get("target_destinations"), list):
            sys.stderr.write(f"ERROR: brief #{i}: target_destinations must be an array\n")
            sys.exit(2)


def insert_briefs(briefs):
    """Insert each brief as one row in content_briefs. Print id|title per row."""
    _validate_briefs(briefs)

    # 1. Write briefs to a temp JSON file on host.
    fd, host_tmp = tempfile.mkstemp(suffix=".json", prefix="pooya_briefs_")
    os.close(fd)
    try:
        with open(host_tmp, "w", encoding="utf-8") as f:
            json.dump(briefs, f)

        # 2. Copy into the Postgres container.
        cp = subprocess.run(
            ["docker", "cp", host_tmp, f"{CONTAINER}:/tmp/pooya_briefs.json"],
            capture_output=True, text=True
        )
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed: {cp.stderr}\n")
            sys.exit(cp.returncode)

        # 3. INSERT using psql's `\set ... \`cat ...\`` to slurp the file as a variable,
        #    then unnest the JSONB array with jsonb_array_elements.
        script = r"""
\set briefs_json `cat /tmp/pooya_briefs.json`
INSERT INTO content_briefs
  (title, language_priorities, target_destinations, source, status, brief_json)
SELECT
  b->>'title',
  ARRAY(SELECT jsonb_array_elements_text(b->'language_priorities')),
  ARRAY(SELECT jsonb_array_elements_text(b->'target_destinations')),
  'pooya',
  'pending_g1',
  b
FROM jsonb_array_elements(:'briefs_json'::jsonb) AS b
RETURNING id::text || '|' || title AS row;
"""
        r = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres",
             "-tA", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True
        )
        if r.returncode != 0:
            sys.stderr.write(f"INSERT failed (exit {r.returncode}):\n{r.stderr}\n")
            sys.exit(r.returncode)
        # psql -tA prints id|title rows + sometimes a blank line.
        for line in r.stdout.strip().splitlines():
            if line.strip():
                print(line)
    finally:
        try:
            os.unlink(host_tmp)
        except OSError:
            pass


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "fetch":
        intel = fetch_intel()
        print(json.dumps(intel, indent=2, default=str))
    elif cmd == "insert":
        try:
            briefs = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"ERROR: stdin is not valid JSON — {e}\n")
            sys.exit(2)
        insert_briefs(briefs)
    elif cmd == "help" or cmd == "--help":
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n")
        sys.stderr.write("Try: python pooya.py fetch  |  python pooya.py insert < briefs.json\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
