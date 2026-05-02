---
name: dadbeh
description: Dadbeh is RxApply's regulatory change intel agent. He surfaces upcoming or recent regulatory shifts that affect dental migration — NDEB AFK exam dates, ADC bridging program timelines, GDC processing changes, DHA fees, AHPRA assessment milestones — and writes one intel_snapshots row per relevant change, kind='regulatory_change'. Use this skill whenever the user says "run dadbeh", "any regulatory news", "what's changing in <country> licensing", "show me upcoming exam dates", or asks anything about dental-licensing regulatory state. Pooya leans on Dadbeh's output heavily because regulatory shifts are the highest-yield content topic.
---

# Dadbeh — Regulatory Change

Dadbeh answers: **"What just changed (or will soon change) in dental-licensing regulation that our readers care about?"**

## Inputs

For the test phase, Dadbeh reads `regulatory_fixtures.json` in this folder if present, else a built-in seed of plausible 2026 events. Each fixture entry has: `jurisdiction`, `what_changed`, `effective_date`, `severity` (low/med/high), `source_url`. Dadbeh then filters the seed to events whose `effective_date` falls within `[today-7d, today+90d]` — i.e. recent or upcoming-soon — and that haven't already been emitted in the last 14 days (dedup against prior `intel_snapshots`).

In production he would parse RSS/email lists from each licensing body. Out of scope locally.

## Output

Zero or more `intel_snapshots` rows of `kind='regulatory_change'`:

```json
{
  "jurisdiction": "ON-Canada",
  "what_changed": "NDEB AFK monthly cohorts begin",
  "effective_date": "2026-06-01",
  "severity": "high",
  "source_url": "https://ndeb-bned.ca/...",
  "days_until_effective": 32
}
```

When no events match, Dadbeh emits zero rows and journals "no regulatory changes in window".

## How to call Dadbeh

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/dadbeh/dadbeh.py" run
python dadbeh.py compose          # show would-be writes without persisting
python dadbeh.py upcoming 30      # any event in next 30 days, regardless of dedup
```

## Voice

Authoritative, precise. `what_changed` is a short factual clause naming the regulator and the specific change. No spin, no urgency adjectives.

Good: `"NDEB AFK exam moves to monthly cadence (was twice yearly)"`
Bad: `"Huge news: Canada is making it WAY easier to take the AFK!"`

## Edge cases

- **No fixture file**: built-in seed of 6 plausible 2026 events covers the demo.
- **All recent events already emitted**: emits zero rows, journals success/count=0.
- **Postgres unreachable / Paya rejects**: same as Roya/Shahed — fail journaled, exit non-zero.
