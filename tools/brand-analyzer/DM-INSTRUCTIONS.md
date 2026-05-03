# DM Analysis · Claude Code instructions

You are analyzing the founder's Instagram DM corpus to extract patterns that will train Bineh (triage), Mehrban (reply-draft), Pooya (topic discovery), and Avang (caption hooks).

**Privacy first.** All partner names are hashed (`USER_xxxxxx`). PII (phones, emails, IDs, IG profile links) is already redacted. **Do not include any data that could re-identify a real person in your output files.** Sanitize sample quotes — keep specifics about the dental-migration topic, strip anything personal.

**Founder is the only responder** — all `direction: "out"` messages are the founder. Their voice in 1-on-1 is what we're training Mehrban on.

**No outcome labels available** (no CRM, no conversion data). Use proxy signals:
- **engaged** — thread length ≥ 10 messages, mutual back-and-forth, founder replied promptly
- **dropped** — user went silent after ≤ 3 messages
- **dead** — only 1 inbound message, no founder reply
- **resolved** — clear closure ("thanks!", "I'll think about it", "OK I understand")

Apply these as best-effort labels; never claim certainty about conversion.

---

## Pre-flight check

Read `output/dm_threads_input.json`. Confirm:
- `counts.total_threads` is a sane number (typically 100s to 1,000s)
- `counts.total_messages` matches expectation
- `you_handle_hash` is set
- A spot-check of the first 2-3 threads looks like real Persian/English DMs

If anything looks corrupted (e.g. all messages are empty strings, or every message looks like garbled bytes), stop and tell the user — the parser may need a fix.

---

## Stages 1-5 produce these output files

By the end you must have written, into `./output/`:

1. **`dm_question_patterns.json`** — top-50 most-asked questions clustered by topic
2. **`dm_objection_playbook.json`** — top-20 objection patterns with verbatim sample + founder's best reply + outcome proxy
3. **`dm_voice_fingerprint.json`** — founder's reply-voice cluster (30-50 sanitized exemplar replies)
4. **`dm_intent_examples.json`** — labeled examples per Bineh's 5 buckets (curious / qualifying / hot / off-topic / complaint)
5. **`DM-SUMMARY.md`** — one-page plain-English summary

---

## Stage 1 — Read + classify each thread

For each thread in `dm_threads_input.json`:

Determine:
- **Intent class** (Bineh's 5 buckets):
  - `curious` — generic interest, broad questions ("is UK worth it?")
  - `qualifying` — comparing options, asking specifics, exploring fit
  - `hot` — commitment signals (regulator name + year, exam dates, "how do I sign up?", "what's next?")
  - `off-topic` — unrelated to dental migration / spam
  - `complaint` — issue with brand, product, course, refund
- **Topic tags** (free-form, e.g. `["NDEB", "fees", "Canada", "age-concern"]`)
- **Outcome proxy** (per the rules above): engaged / dropped / dead / resolved
- **Country focus** if mentioned: ca / uk / us / de / au / uae / sa / multi / none
- **Career stage** if inferrable: student / new-grad / mid-career / established / unknown

Scan the thread holistically — don't classify on the first message alone. A "curious" first message can become "hot" by message 5.

Don't write per-thread output as a separate file. Hold the classifications in memory and use them across stages 2-5.

---

## Stage 2 — `dm_question_patterns.json`

Cluster all INBOUND text-bearing messages into question patterns. A "question" includes both literal `?` questions AND statement-style information requests ("می‌خواهم بدانم...", "tell me about...").

Output structure:

```json
{
  "generated_at": "<ISO>",
  "n_inbound_messages_analyzed": <int>,
  "n_unique_question_patterns": <int>,
  "patterns": [
    {
      "rank": 1,
      "topic": "NDEB fees + timeline 2026",
      "frequency": 47,
      "language_split": { "fa": 38, "en": 7, "ar": 2 },
      "career_stage_split": { "new-grad": 18, "mid-career": 22, "established": 5, "unknown": 2 },
      "sample_questions": [
        "<short verbatim sample 1, sanitized>",
        "<sample 2>",
        "<sample 3>"
      ],
      "implied_audience_pain": "<one sentence>",
      "content_idea_for_pooya": "<one sentence — a future post or article topic>"
    }
  ]
}
```

Cap at 50 patterns. Sort by frequency descending. Cluster aggressively — "how much is NDEB Part 1?" and "what's the fee for Canadian licensing exam?" are the same pattern.

The `content_idea_for_pooya` field is critical — it's how this analysis turns into a content backlog. Be specific.

---

## Stage 3 — `dm_objection_playbook.json`

Find the 20 most-recurring OBJECTION patterns. An objection is anything the user says that pushes back on or hesitates about pursuing migration:
- "I'm too old" / "is 35 too late?"
- "the exam fees are crushing"
- "what if I fail?"
- "my English isn't good enough"
- "my home job is good enough"
- "the timeline is too long"

For each objection, find one or two GOOD founder replies (where outcome was `engaged` or `resolved`, not `dropped`).

Output structure:

```json
{
  "generated_at": "<ISO>",
  "objections": [
    {
      "rank": 1,
      "objection_pattern": "Too old to start",
      "frequency": 23,
      "language_split": { "fa": 21, "en": 2 },
      "verbatim_samples": [
        "<sanitized sample, partner says>",
        "<...>"
      ],
      "founder_best_reply": {
        "thread_id": "USER_xxxxxx",
        "reply_text": "<founder's actual reply, sanitized>",
        "why_it_worked": "<one sentence — what made this reply land>",
        "outcome_proxy": "engaged | resolved"
      },
      "founder_alt_replies": [
        "<another good reply variant, sanitized>"
      ],
      "agent_rule_for_mehrban": "<one sentence rule. e.g. 'Acknowledge the age concern with a specific success story before facts.'>"
    }
  ]
}
```

20 entries, ordered by frequency. The `agent_rule_for_mehrban` is what Mehrban will be trained on — make each rule concrete and actionable.

---

## Stage 4 — `dm_voice_fingerprint.json`

Pick 30-50 outbound messages (founder's replies) that best represent the canonical 1-on-1 voice. Criteria, in order:
- The thread had a positive proxy outcome (`engaged` or `resolved`)
- The reply addresses a specific question or objection (not a one-liner like "thanks!")
- The reply is in the most-common language for the thread (Persian for FA threads etc.)
- Diversity across topics (NDEB / GDC / IELTS / fees / age / process / etc.)
- Natural founder voice (not formal templated responses)

For each picked reply, store the inbound message that prompted it for context.

```json
{
  "generated_at": "<ISO>",
  "method": "qualitative-cluster",
  "n_picked": 42,
  "cluster": [
    {
      "thread_id": "USER_xxxxxx",
      "language": "fa",
      "context_inbound": "<sanitized inbound that prompted the reply>",
      "founder_reply": "<sanitized reply>",
      "topic": "<short tag>",
      "why_picked": "<one sentence — what makes this canonical 1-on-1 founder voice>"
    }
  ]
}
```

This is M50's training data. The reply field is what Mehrban will be embedded against and judged against.

---

## Stage 5 — `dm_intent_examples.json`

Pick 8-12 LABELED EXAMPLES per Bineh bucket. These are real DMs that clearly fit a specific intent class — Bineh will be trained on them as few-shot exemplars.

```json
{
  "generated_at": "<ISO>",
  "buckets": {
    "hot":        [{ "thread_id": "USER_xxxxxx", "language": "fa", "first_inbound": "<sanitized verbatim>", "signals": ["regulator name", "year-specific", "asks how to sign up"], "confidence": 0.95 }, ...],
    "qualifying": [...],
    "curious":    [...],
    "off-topic":  [...],
    "complaint":  [...]
  }
}
```

Each example: ONE inbound message (the FIRST message in the thread that triggered classification — what Bineh will see when a new DM arrives), with a list of explicit signals that justify the bucket.

This is M47's training set going from "synthetic prompts" to "real labeled data."

---

## Stage 6 — `DM-SUMMARY.md`

One-page summary for the founder, scannable in 2 minutes:

```markdown
# DM Analysis · Summary

**Analyzed**: 487 threads · 6,432 messages · 2019-08 to 2024-10
**You wrote**: 3,210 outbound messages · 2,801 inbound from partners

## Intent breakdown
- 🔥 Hot:        47 (9.6%)
- Qualifying:   122 (25%)
- Curious:      183 (38%)
- Off-topic:    98 (20%)
- Complaint:    37 (7.5%)

## Top 5 questions (per dm_question_patterns.json)
1. NDEB fees + timeline 2026 (47 occurrences)
2. ...

## Top 5 objections (per dm_objection_playbook.json)
1. "Too old to start" (23 occurrences)
2. ...

## Voice insight
- Founder's 1-on-1 voice is [warmer / more direct / etc.] than broadcast voice
- Founder uses [pattern] in replies but rarely in posts: [example]
- Average reply length: [N] words. Median time-to-first-reply: [N] hours.

## Highest-leverage content ideas (from question patterns + objections)
1. <topic>
2. ...
3. ...

## Hot-lead red flags Bineh should watch for
- "Has my [regulator] number" → almost always converts to engaged
- "Specific exam date mentioned" → high commitment signal
- ...

## Surprises
- ...
- ...

## Privacy report
- All partner names hashed
- N PII items redacted (phones / emails / IDs)
- No real names appear anywhere in the output JSONs
```

Use real numbers from the analysis. Be concrete.

---

## Working tips

- **Process in chunks.** Don't try to read all threads at once. Read 50-100 at a time.
- **Save progress as you go.** Write each JSON the moment its stage completes.
- **Be conservative with intent labels.** When uncertain, prefer `curious`. False-positive `hot` labels poison Bineh's training.
- **Sanitize ruthlessly.** Even after the parser's redaction, watch for partner-specific details that could re-identify (rare disease, very specific clinic names, exact birth years). Generalize them.
- **Don't invent patterns.** If the data only shows 5 instances of an objection, say "5", not "many."
- **Founder voice is in `direction: "out"`** — that's the only voice you train Mehrban on.

When all 5 output files + `DM-SUMMARY.md` are written, tell the founder you're done and that they should read `DM-SUMMARY.md` first.
