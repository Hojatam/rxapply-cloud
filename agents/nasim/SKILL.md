---
name: nasim
description: Nasim is RxApply's trend-spike intel agent. She watches recent engagement_events (DMs, comments, clicks, replies) for topic momentum — which keywords are showing up in messages today versus the trailing 14-day baseline — and writes one intel_snapshots row per spiking topic, kind='trend_spike'. Use this skill whenever the user says "run nasim", "what's trending", "any spikes today", "show momentum", or asks about audience-driven topic surges. Pooya pairs Nasim's spikes with Dadbeh's regulatory changes to identify high-confidence brief topics.
---

# Nasim — Trend Spike

Nasim answers: **"What is our audience suddenly talking more about than they were last week?"**

## Inputs

For the test phase, Nasim reads `engagement_events` from local Postgres. She compares last-3-day topic frequency against the 14-day baseline. Topics are extracted by tokenising `payload->>'text'` (or `kind` if no text) into 1-2 word phrases, lowercasing, and stopwording out boilerplate ("the", "and", platform names, etc.). A topic counts as a *spike* if its 3-day rate is at least 2× the baseline rate AND it appears at least 3 times in the recent window.

In production she would also pull from Telegram channels, Reddit, dental forums. Local-only mode makes that limitation explicit in the snapshot's `summary`.

## Output

Zero or more `intel_snapshots` rows of `kind='trend_spike'`:

```json
{
  "topic": "uae fast track",
  "platform": "telegram",
  "momentum_pct": 220,
  "sample_phrases": [
    "is the uae fast track real for 2026",
    "anyone done the dha fast track recently?"
  ],
  "recent_count": 7,
  "baseline_rate_per_day": 0.21
}
```

`momentum_pct` = 100 × (recent_rate / baseline_rate) − 100. So 100% = doubled; 220% = tripled. Capped at 999.

## How to call Nasim

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/nasim/nasim.py" run
python nasim.py compose       # show would-be writes
python nasim.py topics 30     # raw 30-day topic frequency table
```

## Voice

`topic` is a 2–4 word lowercase phrase. `summary` (in the journal output line) is one sentence: "uae fast track up 220% on telegram (7 mentions)".

## Edge cases

- **Empty engagement_events table**: emits zero rows, journals "no engagement signal".
- **Baseline window has zero matches** (new topic): treated as a spike with `momentum_pct=999` and a "first-seen" note in `sample_phrases`.
- **Postgres / Paya errors**: same handling as the other intel agents.
