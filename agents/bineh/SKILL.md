---
name: bineh
description: Bineh is RxApply's engagement-scoring agent. It reads a lead's full event history (advisor completions, page views, email opens/clicks, DMs, comments, time-on-site) and returns a single 0-1 engagement_score with 3 short strings explaining what drove the score. Use this skill whenever the user says "run bineh", "score this lead", "what's [name]'s engagement score", "rank these leads by interest", or wants to test scenario T9 of the test phase. Also use it whenever the user wants to know how warm a particular lead is for outreach.
---

# Bineh — Engagement Score (0–1)

Bineh is the lead-scoring agent. Marketing/sales decisions downstream (who to put on a nurture sequence, who to offer a consult, who to leave alone) all depend on Bineh's score. The score must be honest: a `0.92` should mean the lead is genuinely close to converting, not "they opened one email."

## Inputs

One lead's full event history from the `engagement_events` table, joined to the lead row for context. Helper script handles the join.

Each event has:
- `kind` — `advisor_completion`, `page_view`, `email_open`, `email_click`, `dm`, `comment`, `reply`, etc.
- `platform` — `web`, `email`, `instagram`, `telegram`, etc.
- `payload` — JSONB; semantics vary by kind.
- `created_at` — timestamp.

## Output

```json
{
  "engagement_score": 0.74,
  "top_signals": [
    "Completed the Destination Advisor 7 days ago with a Canada-fit score of 78",
    "Two follow-up page views on /guide/canada (420s and 180s on page) inside the last 5 days",
    "Email click on the NDEB monthly cohorts article — strongest behavioural intent indicator we have for FA leads"
  ]
}
```

Field rules:

- **engagement_score** — float, **2 decimal places**, range `[0.0, 1.0]`. Don't ship `0.741623`. Don't ship anything outside the range.
- **top_signals** — exactly **3 strings**. Each one is a complete sentence describing one specific evidence point. Reference real numbers from the event payload when available.

## Scoring framework

These weights are guidance, not gospel — adjust upward if the events show genuinely strong intent, downward if the activity is noisy or shallow. The plan calls for "sum of weighted signals; reset on inactivity > 30d."

| Signal class                        | Weight contribution |
| ----------------------------------- | ------------------- |
| Advisor completion                  | +0.30               |
| Guide-page view (≥120s on page)     | +0.10               |
| Pricing-page view                   | +0.15               |
| Email click on RxApply content      | +0.10 each (cap 2)  |
| Email open (no click)               | +0.02 each (cap 5)  |
| Inbound DM or comment               | +0.10 each (cap 2)  |
| Reply to RxApply outreach           | +0.15               |
| Long page time (≥300s anywhere)     | +0.05               |
| Returning visitor (≥3 sessions)     | +0.10               |

Decay rule: if there are no events in the last 30 days, the score is multiplied by 0.5 (reset, not zero — old leads can re-warm).

Cap the final number at 1.0; floor at 0.0.

## Workflow when invoked

The user will name a lead by email or UUID.

### 1. Fetch the lead's events

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/bineh/bineh.py" fetch <email-or-uuid>
```

Returns the lead row plus all engagement_events for that lead, ordered most-recent first.

### 2. Score

Read the events. Apply the weights above. Pick the 3 strongest signals — the ones that most explain where the score came from. Write each signal as a single sentence with a real number from the event.

Output the JSON in chat as a fenced code block, plus a one-line plain summary so the human can read it without parsing JSON.

### 3. Save

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/bineh/bineh.py" save --lead-id <uuid> --score 0.74
```

Updates `leads.engagement_score` for that lead. Confirms by SELECT.

### 4. Confirm

Tell the user the new score and the 3 top signals.

## Edge cases

- **No events for the lead**: emit `engagement_score: 0.05, top_signals: ["No engagement events recorded yet — score is the baseline floor for a known lead with no behavioural data"]` (but pad to 3 strings if you can — e.g., naming the lead's source channel and the lack of a follow-up).
- **All events ≥30 days old**: apply the 0.5 decay multiplier and call it out in one of the top_signals.
- **Score ≥0.85**: this is a high-engagement lead. T10 (Mehmandar) podcast invites and consult offers are downstream of this threshold — flag it in the reply.
- **Score < 0.20**: don't pretend they're warmer than they are. The next-step recommendation should be lightweight (newsletter), not a consult ask.

## Why no n8n

Bineh in production runs on a schedule (nightly recompute for active leads) plus on-event (every new engagement_event triggers a re-score). The schedule + event-trigger pattern is exactly what n8n is good for. For test phase we run it on-demand from chat — same scoring logic, different invocation surface.
