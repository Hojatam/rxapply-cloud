"""
Goyesh helper — list/fetch EN masters + save FA/AR re-weighted translations.

Usage
-----
  python goyesh.py list-masters
      Lists all EN masters with id, title, brief_id, word_count, created_at.

  python goyesh.py fetch <asset_id>
      Returns one master row as JSON (including body_md).

  python goyesh.py save --master-id <en_asset_id> --language fa|ar [--kind master] < translated.md
      Reads Markdown from stdin, INSERTs a new content_assets row tied to the
      same brief_id as the EN master, with the given language. Computes
      body_json {word_count, citation_count, h2_count, has_target_script}.

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

ARABIC_FARSI_RE = re.compile(r"[؀-ۿ]")  # covers Arabic + Persian


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


def cmd_list_masters():
    sql = (
        "SELECT a.id::text, a.brief_id::text, a.language, a.kind, "
        "       a.body_json->>'word_count' AS words, a.status, "
        "       LEFT(b.title, 80) AS brief_title "
        "FROM content_assets a "
        "LEFT JOIN content_briefs b ON b.id = a.brief_id "
        "WHERE a.kind='master' AND a.language='en' "
        "ORDER BY a.created_at DESC;"
    )
    print(_psql(sql))


def cmd_fetch(asset_id: str):
    sql = (
        "SELECT row_to_json(a) FROM ("
        " SELECT id::text, brief_id::text, language, kind, status, "
        "        body_md, body_json, created_at::text "
        f" FROM content_assets WHERE id = '{asset_id.replace(chr(39), chr(39)*2)}'"
        ") a;"
    )
    out = _psql(sql, tA=True).strip()
    if not out:
        sys.stderr.write(f"No content_asset found with id={asset_id}\n"); sys.exit(1)
    print(out)


def _stats(md_text: str) -> dict:
    word_count = len(re.findall(r"\S+", md_text))
    citation_count = len(re.findall(r"\[\^[A-Za-z0-9_-]+\]", md_text))
    h2_count = sum(1 for line in md_text.splitlines()
                   if re.match(r"^##\s+\S", line) and not line.startswith("###"))
    has_target_script = bool(ARABIC_FARSI_RE.search(md_text))
    return {
        "word_count": word_count,
        "citation_count": citation_count,
        "h2_count": h2_count,
        "has_target_script": has_target_script,
    }


def cmd_save(master_id: str, language: str, kind: str, md_text: str):
    if not md_text.strip():
        sys.stderr.write("ERROR: stdin empty\n"); sys.exit(2)
    if language not in ("fa", "ar"):
        sys.stderr.write(f"ERROR: language must be 'fa' or 'ar', got: {language}\n"); sys.exit(2)

    # Look up the brief_id from the EN master
    sql = f"SELECT brief_id::text FROM content_assets WHERE id = '{master_id}';"
    brief_id = _psql(sql, tA=True).strip()
    if not brief_id:
        sys.stderr.write(f"No content_asset (EN master) with id={master_id}\n"); sys.exit(1)

    stats = _stats(md_text)
    if language == "fa" or language == "ar":
        if not stats["has_target_script"]:
            sys.stderr.write(
                f"WARNING: language={language} requested but no Arabic/Farsi unicode "
                "characters found in input. Aborting to prevent a bad row.\n"
            )
            sys.exit(2)

    # Ship article + stats into the container and INSERT.
    fd_md, host_md = tempfile.mkstemp(suffix=".md", prefix="goyesh_article_")
    os.close(fd_md)
    fd_js, host_js = tempfile.mkstemp(suffix=".json", prefix="goyesh_stats_")
    os.close(fd_js)
    try:
        with open(host_md, "w", encoding="utf-8") as f: f.write(md_text)
        with open(host_js, "w", encoding="utf-8") as f: json.dump(stats, f)

        for src, dst in [(host_md, "/tmp/goyesh_article.md"),
                         (host_js, "/tmp/goyesh_stats.json")]:
            cp = subprocess.run(["docker", "cp", src, f"{CONTAINER}:{dst}"],
                                capture_output=True, text=True)
            if cp.returncode != 0:
                sys.stderr.write(f"docker cp failed: {cp.stderr}\n"); sys.exit(cp.returncode)

        script = (
            r"\set body_md `cat /tmp/goyesh_article.md`" + "\n"
            r"\set body_json `cat /tmp/goyesh_stats.json`" + "\n"
            "INSERT INTO content_assets "
            "(brief_id, language, kind, body_md, body_json, status) "
            f"VALUES ('{brief_id}'::uuid, '{language}', '{kind}', "
            ":'body_md', :'body_json'::jsonb, 'pending_g2') "
            "RETURNING id::text || '|' || language || '|' || kind AS row;\n"
        )
        r = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True
        )
        if r.returncode != 0:
            sys.stderr.write(f"INSERT failed:\n{r.stderr}\n"); sys.exit(r.returncode)

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
    if cmd in ("list-masters", "list"):
        cmd_list_masters()
    elif cmd == "fetch":
        if len(sys.argv) < 3:
            sys.stderr.write("Usage: goyesh.py fetch <asset_id>\n"); sys.exit(2)
        cmd_fetch(sys.argv[2])
    elif cmd == "save":
        ap = argparse.ArgumentParser(prog="goyesh.py save")
        ap.add_argument("--master-id", required=True)
        ap.add_argument("--language", required=True, choices=["fa", "ar"])
        ap.add_argument("--kind", default="master")
        ap.add_argument("--file", default=None,
                        help="Path to markdown file (preferred over stdin on Windows for non-ASCII)")
        args = ap.parse_args(sys.argv[2:])
        if args.file:
            with open(args.file, "r", encoding="utf-8") as f:
                md = f.read()
        else:
            # Force UTF-8 decoding of stdin (Windows pipes mangle non-ASCII via cp1252)
            md = sys.stdin.buffer.read().decode("utf-8")
        cmd_save(args.master_id, args.language, args.kind, md)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
