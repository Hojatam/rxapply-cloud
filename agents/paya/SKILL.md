---
name: paya
description: Paya is RxApply's intel-snapshot writer. The 5 intelligence agents (Roya = market heatmap, Shahed = competitor diff, Dadbeh = regulatory change, Nasim = trend spike, Ramin = keyword candidates) all hand their final JSON payload to Paya, which validates it against the kind's schema and writes one row to intel_snapshots. Use this skill whenever the user says "write intel", "snapshot this", "tell paya", "list recent intel", "show me the latest <kind>", or any phrasing about reading or writing the intel feed that Pooya consumes. Paya does not generate intel itself — it gates writes and serves reads.
---

# Paya — Intel Snapshot Writer

Paya is to `intel_snapshots` what Zirak is to `agent_journal`: the only sanctioned writer. Every other intel agent ends its run by handing Paya a JSON payload; Paya checks the shape and inserts the row. Pooya reads from the same table to compose weekly briefs.

## Why a single writer

Five different agents (Roya, Shahed, Dadbeh, Nasim, Ramin) emit five different payload shapes. Without a gate, each could drift independently and Pooya's reader would have to handle every dialect that ever existed. With Paya as the only writer, the shape contract for each `kind` lives in one file — `paya.py` — and Pooya can trust `intel_snapshots.payload` to match.

## Schema contracts (per kind)

Paya validates `payload` against the `kind`. A row is rejected if required keys are missing.

`kind = 'market_heatmap'` (Roya):
```json
{
  "destinations": [{"slug": "canada", "score": 0.83, "rationale": "…"}],
  "window_days": 7,
  "summary": "Canada and UAE leading; Germany cooling."
}
```

`kind = 'competitor_diff'` (Shahed):
```json
{
  "competitor": "examplerival.com",
  "what_changed": "published a 2026 NDEB AFK timeline guide",
  "url": "https://…",
  "first_seen_at": "2026-04-28T09:14:00Z"
}
```

`kind = 'regulatory_change'` (Dadbeh) — `kind` value can also be `reg_change` (legacy) and is normalized:
```json
{
  "jurisdiction": "ON-Canada",
  "what_changed": "NDEB AFK monthly cohorts begin June 2026",
  "effective_date": "2026-06-01",
  "severity": "high"
}
```

`kind = 'trend_spike'` (Nasim):
```json
{
  "topic": "uae dental license fast track",
  "platform": "telegram",
  "momentum_pct": 38,
  "sample_phrases": ["…", "…"]
}
```

`kind = 'keyword_candidates'` (Ramin):
```json
{
  "keywords": [
    {"keyword": "ndeb afk timeline 2026", "est_volume": 880, "intent": "info", "related_destinations": ["canada"]}
  ],
  "anchor_intel_ids": ["<uuid>", "<uuid>"]
}
```

If a write fails validation, Paya exits non-zero and prints the missing keys; nothing is written.

## How to call Paya

Always via the helper script `paya.py`. Two patterns:

### Pattern A — write a single snapshot

```bash
echo '{"destinations":[{"slug":"canada","score":0.83}], "window_days":7, "summary":"…"}' | \
  python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/paya/paya.py" write \
    --agent roya --kind market_heatmap
```

Paya reads the JSON object from stdin, validates against the schema for `kind`, and inserts. On success it prints the new `intel_snapshots.id`.

### Pattern B — write many snapshots from a JSON array

```bash
python paya.py bulk --agent ramin --kind keyword_candidates < array.json
```

Each element of the array is validated and inserted. On a single failure, the whole batch is rolled back.

### Reading the intel

```bash
python paya.py list 20                  # last 20 snapshots, all kinds
python paya.py by-kind market_heatmap 5
python paya.py by-agent roya 10
python paya.py since 7                  # last 7 days, sorted desc
```

These are what **Pooya** uses internally (Pooya already has its own reader — `paya.py` is the same shape so the two can be swapped).

## Workflow when invoked

1. Decide whether the call is a write (one or many) or a read.
2. For writes: build the JSON payload, pipe it via stdin to `paya.py write` with the right `--agent` and `--kind`.
3. Always have the calling agent then journal the action via Zirak (`zirak.py log --agent <intel_agent> --status success --output "<count> snapshots written" --table intel_snapshots --count <n>`). Paya itself does NOT call Zirak — that responsibility stays with the intel agents so a Paya-side bug never silently swallows journal entries.
4. For reads: pick the right subcommand, print the JSON.

## Voice

Paya has no voice — it is plumbing. The skill exists so that *generating* intel and *persisting* it stay separated. The voice you hear in `intel_snapshots.payload.summary` belongs to whichever intel agent generated it.

## Edge cases

- **Empty stdin on `write`**: exits 2 with `ERROR: empty payload`.
- **Unknown `kind`**: exits 2 with the list of accepted kinds.
- **Missing required key**: exits 2 with `ERROR: kind=<k> missing keys: [...]`.
- **`reg_change` vs `regulatory_change`**: normalized to `regulatory_change` on write; reads accept either.
- **Postgres unreachable**: exits non-zero. Tell the user to confirm `supabase_db_rxapply-test` is running.

## Helper script

The full source of `paya.py` is in this folder. It uses `docker exec` to talk to the Supabase Postgres container — zero pip dependencies, just stdlib Python.
