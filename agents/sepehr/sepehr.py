"""
Sepehr helper — fetch a content brief + save the EN master article to content_assets.

Usage
-----
  python sepehr.py list
      Lists all content_briefs (id, title, status, source) most-recent first.

  python sepehr.py fetch <brief_id>
      Prints one brief as JSON.

  python sepehr.py save --brief-id <id> [--language en] [--kind master] < article.md
      Reads Markdown from stdin and INSERTs one row into content_assets:
        brief_id   = given UUID
        language   = en (default)
        kind       = master (default)
        body_md    = article text
        body_json  = {word_count, citation_count, h2_count}
        status     = pending_g2

No pip dependencies — uses subprocess + docker exec to reach Postgres.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")


def _psql(sql: str, *, tA: bool = False) -> str:
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA:
        args += ["-tA"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{r.stderr}\n")
        sys.exit(r.returncode)
    return r.stdout


def cmd_list():
    sql = (
        "SELECT id::text, title, status, source, created_at::text "
        "FROM content_briefs ORDER BY created_at DESC LIMIT 50;"
    )
    print(_psql(sql))


def cmd_fetch(brief_id: str):
    sql = (
        "SELECT row_to_json(b) FROM ("
        " SELECT id::text, title, language_priorities, target_destinations, "
        "        source, status, brief_json, created_at::text "
        " FROM content_briefs WHERE id = '" + brief_id.replace("'", "''") + "'"
        ") b;"
    )
    out = _psql(sql, tA=True).strip()
    if not out:
        sys.stderr.write(f"No brief found with id={brief_id}\n")
        sys.exit(1)
    parsed = json.loads(out)
    print(json.dumps(parsed, indent=2, ensure_ascii=False))


def _stats(md_text: str) -> dict:
    # Words: simple whitespace-split. Good enough for length sanity checks.
    word_count = len(re.findall(r"\S+", md_text))
    # Citation markers: [^N] where N is digits or letters
    citation_count = len(re.findall(r"\[\^[A-Za-z0-9_-]+\]", md_text))
    # H2 sections (lines starting with '## ' but not '### ' or higher)
    h2_count = sum(1 for line in md_text.splitlines() if re.match(r"^##\s+\S", line) and not line.startswith("###"))
    return {"word_count": word_count, "citation_count": citation_count, "h2_count": h2_count}


def cmd_save(brief_id: str, language: str, kind: str, md_text: str):
    if not md_text.strip():
        sys.stderr.write("ERROR: stdin was empty — nothing to save.\n")
        sys.exit(2)
    stats = _stats(md_text)

    # Ship the article + the body_json stats into the container as two files,
    # then INSERT using psql `\set` slurps so we can pass arbitrary text safely.
    fd_md, host_md = tempfile.mkstemp(suffix=".md", prefix="sepehr_article_")
    os.close(fd_md)
    fd_js, host_js = tempfile.mkstemp(suffix=".json", prefix="sepehr_stats_")
    os.close(fd_js)
    try:
        with open(host_md, "w", encoding="utf-8") as f:
            f.write(md_text)
        with open(host_js, "w", encoding="utf-8") as f:
            json.dump(stats, f)

        for src, dst in [(host_md, "/tmp/sepehr_article.md"),
                         (host_js, "/tmp/sepehr_stats.json")]:
            cp = subprocess.run(["docker", "cp", src, f"{CONTAINER}:{dst}"],
                                capture_output=True, text=True)
            if cp.returncode != 0:
                sys.stderr.write(f"docker cp failed: {cp.stderr}\n")
                sys.exit(cp.returncode)

        script = (
            r"\set body_md `cat /tmp/sepehr_article.md`" + "\n"
            r"\set body_json `cat /tmp/sepehr_stats.json`" + "\n"
            "INSERT INTO content_assets "
            "(brief_id, language, kind, body_md, body_json, status) "
            "VALUES ('" + brief_id.replace("'", "''") + "'::uuid, "
            "'" + language + "', "
            "'" + kind + "', "
            ":'body_md', "
            ":'body_json'::jsonb, "
            "'pending_g2') "
            "RETURNING id::text || '|' || kind || '|' || language AS row;\n"
        )
        r = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True
        )
        if r.returncode != 0:
            sys.stderr.write(f"INSERT failed:\n{r.stderr}\n")
            sys.exit(r.returncode)

        for line in r.stdout.strip().splitlines():
            if line.strip():
                print(line)
        print(f"stats: {stats}")
    finally:
        for p in (host_md, host_js):
            try: os.unlink(p)
            except OSError: pass


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "list":
        cmd_list()
    elif cmd == "fetch":
        if len(sys.argv) < 3:
            sys.stderr.write("Usage: sepehr.py fetch <brief_id>\n"); sys.exit(2)
        cmd_fetch(sys.argv[2])
    elif cmd == "save":
        ap = argparse.ArgumentParser(prog="sepehr.py save")
        ap.add_argument("--brief-id", required=True)
        ap.add_argument("--language", default="en")
        ap.add_argument("--kind", default="master")
        args = ap.parse_args(sys.argv[2:])
        md = sys.stdin.read()
        cmd_save(args.brief_id, args.language, args.kind, md)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
