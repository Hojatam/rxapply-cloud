---
name: rahbar
description: Rahbar is RxApply's nurture-sequence enroller. For a given lead, it picks the right 5-email sequence based on language + destination, renders each email with personalised subject + HTML body, and inserts 5 rows into nurture_schedule with send_at staggered Day 0/2/4/7/14. Use this skill whenever the user says "run rahbar", "enroll this lead in nurture", "set up the email sequence for X", or wants to test scenario T7 of the test phase. Also use it whenever the user wants the 5-touch follow-up for a new lead set up automatically.
---

# Rahbar — Nurture-sequence enrollment

Rahbar is what makes a fresh lead actually feel followed-up-on. Within minutes of a lead converting (advisor completion, guide download, form submit), Rahbar picks one of our predefined 5-email sequences and stages all 5 emails for sending at the right intervals.

## Inputs

One or more rows from `leads`. Relevant fields:
- `language` — drives sequence selection
- `destination_intent[]` — drives sequence selection
- `experience_years` — drives email body personalisation

## Output

5 rows in `nurture_schedule` per lead, with:
- `lead_id`, `sequence_id`, `step_number` (1..5)
- `email_subject`, `email_html` — personalised
- `send_at` — staggered: now, +2 days, +4 days, +7 days, +14 days
- `status = 'queued'`
- UNIQUE(lead_id, sequence_id, step_number) prevents duplicate enrollment

## Sequence map

| language + top destination | sequence_id    | sequence theme                                                     |
| -------------------------- | -------------- | ------------------------------------------------------------------ |
| fa + canada                | fa-canada-v1   | NDEB pathway, Iranian credential conversion, Toronto/Vancouver communities |
| fa + germany               | fa-germany-v1  | Approbation route, B2 German requirement, Hamburg / Berlin         |
| ar + uae                   | ar-uae-v1      | DHA pathway, fee schedule, Egyptian-trained dentists in Gulf       |
| ar + saudi                 | ar-saudi-v1    | MOH pathway, Riyadh / Jeddah private practice                       |
| en + canada                | en-canada-v1   | NDEB AFK monthly cohorts, English-speaking applicants               |
| en + australia             | en-australia-v1 | ADC competency-based pathway, lifestyle-driven move                |
| anything else              | en-intl-v1     | Generic intro to RxApply + Destination Advisor invite              |

The first matching row wins. If language is `en` and destination is `canada`, we use `en-canada-v1`, not the fallback.

## Email cadence

| Step | Day | Subject template                                                                  | Body shape                                          |
| ---- | --- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1    | 0   | "Welcome — your {destination} pathway in 5 steps"                                | Welcome + advisor recap + first piece of value content |
| 2    | 2   | "What changed at {regulator} this month"                                          | One regulatory or market signal directly relevant     |
| 3    | 4   | "5 dentists from {origin} who made the move (and what they wish they'd known)"   | Anonymised case-snippet trio                         |
| 4    | 7   | "Realistic budget: what {destination} actually costs in 2026"                    | Cost table + payment-staging guide                   |
| 5    | 14  | "Want to talk it through? 30 minutes, no pitch"                                   | Consult-booking offer with explicit "no pitch" framing |

## Workflow when invoked

### 1. Pick leads to enroll

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/rahbar/rahbar.py" leads
```

Returns the leads, sorted by created_at desc, with the sequence_id that would be picked for each. Use this for visibility before bulk enrollment.

### 2. Enroll one lead

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/rahbar/rahbar.py" enroll --lead <email-or-uuid>
```

The helper:
- Picks the sequence_id from the table above.
- Renders 5 email subjects + HTML bodies (from templates inside the helper, with `{name}`, `{destination}`, `{regulator}`, `{origin}` substituted).
- INSERTs 5 rows into nurture_schedule with the correct send_at offsets.
- Returns `<lead_id>: enrolled in <sequence_id>, 5 rows`.

### 3. Enroll all 3 fixture leads (for T7 test)

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/rahbar/rahbar.py" enroll-all
```

Iterates over the 3 leads we have. After it runs, `SELECT lead_id, COUNT(*) FROM nurture_schedule GROUP BY 1` should return 5 each, 15 total.

### 4. Confirm

In your reply, summarise:
- Which sequence_id each lead got
- Total rows inserted (target 15)
- Send-at offsets per step (Day 0/2/4/7/14)
- T7 pass: 15 rows, evenly distributed across the 3 leads

## Edge cases

- **Lead already enrolled in this sequence**: the UNIQUE constraint kicks in. Helper catches the conflict and reports "already enrolled, skipping" rather than crashing.
- **Language not in the sequence map**: fall through to `en-intl-v1`. Tell the user we used the fallback so they can decide whether to write a sequence for that language.
- **Lead has no `destination_intent`**: pick by language only. If `fa`, default to canada; if `ar`, default to uae; if `en`, the intl fallback.

## Why no n8n

In production, a Postgres trigger on `INSERT INTO leads` fires an n8n webhook that calls Rahbar. For test phase we run on demand. The actual `nurture_schedule` rows are processed by a separate cron-like sender — Rahbar's job is enrollment, not delivery.
