"""
Mehrban helper — fetch a DM/comment + sender context, save a reply.

Usage
-----
  python mehrban.py fetch <event-id-or-sender-email>
      Returns {event, lead, faq_hits} as JSON.

  python mehrban.py save --reply-to-event-id <id> --language fa|ar|en \
                         --file reply.md  [--platform instagram]
      INSERTs a new engagement_events row with kind='reply'.

No pip dependencies — uses subprocess + docker exec to reach Postgres.
"""
import argparse, json, os, re, subprocess, sys, tempfile

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
ARABIC_FARSI_RE = re.compile(r"[؀-ۿ]")

DISCLAIMER_TEXTS = {
    "en": "RxApply provides education and guidance, not regulated immigration advice",
    "fa": "RxApply آموزش و راهنمایی ارائه می‌دهد، نه مشاوره‌ی مهاجرتی قانونی",
    "ar": "RxApply يقدم تعليماً وتوجيهاً، لا استشارة هجرة قانونية",
}

# Tiny FAQ map for the test phase. In production this comes from embedding search.
FAQ_LIBRARY = [
    {"id": "faq-001", "topic": "AFK monthly cohorts",
     "languages": ["en", "fa", "ar"],
     "snippet": "NDEB Canada moved AFK to monthly cohorts on 22 Apr 2026; previously three fixed cohorts per year."},
    {"id": "faq-002", "topic": "Iranian credential conversion",
     "languages": ["fa"],
     "snippet": "Iranian DDS holders typically need NDEB AFK + OSCE + bridging or qualifying program; ECE/WES evaluation also required by some provinces."},
    {"id": "faq-003", "topic": "DHA fee reduction (UAE)",
     "languages": ["ar", "en"],
     "snippet": "Hayat Sahha (DHA) reduced licensure-evaluation fees in early 2026; Egyptian-trained dentists with EN documentation can complete licensure within 6-9 months."},
    {"id": "faq-004", "topic": "RxApply disclaimer",
     "languages": ["en", "fa", "ar"],
     "snippet": "Educational guidance only; visa-side decisions require a licensed RCIC/OISC/MARA agent."},
]


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
    if _UUID.match(key):
        # event id
        sql = (
            "SELECT row_to_json(e) FROM ("
            " SELECT id::text, lead_id::text, kind, platform, language, payload, created_at::text "
            f" FROM engagement_events WHERE id = '{key}'"
            ") e;"
        )
    else:
        # sender email — pick the most recent inbound DM/comment from this lead
        e = key.replace("'", "''")
        sql = (
            "SELECT row_to_json(e) FROM ("
            " SELECT ev.id::text, ev.lead_id::text, ev.kind, ev.platform, ev.language, "
            "        ev.payload, ev.created_at::text "
            " FROM engagement_events ev JOIN leads l ON l.id = ev.lead_id "
            f" WHERE l.email = '{e}' AND ev.kind IN ('dm','comment') "
            " ORDER BY ev.created_at DESC LIMIT 1"
            ") e;"
        )
    out = _psql(sql, tA=True).strip()
    if not out:
        sys.stderr.write(f"No DM/comment found for: {key}\n"); sys.exit(1)
    event = json.loads(out)

    # Lead context
    lead_sql = (
        "SELECT row_to_json(l) FROM ("
        " SELECT id::text, email, language, origin_country, destination_intent, "
        "        experience_years, source, engagement_score "
        f" FROM leads WHERE id = '{event['lead_id']}'::uuid"
        ") l;"
    )
    lead = json.loads(_psql(lead_sql, tA=True).strip())

    # FAQ hits — naive: pick faq entries that match the language and the topic word
    text = (event.get("payload") or {}).get("text", "").lower()
    lang = event.get("language") or lead.get("language") or "en"
    hits = []
    for f in FAQ_LIBRARY:
        if lang not in f["languages"]:
            continue
        # simple keyword match
        keywords = f["topic"].lower().split()
        if any(k in text for k in keywords) or any(t.lower() in f["topic"].lower() for t in text.split() if len(t) > 2):
            hits.append(f)
    # always include the disclaimer faq
    if not any(h["id"] == "faq-004" for h in hits):
        hits.append(next(f for f in FAQ_LIBRARY if f["id"] == "faq-004"))
    # cap at 3
    hits = hits[:3]

    print(json.dumps({"event": event, "lead": lead, "faq_hits": hits},
                     indent=2, ensure_ascii=False, default=str))


def cmd_save(reply_to_event_id: str, language: str, kind: str, platform_override, md_text: str):
    if not md_text.strip():
        sys.stderr.write("ERROR: empty reply\n"); sys.exit(2)

    # Load the original event to get lead_id + platform
    src_sql = (
        "SELECT row_to_json(e) FROM ("
        " SELECT id::text, lead_id::text, platform "
        f" FROM engagement_events WHERE id = '{reply_to_event_id}'"
        ") e;"
    )
    src_out = _psql(src_sql, tA=True).strip()
    if not src_out:
        sys.stderr.write(f"No source event with id {reply_to_event_id}\n"); sys.exit(1)
    src = json.loads(src_out)
    platform = platform_override or src["platform"]

    # Stats / checks
    has_target_script = bool(ARABIC_FARSI_RE.search(md_text)) if language in ("fa", "ar") else None
    disclaimer_phrase = DISCLAIMER_TEXTS.get(language, "")
    has_disclaimer = disclaimer_phrase and (disclaimer_phrase in md_text)

    payload = {
        "text": md_text,
        "in_reply_to": reply_to_event_id,
        "char_count": len(md_text),
        "word_count": len(re.findall(r"\S+", md_text)),
        "has_disclaimer": bool(has_disclaimer),
        "has_target_script": bool(has_target_script) if has_target_script is not None else None,
    }

    # docker cp the payload as a single JSON file, then INSERT via psql \set
    fd_js, host_js = tempfile.mkstemp(suffix=".json", prefix="mehrban_")
    os.close(fd_js)
    try:
        with open(host_js, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        cp = subprocess.run(["docker", "cp", host_js, f"{CONTAINER}:/tmp/mehrban_payload.json"],
                            capture_output=True, text=True)
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed: {cp.stderr}\n"); sys.exit(cp.returncode)

        script = (
            r"\set payload_json `cat /tmp/mehrban_payload.json`" + "\n"
            "INSERT INTO engagement_events (lead_id, platform, kind, language, payload) "
            f"VALUES ('{src['lead_id']}'::uuid, '{platform}', '{kind}', '{language}', "
            ":'payload_json'::jsonb) "
            "RETURNING id::text || '|' || kind || '|' || language AS row;\n"
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
        print(f"checks: {{has_target_script: {has_target_script}, has_disclaimer: {bool(has_disclaimer)}, words: {payload['word_count']}}}")
    finally:
        try: os.unlink(host_js)
        except OSError: pass


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "fetch":
        if len(sys.argv) < 3:
            sys.stderr.write("Usage: mehrban.py fetch <event-id-or-sender-email>\n"); sys.exit(2)
        cmd_fetch(sys.argv[2])
    elif cmd == "save":
        ap = argparse.ArgumentParser(prog="mehrban.py save")
        ap.add_argument("--reply-to-event-id", required=True)
        ap.add_argument("--language", required=True)
        ap.add_argument("--kind", default="reply")
        ap.add_argument("--platform", default=None,
                        help="Override the source event's platform (rare).")
        ap.add_argument("--file", required=True,
                        help="Path to the reply markdown (UTF-8).")
        args = ap.parse_args(sys.argv[2:])
        with open(args.file, "r", encoding="utf-8") as f:
            md = f.read()
        cmd_save(args.reply_to_event_id, args.language, args.kind, args.platform, md)
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
