---
name: ramin
description: Ramin is RxApply's keyword-candidate intel agent. He reads the recent output of the other 4 intel agents (Roya market heatmap, Shahed competitor diff, Dadbeh regulatory change, Nasim trend spike) and synthesizes a list of high-yield keyword/SEO candidates — concrete phrases that combine a hot destination, a regulatory hook, and an audience-trending topic. Output is one intel_snapshots row, kind='keyword_candidates'. Use this skill whenever the user says "run ramin", "give me keyword ideas", "what should we rank for", "SEO candidates", or asks for actionable content angles. Pooya treats Ramin's output as the connective tissue between intel and content briefs.
---

# Ramin — Keyword Candidates

Ramin answers: **"Given what we know this week, what specific phrases should we try to rank for?"**

## Inputs

Ramin reads the last 7 days of `intel_snapshots` from the other 4 intel agents:

- `market_heatmap` (Roya) — top destinations to anchor location-based keywords.
- `regulatory_change` (Dadbeh) — concrete events → year-anchored keywords ("ndeb afk timeline 2026").
- `trend_spike` (Nasim) — bottom-up phrases the audience is already using.
- `competitor_diff` (Shahed) — gaps to attack with a counter-article.

He cross-products the signals: *(hot destination) × (regulatory hook OR trending topic)* → keyword candidates. Each candidate cites the snapshot UUIDs that produced it (`anchor_intel_ids`).

In production he would also pull SerpAPI volume estimates. Locally, volumes are heuristic estimates from a small lookup table.

## Output

One `intel_snapshots` row of `kind='keyword_candidates'`:

```json
{
  "keywords": [
    {"keyword": "ndeb afk timeline 2026", "est_volume": 880, "intent": "info",
     "related_destinations": ["canada"], "anchor_intel_ids": ["<uuid-dadbeh>", "<uuid-roya>"]},
    {"keyword": "uae fast track dental license", "est_volume": 1200, "intent": "info",
     "related_destinations": ["uae"], "anchor_intel_ids": ["<uuid-nasim>"]}
  ],
  "anchor_intel_ids": ["<uuid>", "<uuid>", …],
  "summary": "12 candidates from 7d intel; canada + uae dominate"
}
```

`intent` is one of `info` / `comparison` / `commercial` / `transactional` based on the keyword's verb pattern.

## How to call Ramin

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/ramin/ramin.py" run
python ramin.py compose       # show the candidate list without writing
```

## Voice

`keyword` strings are lowercase, 3–6 words, naturally search-like. No quotes, no boolean operators.

Good: `"adc australia exam fees 2026"`, `"bridging program canada cost"`
Bad: `"\"How to migrate\" + dentist + (canada OR uae)"`

## Edge cases

- **No fresh intel from the other agents**: emits an empty `keywords` array and journals "no recent intel; ramin idle".
- **Only one intel kind present**: still produces output, but each candidate has at most one anchor and the summary notes the imbalance.
- **Postgres / Paya errors**: same as the other intel agents.
