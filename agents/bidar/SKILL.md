---
name: bidar
description: Bidar is RxApply's nightly agent-efficiency auditor. It reads the last 24 hours of agent_runs (every Claude API call our 21 agents made), rolls them up by agent into the agent_efficiency table, and returns ranked recommendations (promote, demote, rewrite, keep) per agent. Use this skill whenever the user says "run bidar", "run the nightly audit", "score the agents", "which agents are underperforming", or wants to test scenario T11 of the test phase. Also use it whenever the user wants visibility on which of the 21 agents are working well and which need a rewrite.
---

# Bidar — Nightly agent-efficiency audit

Bidar is the auditor. Every night it looks at the last 24 hours of agent calls, computes a daily rollup per agent, and recommends one of four actions: **promote** (let it run more autonomously), **demote** (require approval gates), **rewrite** (the prompt is broken or the model is wrong), or **keep** (no change).

## Inputs

The `agent_runs` table — every Claude API call our 21 agents made. Relevant columns:

- `agent` — one of the 21 names
- `input_tokens`, `output_tokens`, `cost_usd`, `duration_ms`
- `status` — `success`, `fail`, `retry`
- `founder_decision` — `approved`, `rejected`, `refined`, or null
- `created_at`

For T11 we look at the last 24 hours. In production a separate weekly Bidar would look at 7 days for promotion decisions (the plan says promotions require ≥30 days clean record).

## Output

Two things:

1. **Rows inserted into `agent_efficiency`** — one row per (agent, today) pair, with `runs`, `approval_ratio`, `avg_cost_usd`, `avg_duration_ms`, `quality_score`, `bidar_recommendation`.
2. **A JSON array of recommendations** printed to chat, ranked by urgency:

```json
[
  { "agent": "mehmandar", "action": "rewrite", "rationale": "1 of 1 runs failed; outright break", "evidence": {"runs": 1, "fail_count": 1, "approval_ratio": 0} },
  { "agent": "kherad", "action": "keep", "rationale": "1 successful run, cost in line", "evidence": {…} }
]
```

## Scoring framework

Per agent, over the last 24h:

| Metric          | Formula                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| runs            | count(*)                                                                 |
| approval_ratio  | count(founder_decision='approved') / runs · *if no decisions logged, fall back to count(status='success') / runs* |
| avg_cost_usd    | avg(cost_usd)                                                            |
| avg_duration_ms | avg(duration_ms)                                                         |
| quality_score   | 0.6 * approval_ratio + 0.4 * (1 - fail_rate)                             |
| recommendation  | see decision table below                                                 |

**Decision table** (first match wins):

1. `runs == 0` → `keep` (silently — agent didn't run)
2. `fail_rate >= 0.5` → `rewrite` ("majority of runs failed")
3. `runs == 1 AND status == 'fail'` → `rewrite` ("single run failed; can't draw conclusions but worth examining")
4. `approval_ratio < 0.6 AND avg_cost_usd > 0.03` → `rewrite` ("expensive and rejected often")
5. `approval_ratio > 0.85 AND quality_score > 0.85` → `promote` (but only if ≥30 days clean — otherwise `keep`)
6. `approval_ratio < 0.5` → `demote`
7. Otherwise → `keep`

The plan requires that promote recommendations need ≥30 days of clean record. For test-phase, with 24h of data, **never recommend promote** — even strong agents land at `keep`. This is a deliberate conservatism, not a bug.

## Workflow when invoked

### 1. Run the rollup + scoring

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/bidar/bidar.py" run
```

The helper:
- Aggregates `agent_runs` from the last 24h.
- Upserts one row per agent into `agent_efficiency` (UNIQUE on agent+date).
- Returns the JSON ranking to stdout.

### 2. Read and confirm

In your reply, summarise:
- Number of agent_efficiency rows written (target: ≥21 to clear T11 pass).
- Top 3 most-urgent actions (rewrites first, then demotes).
- Count of each recommendation type.

### 3. Save the JSON ranking

The helper writes `bidar-output.json` next to itself for audit and for the dashboard to read.

## Edge cases

- **No runs in the last 24h**: emit `keep` for every agent and explicitly say "no data" in the JSON output. Don't INSERT zero-run rows into agent_efficiency — the row doesn't tell you anything.
- **Cost outliers**: a single very-expensive run can pull avg_cost above the threshold. Flag in rationale; don't auto-rewrite on n=1 unless it also failed.
- **Mixed status without founder_decision**: most fixture runs lack founder_decision. Use the fallback (success-rate proxy) and call this out in the rationale.

## Why no n8n

In production, Bidar runs nightly via n8n cron at 02:00 local. For test phase we run it on demand. Same logic; different trigger.
