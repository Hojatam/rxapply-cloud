"""
Rahnama helper — list leads + synthesize a quiz-answer JSON for one of them.

Usage
-----
  python rahnama.py list
      Lists all leads (id, email, language, origin_country, destination_intent,
      experience_years).

  python rahnama.py persona <email-or-uuid>
      Returns a single synthesized quiz JSON for the named lead. Fields the
      lead row provides (origin, years_exp, target_languages) are read directly;
      family_status, budget, and priorities are synthesized from per-origin
      defaults (see PERSONA_DEFAULTS below).

No pip dependencies — uses subprocess + docker exec to reach Postgres.
"""
import json
import os
import re
import subprocess
import sys

CONTAINER = os.environ.get("SUPABASE_DB_CONTAINER", "supabase_db_rxapply-test")

# Sensible defaults so the test-phase personas have plausible quiz answers.
# In production these come from the actual quiz form; here we synthesize.
PERSONA_DEFAULTS = {
    "IR": {  # Iranian-trained dentist
        "family_status": "married_with_kids",
        "budget": "med",
        "priorities": ["speed", "income", "family"],
    },
    "EG": {  # Egyptian
        "family_status": "married_no_kids",
        "budget": "low",
        "priorities": ["income", "speed", "family"],
    },
    "GB": {  # British
        "family_status": "single",
        "budget": "high",
        "priorities": ["lifestyle", "prestige", "income"],
    },
    "IN": {
        "family_status": "single",
        "budget": "low",
        "priorities": ["income", "speed", "lifestyle"],
    },
}
NEUTRAL_DEFAULTS = {
    "family_status": "single",
    "budget": "med",
    "priorities": ["income", "speed", "lifestyle"],
}


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
        "SELECT id::text, email, language, origin_country, destination_intent, "
        "       experience_years, source "
        "FROM leads ORDER BY created_at DESC;"
    )
    print(_psql(sql))


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                   re.IGNORECASE)


def cmd_persona(key: str):
    if _UUID.match(key):
        where = f"id = '{key}'"
    else:
        # email lookup; escape single quotes
        where = f"email = '{key.replace(chr(39), chr(39)*2)}'"
    sql = (
        "SELECT row_to_json(l) FROM ("
        " SELECT id::text, email, language, origin_country, "
        "        destination_intent, experience_years, source "
        f" FROM leads WHERE {where}"
        ") l;"
    )
    out = _psql(sql, tA=True).strip()
    if not out:
        sys.stderr.write(f"No lead found matching: {key}\n")
        sys.exit(1)
    lead = json.loads(out)

    defaults = PERSONA_DEFAULTS.get(lead.get("origin_country") or "", NEUTRAL_DEFAULTS)

    # target_languages = native + 'en' (most RxApply-supported destinations need EN)
    native = lead.get("language") or "en"
    target_langs = [native]
    if native != "en":
        target_langs.append("en")

    quiz = {
        "lead_id": lead["id"],
        "email": lead["email"],
        "origin": lead.get("origin_country"),
        "years_exp": lead.get("experience_years"),
        "target_languages": target_langs,
        "destination_intent_from_form": lead.get("destination_intent") or [],
        "family_status": defaults["family_status"],
        "budget": defaults["budget"],
        "priorities": defaults["priorities"],
        "_synthesized_fields": ["family_status", "budget", "priorities"],
    }
    print(json.dumps(quiz, indent=2, ensure_ascii=False))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "list":
        cmd_list()
    elif cmd == "persona":
        if len(sys.argv) < 3:
            sys.stderr.write("Usage: rahnama.py persona <email-or-uuid>\n"); sys.exit(2)
        cmd_persona(sys.argv[2])
    elif cmd in ("help", "--help", "-h"):
        print(__doc__)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\n"); sys.exit(2)


if __name__ == "__main__":
    main()
