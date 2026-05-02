---
name: davari
description: Davari is RxApply's n8n flow-health auditor. It reads the last 24 hours of n8n_executions, identifies any node above its P95 baseline by 2× and any node with retry rate above 5%, and emits a flow_health array (green/amber/red) plus suggested_fixes. Use this skill whenever the user says "run davari", "check the flow health", "any pipelines slow today", "audit the n8n executions", or wants to test scenario T11 of the test phase. Also use it whenever the user wants visibility on which n8n workflows are healthy and which are degrading.
---

# Davari — n8n flow health audit

Davari is the operational auditor for the workflow side. Bidar audits the *agents*; Davari audits the *workflows that orchestrate them*. The two run together as `wf:07-ops-audit` in production.

## Inputs

`n8n_executions` table — one row per workflow run. Schema:

- `id` — n8n's exec id
- `workflow` — `wf:01-content-distribute`, `wf:04-weekly-metrics`, etc.
- `started_at`, `finished_at`, `duration_ms`
- `status`, `retries`
- `node_breakdown` — JSONB array of `{node, ms}` per node executed in the run
- `payload_size_bytes`

## Output

```json
{
  "flow_health": [
    { "workflow": "wf:01-content-distribute",
      "status": "red",
      "executions": 3,
      "slow_nodes": [{"node":"http_run_agent","worst_ms":21000,"baseline_ms":3300}],
      "retry_storms": [{"node":"http_run_agent","retries":2}] },
    …
  ],
  "suggested_fixes": [
    "Investigate http_run_agent latency in wf:01-content-distribute — one run hit 21s vs ~3.3s P50. Check cowork-proxy load.",
    …
  ]
}
```

Field rules:

- **status** — `green` if no anomalies, `amber` if one slow OR one retry storm, `red` if both or persistent.
- **slow_nodes** — any node where `ms` exceeded **2× the P95 baseline** for that workflow. Worst case wins per node.
- **retry_storms** — workflows where total `retries` over the window exceeded 5% of executions.
- **suggested_fixes** — at least one actionable string per `red` workflow; an empty array if everything is green.

## Workflow when invoked

### 1. Run

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/davari/davari.py" run
```

The helper reads last-24h executions, computes per-workflow stats, applies thresholds, and prints the JSON.

### 2. Confirm

In your reply: total exec count, count of green/amber/red workflows, and the top suggested fix.

## Threshold notes

For test phase, baselines are computed *within the same window* — there's not enough data to have a real historical P95. With ≥10 runs we'd use the actual P95; with <10 we treat **2× the median** as the slow threshold. The helper records which mode it used so the call is auditable.

## Why no n8n

Davari fetches data from n8n's own DB (or our mirror). In production it runs as part of the nightly ops-audit. For the test phase we run it on demand.
