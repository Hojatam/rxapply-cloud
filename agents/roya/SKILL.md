---
name: roya
description: Roya is RxApply's market heatmap intel agent. Once a day she scans where dentist-migration interest is hottest (which destinations are getting the most lead inquiries, which countries trend in conversations, which lead sources are converting) and writes one intel_snapshots row of kind='market_heatmap'. Use this skill whenever the user says "run roya", "where is the market hot", "give me a market heatmap", "what destinations are trending", or any phrasing about which countries/regions are driving migration demand right now. Roya is one of 5 intelligence agents (Roya/Shahed/Dadbeh/Nasim/Ramin); her output flows into Pooya's weekly brief.
---

# Roya — Market Heatmap

Roya answers one question every run: **"Where are RxApply's prospective dentists looking to go?"** Her output is a small JSON object that Pooya reads when composing weekly briefs.

## Inputs

For the test phase, Roya samples three local Postgres signals over the last 14 days:

1. `leads.country_of_interest` — the destination each new lead picked.
2. `leads.lead_source` — telegram, instagram, organic, referral, etc.
3. `customers.target_destination` — paid customers' actual chosen destinations.

In production she would also pull live search-trend data (SerpAPI / Google Trends) — that integration is out of scope for the local test phase. The local-only mode is honest about its source: the snapshot's `summary` field includes "(local-signals only)" so downstream readers know the limitation.

## Output

Exactly one `intel_snapshots` row of `kind='market_heatmap'` and shape:

```json
{
  "destinations": [
    {"slug": "canada", "score": 0.83, "rationale": "12 leads + 4 customers in 14d"},
    {"slug": "uae",    "score": 0.61, "rationale": "8 leads, telegram-driven"}
  ],
  "window_days": 14,
  "summary": "Canada leads, UAE strong second. Germany cooling. (local-signals only)"
}
```

`score` is computed from a weighted sum (lead = 1, customer = 3) divided by the period max so the top destination is always 1.0 and others scale relative to it. Below 0.10 is dropped.

## How to call Roya

```bash
# Compose + persist + journal in one shot (the usual case):
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/roya/roya.py" run

# Just compose the JSON and print it (don't write):
python roya.py compose

# Write a hand-crafted payload from stdin (skip the auto-composer):
echo '{"destinations":[…], "window_days":14, "summary":"…"}' | python roya.py run --from-stdin
```

`run` shells out to `paya.py write --agent roya --kind market_heatmap` for the actual insert, and to `zirak.py log --agent roya …` for the journal entry.

## Voice

Diagnostic, terse, evidence-based. The `summary` field is one sentence and names concrete numbers from the underlying counts. No hype, no marketing adjectives.

Good: `"Canada (16 leads) and UAE (9) lead; Australia and Germany flat."`
Bad: `"Canada is absolutely dominating the global dentist-migration scene right now…"`

## Edge cases

- **Zero rows in last 14 days**: Roya still writes a snapshot, but `destinations` is `[]` and `summary` says "no signal — seed leads or wait". Pooya knows to ignore empty heatmaps.
- **Postgres unreachable**: exits non-zero. Tell the user to confirm `supabase_db_rxapply-test` is running.
- **Paya validation fails**: Roya prints the validation error verbatim and exits non-zero — no journal row is written on a hard fail.

## Helper script

`roya.py` lives in this folder. Pure-stdlib Python; uses `docker exec psql` for reads and shells out to Paya/Zirak for writes.
