# Fixtures

Synthetic seed data for the test phase. **Not** real user data — every email, name, and lead_id is fabricated.

## Files

| File                      | Loads into          | Rows | Purpose                                     |
| ------------------------- | ------------------- | ---: | ------------------------------------------- |
| intel-snapshots-week.csv  | intel_snapshots     |    4 | Roya/Shahed/Dadbeh/Nasim sample outputs     |
| leads-3-personas.csv      | leads               |    3 | Iranian-FA, Egyptian-AR, British-EN         |
| ig-dms-sample.csv         | engagement_events   |    5 | Mehrban DM-reply input                      |
| agent-runs-24h.csv        | agent_runs          |   29 | Bidar audit input — 24h of agent calls      |
| funnel-14d.csv            | (no table — for Zirak) | 14 | 14-day funnel data fed straight to Zirak's prompt |

## Loading into Postgres (after `supabase start`)

The `lead_id` columns in ig-dms-sample.csv reference fabricated UUIDs that don't exist in `leads` yet. The cleanest order is:

```powershell
$DB = "postgresql://postgres:postgres@localhost:54322/postgres"

# 1. Load leads first (parents)
psql $DB -c "\COPY leads (email,language,origin_country,destination_intent,experience_years,source) FROM 'fixtures/leads-3-personas.csv' WITH (FORMAT csv, HEADER)"

# 2. Map the fabricated lead_ids in the DMs to the real UUIDs
#    (one-time: rewrite ig-dms-sample.csv lead_id column with the lead_id values
#     SELECT id, email FROM leads;  produced after step 1)
#    Or seed engagement_events by lead email lookup, e.g.:
psql $DB <<'SQL'
INSERT INTO engagement_events (lead_id, platform, kind, language, payload)
SELECT l.id, 'instagram', 'dm', 'fa',
       '{"text":"salam, tarikh emtahan AFK chand mahe digar mishe?","sender_handle":"@saeed_dent"}'::jsonb
FROM leads l WHERE l.email = 'saeed.tehrani@example.com';
SQL

# 3. The intel + agent_runs files don't need lead_id, load them directly:
psql $DB -c "\COPY intel_snapshots (agent,kind,payload) FROM 'fixtures/intel-snapshots-week.csv' WITH (FORMAT csv, HEADER)"
psql $DB -c "\COPY agent_runs (agent,input_tokens,output_tokens,cost_usd,duration_ms,status) FROM 'fixtures/agent-runs-24h.csv' WITH (FORMAT csv, HEADER)"

# 4. funnel-14d.csv is consumed by Zirak's prompt directly — no DB seed needed.
```

## What's NOT here yet

The plan's `02-fixtures.html` mentions 6 fixtures total. The 6th would typically be a competitor-pages snapshot for Shahed; treating that as TODO until we have real comparison HTML.
