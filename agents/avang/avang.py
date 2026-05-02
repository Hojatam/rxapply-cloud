"""
Avang — fan a brief's master articles out to 11 scheduled_posts rows.

Usage
-----
  python avang.py run --brief-id <uuid>
"""
import argparse, json, os, re, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

# (platform, allowed_languages, scheduled_offset_hours_by_lang)
PLATFORM_MATRIX = [
    ("ig",       ("en", "fa", "ar"), {"en":  2, "fa":  4, "ar":  6}),
    ("fb",       ("en", "fa", "ar"), {"en":  3, "fa":  5, "ar":  7}),
    ("telegram", ("en", "fa", "ar"), {"en":  4, "fa":  6, "ar":  8}),
    ("linkedin", ("en",),             {"en":  9}),
    ("youtube",  ("en",),             {"en": 12}),
]

# Per-platform excerpt rules — how to shape body_md for the platform
PLATFORM_LIMITS = {
    "ig":       {"chars_max":  900,  "lead": "📌"},
    "fb":       {"chars_max": 1500,  "lead": ""},
    "telegram": {"chars_max": 2500,  "lead": ""},
    "linkedin": {"chars_max": 1800,  "lead": ""},
    "youtube":  {"chars_max":  500,  "lead": "Description: "},
}


def _psql(sql: str, *, tA: bool = False, stdin: str = None) -> str:
    """Run psql via docker exec. Forces UTF-8 on Windows cp1252 stdin/stdout."""
    args = ["docker", "exec", "-i", CONTAINER, "psql",
            "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
    if tA:
        args += ["-tA"]
    if stdin is None:
        args += ["-c", sql]
        r = subprocess.run(args, capture_output=True)  # bytes
    else:
        r = subprocess.run(args, input=stdin.encode("utf-8"), capture_output=True)
    stdout = r.stdout.decode("utf-8", errors="replace")
    stderr = r.stderr.decode("utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(f"psql failed (exit {r.returncode}):\n{stderr}\n"); sys.exit(r.returncode)
    return stdout


def excerpt_for_platform(body_md: str, platform: str) -> str:
    """Deterministic platform-shaped excerpt from body_md."""
    rules = PLATFORM_LIMITS[platform]
    # Strip H2 headings + leading '#', take the first paragraph after the meta line.
    paras = [p.strip() for p in body_md.split("\n\n") if p.strip()]
    title_line = next((p for p in paras if p.startswith("# ")), "").lstrip("# ").strip()
    body_paras = [p for p in paras if not p.startswith("#") and not p.startswith("[^")]
    body_text = " ".join(body_paras[:3])  # first 3 non-heading paragraphs
    body_text = re.sub(r"\[\^[^\]]+\]", "", body_text)  # strip citation markers
    body_text = re.sub(r"\s+", " ", body_text).strip()

    limit = rules["chars_max"]
    lead = rules["lead"]
    excerpt = f"{title_line}\n\n{lead}{body_text}"
    if len(excerpt) > limit:
        excerpt = excerpt[:limit - 1].rsplit(" ", 1)[0] + "…"
    return excerpt


def cmd_run(brief_id: str):
    # 1. Pull all kind=master rows for this brief
    sql = (
        "SELECT json_agg(row_to_json(a)) FROM ("
        " SELECT id::text, language, body_md "
        f" FROM content_assets WHERE brief_id = '{brief_id}'::uuid "
        " AND kind='master'"
        ") a;"
    )
    out = _psql(sql, tA=True).strip()
    if not out or out == "":
        sys.stderr.write(f"No master assets for brief {brief_id}\n"); sys.exit(1)
    masters = json.loads(out) or []
    by_lang = {m["language"]: m for m in masters}
    if not by_lang:
        sys.stderr.write("No masters found\n"); sys.exit(1)
    print(f"Found masters: {sorted(by_lang)}")

    # 2. Build the row list per the platform matrix
    rows = []
    base = datetime.now(timezone.utc).replace(microsecond=0)
    for platform, langs, offsets in PLATFORM_MATRIX:
        for lang in langs:
            if lang not in by_lang:
                continue
            master = by_lang[lang]
            text = excerpt_for_platform(master["body_md"], platform)
            scheduled_at = (base + timedelta(hours=offsets[lang])).isoformat()
            rows.append({
                "asset_id": master["id"],
                "platform": platform,
                "account_key": f"{platform}_{lang}",
                "language": lang,
                "text": text,
                "scheduled_at": scheduled_at,
            })

    print(f"Will insert {len(rows)} rows.")

    # 3. Ship as JSON, INSERT via psql \set
    fd, host_tmp = tempfile.mkstemp(suffix=".json", prefix="avang_")
    os.close(fd)
    try:
        with open(host_tmp, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        cp = subprocess.run(["docker", "cp", host_tmp, f"{CONTAINER}:/tmp/avang_rows.json"],
                            capture_output=True, text=True)
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed: {cp.stderr}\n"); sys.exit(cp.returncode)

        script = (
            r"\set rows_json `cat /tmp/avang_rows.json`" + "\n"
            "INSERT INTO scheduled_posts "
            "(asset_id, platform, account_key, language, text, scheduled_at, status) "
            "SELECT "
            "  (r->>'asset_id')::uuid, r->>'platform', r->>'account_key', "
            "  r->>'language', r->>'text', "
            "  (r->>'scheduled_at')::timestamptz, 'pending' "
            "FROM jsonb_array_elements(:'rows_json'::jsonb) AS r "
            "RETURNING id::text || '|' || platform || '|' || account_key AS row;\n"
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
        print(f"\nInserted {len(rows)} rows for brief {brief_id}.")
    finally:
        try: os.unlink(host_tmp)
        except OSError: pass


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "run":
        ap = argparse.ArgumentParser(prog="avang.py run")
        ap.add_argument("--brief-id", required=True)
        args = ap.parse_args(sys.argv[2:])
        cmd_run(args.brief_id)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
