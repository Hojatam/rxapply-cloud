---
name: mehmandar
description: Mehmandar curates RxApply's guest pipeline — the queue of dentist-experts we want on our podcast / video series. He reads guest_pipeline rows by stage (invited, scheduling, scheduled, recorded, released), drafts the next-step email per stage (a follow-up nudge, a release-form reminder, a thank-you), drops those emails into MailHog (the local SMTP sink), and writes a one-paragraph weekly digest of pipeline state. Use this skill whenever the user says "run mehmandar", "guest pipeline status", "follow up with that guest", "any guests overdue", or asks anything about the show's guest backlog. Pairs naturally with Ravi's Monday narrative (Ravi reports across all agents; Mehmandar focuses on the show).
---

# Mehmandar — Guest Pipeline Curator

Mehmandar answers: **"What's the state of our guest pipeline this week, and who needs a nudge from us right now?"**

## Inputs

`guest_pipeline` rows. Each row has a `status` (`invited` | `scheduling` | `scheduled` | `recorded` | `released`), an optional `episode_id`, a `release_form_signed` boolean, and timestamps. Mehmandar groups rows by status, identifies anyone overdue (e.g. `invited` > 7 days with no movement, `scheduled` with `release_form_signed=false` < 24h before recording), and drafts one email per overdue case.

## Output

Three things per run:

1. **Emails to MailHog**: one per overdue row, plus a single summary email to the founder. Subjects are templated; bodies name the guest, the stage, and the specific ask.
2. **Digest text** to stdout: 5–8 lines summarising counts by stage and naming the overdue rows.
3. **Zirak journal row**: input='guest_pipeline', output the digest first line, count = total emails sent.

## How to call Mehmandar

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/mehmandar/mehmandar.py" run
python mehmandar.py digest               # print digest only, no emails
python mehmandar.py overdue              # show overdue rows as JSON
```

## Voice

The emails are short, addressed by name, and specific about what's needed. The digest is neutral — counts and names, no commentary. It's an operations briefing, not a marketing pitch.

Good email body (one stage example):
```
Hi {name},

Quick check-in on your RxApply guest spot. We last spoke about scheduling on {invited_at}; if you can send two 30-min slots that work in the next two weeks, I'll lock one and send the recording link.

— Hojat / RxApply
```

## Edge cases

- **Empty pipeline**: emits a one-line digest "guest pipeline empty"; no emails.
- **MailHog (port 1025) unreachable**: emails fail to send — Zirak logs `status=fail` with the SMTP error; the digest still prints to stdout so the founder sees pipeline state regardless.
- **Postgres unreachable**: standard non-zero exit handled by Zirak.
