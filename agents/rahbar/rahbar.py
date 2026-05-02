"""
Rahbar — enroll leads into 5-email nurture sequences.

Usage
-----
  python rahbar.py leads
      List the 3 fixture leads with the sequence_id each would map to.

  python rahbar.py enroll --lead <email-or-uuid>
      Insert 5 nurture_schedule rows for the given lead.

  python rahbar.py enroll-all
      Enroll all 3 fixture leads (the T7 path).
"""
import argparse, json, os, re, subprocess, sys, tempfile
# Force UTF-8 stdout/stderr so non-ASCII (≥, →, Farsi, Arabic, em-dashes) doesn't
# crash on Windows cp1252. Safe on every platform; no-op if already UTF-8.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
from datetime import datetime, timedelta, timezone

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


def pick_sequence(lang: str, intent_list):
    """Map (language, top destination) → sequence_id."""
    intent = (intent_list or [None])[0] if intent_list else None
    table = {
        ("fa", "canada"): "fa-canada-v1",
        ("fa", "germany"): "fa-germany-v1",
        ("ar", "uae"): "ar-uae-v1",
        ("ar", "saudi"): "ar-saudi-v1",
        ("en", "canada"): "en-canada-v1",
        ("en", "australia"): "en-australia-v1",
    }
    if (lang, intent) in table:
        return table[(lang, intent)]
    if lang == "fa":
        return "fa-canada-v1"
    if lang == "ar":
        return "ar-uae-v1"
    return "en-intl-v1"


# Email templates per (sequence_id, step). Subject + simple HTML.
def render_email(sequence_id: str, step: int, lead: dict) -> tuple:
    name = (lead.get("email") or "").split("@")[0].title()
    intent_list = lead.get("destination_intent") or []
    destination = (intent_list[0] if intent_list else "your target market").replace("_", " ")
    origin = lead.get("origin_country") or "your country"
    years = lead.get("experience_years") or "your"
    # Sequence + destination → regulator hint (used in subject for step 2)
    REGULATORS = {
        "canada": "the NDEB", "uae": "the DHA", "germany": "the Landeszahnärztekammer",
        "australia": "the Australian Dental Council", "saudi": "the Saudi MOH",
    }
    regulator = REGULATORS.get(destination, "the local regulator")

    subjects = {
        1: f"Welcome — your {destination} pathway in 5 steps",
        2: f"What just changed at {regulator}",
        3: f"5 dentists from {origin} who made the move",
        4: f"Realistic budget: what {destination} actually costs in 2026",
        5: "Want to talk it through? 30 minutes, no pitch",
    }
    bodies = {
        1: (
            f"<p>Hi {name},</p>"
            f"<p>Welcome to RxApply. Based on your advisor results, your strongest fit is "
            f"<b>{destination}</b>, and we've put together a 5-touch follow-up that gets to the "
            f"point. Here's the first piece — the actual sequence of steps for {destination}, "
            f"with realistic timelines for someone with {years}+ years of clinical practice.</p>"
            f"<p><a href='https://rxapply.test/guide/{destination}'>Read the {destination} pathway guide →</a></p>"
            "<p>— RxApply</p>"
        ),
        2: (
            f"<p>Hi {name},</p>"
            f"<p>One thing changed at {regulator} this month worth knowing: "
            f"<b>scheduling cadence shifted</b>. We wrote up what it means specifically for "
            f"{origin}-trained dentists targeting {destination}. The article is short and "
            f"numbered.</p>"
            f"<p><a href='https://rxapply.test/news/{destination}-2026'>Read it (5 min) →</a></p>"
            "<p>— RxApply</p>"
        ),
        3: (
            f"<p>Hi {name},</p>"
            f"<p>3 anonymised cases of dentists from {origin} who completed the {destination} move "
            f"in the last 18 months. What helped, what nearly derailed, what they wish they'd "
            f"known on day one.</p>"
            f"<p><a href='https://rxapply.test/cases/{origin}-to-{destination}'>Read the 3 stories →</a></p>"
            "<p>— RxApply</p>"
        ),
        4: (
            f"<p>Hi {name},</p>"
            f"<p>The number that surprises every {origin}-trained candidate planning a {destination} "
            f"move: <b>total realistic cost</b>, line by line, including the things consultants "
            f"don't put on the front-page price card.</p>"
            f"<p><a href='https://rxapply.test/budget/{destination}'>See the cost table →</a></p>"
            "<p>— RxApply</p>"
        ),
        5: (
            f"<p>Hi {name},</p>"
            f"<p>If it'd help to talk through your specific situation — your timeline, your "
            f"family, your priorities — we offer a free 30-minute conversation. No pitch. We "
            f"either think we can help and we'll tell you how, or we don't and we'll tell you "
            f"that too.</p>"
            f"<p><a href='https://rxapply.test/book/consult'>Book a slot →</a></p>"
            "<p>— RxApply</p>"
        ),
    }
    return subjects[step], bodies[step]


def cmd_leads():
    sql = (
        "SELECT id::text, email, language, origin_country, "
        "       destination_intent, experience_years "
        "FROM leads ORDER BY created_at;"
    )
    print(_psql(sql))
    print("\nSequence picks:")
    sql_json = (
        "SELECT json_agg(row_to_json(l)) FROM ("
        " SELECT id::text, email, language, origin_country, "
        "        destination_intent, experience_years "
        " FROM leads ORDER BY created_at"
        ") l;"
    )
    out = _psql(sql_json, tA=True).strip()
    leads = json.loads(out) if out else []
    for lead in leads:
        seq = pick_sequence(lead.get("language") or "en", lead.get("destination_intent") or [])
        print(f"  {lead['email']}: → {seq}")


def cmd_enroll(key: str):
    if _UUID.match(key):
        where = f"id = '{key}'"
    else:
        where = f"email = '{key.replace(chr(39), chr(39)*2)}'"
    lookup = (
        "SELECT row_to_json(l) FROM ("
        " SELECT id::text, email, language, origin_country, "
        "        destination_intent, experience_years "
        f" FROM leads WHERE {where}"
        ") l;"
    )
    out = _psql(lookup, tA=True).strip()
    if not out:
        sys.stderr.write(f"No lead matching: {key}\n"); sys.exit(1)
    lead = json.loads(out)
    sequence_id = pick_sequence(lead.get("language") or "en", lead.get("destination_intent") or [])

    # Build 5 rows. send_at offsets: 0, 2, 4, 7, 14 days.
    OFFSETS = {1: 0, 2: 2, 3: 4, 4: 7, 5: 14}
    rows = []
    base = datetime.now(timezone.utc).replace(microsecond=0)
    for step in (1, 2, 3, 4, 5):
        subj, html = render_email(sequence_id, step, lead)
        rows.append({
            "step": step,
            "subject": subj,
            "html": html,
            "send_at": (base + timedelta(days=OFFSETS[step])).isoformat(),
        })

    # Build a single JSON file containing the 5 rows, ship into the container, INSERT via psql \set.
    fd, host_tmp = tempfile.mkstemp(suffix=".json", prefix="rahbar_")
    os.close(fd)
    try:
        with open(host_tmp, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        cp = subprocess.run(["docker", "cp", host_tmp, f"{CONTAINER}:/tmp/rahbar_rows.json"],
                            capture_output=True, text=True)
        if cp.returncode != 0:
            sys.stderr.write(f"docker cp failed: {cp.stderr}\n"); sys.exit(cp.returncode)

        script = (
            r"\set rows_json `cat /tmp/rahbar_rows.json`" + "\n"
            "INSERT INTO nurture_schedule "
            "(lead_id, sequence_id, step_number, email_subject, email_html, send_at, status) "
            "SELECT "
            f"  '{lead['id']}'::uuid, '{sequence_id}', "
            "  (r->>'step')::int, "
            "  r->>'subject', "
            "  r->>'html', "
            "  (r->>'send_at')::timestamptz, "
            "  'queued' "
            "FROM jsonb_array_elements(:'rows_json'::jsonb) AS r "
            "ON CONFLICT (lead_id, sequence_id, step_number) DO NOTHING "
            "RETURNING id::text || '|step=' || step_number || '|' || sequence_id AS row;\n"
        )
        r = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "psql",
             "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True
        )
        if r.returncode != 0:
            sys.stderr.write(f"INSERT failed:\n{r.stderr}\n"); sys.exit(r.returncode)
        inserted = [ln for ln in r.stdout.strip().splitlines() if ln.strip()]
        print(f"{lead['email']}: enrolled in {sequence_id}, {len(inserted)} rows inserted")
        for ln in inserted:
            print(f"  {ln}")
        if len(inserted) == 0:
            print("  (UNIQUE constraint hit — already enrolled in this sequence)")
    finally:
        try: os.unlink(host_tmp)
        except OSError: pass


def cmd_enroll_all():
    emails = ["saeed.tehrani@example.com", "amira.hassan@example.com", "james.brown@example.com"]
    for e in emails:
        cmd_enroll(e)
        print()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "leads":
        cmd_leads()
    elif cmd == "enroll":
        ap = argparse.ArgumentParser(prog="rahbar.py enroll")
        ap.add_argument("--lead", required=True)
        args = ap.parse_args(sys.argv[2:])
        cmd_enroll(args.lead)
    elif cmd == "enroll-all":
        cmd_enroll_all()
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
