---
name: zirak
description: Zirak is RxApply's agent-journal writer. Every other agent (Pooya, Sepehr, Goyesh, Rahnama, Bineh, Mehrban, Bidar, Davari, Ravi, Rahbar, Avang, etc.) calls Zirak at the end of its run to drop one narrative row into agent_journal — agent name, status, what came in, what went out, where the result landed. Use this skill whenever the user says "log this run", "tell zirak", "journal that", "what did <agent> do today", "show me failures", "tail the journal", or any phrasing about reading or writing the activity feed that powers the admin dashboard. Also use it whenever you finish a one-off agent run by hand and the user wants the action to show up in the dashboard's activity panel.
---

# Zirak — Agent Journal Writer

Zirak is the narrator of the system. It does not generate content, score leads, or talk to LLMs. Its job is to make every agent invocation visible in one append-only place: the `agent_journal` table.

## Why Zirak exists

`agent_runs` is **billing-shaped** (input_tokens, output_tokens, cost_usd, duration_ms) and is consumed by Bidar for efficiency rollups. It is not friendly for a human reading an activity feed.

`agent_journal` is **narrative-shaped** — for each run it records what came in (one line), what went out (one line), where the output landed (table + id), and whether it succeeded or failed. The admin dashboard reads the last 50 rows of this table for its activity panel; Zirak writes them.

Both tables coexist intentionally. Bidar reads `agent_runs`, the dashboard reads `agent_journal`. Same agents, different lenses.

## Inputs

Zirak reads and writes one Postgres table: `agent_journal` (created by migration `20260430000000_agent_journal.sql`). Schema fields it cares about:

- `agent` — required, the calling agent's slug (e.g. `pooya`, `sepehr`).
- `status` — `running` | `success` | `fail`.
- `input_summary` — one line, ≤120 chars. Examples: "brief df7d2847", "saeed.tehrani@example.com", "fa+ar from master 1c92e0".
- `output_summary` — one line, ≤120 chars. Examples: "3 briefs inserted", "score=0.80", "1 dry_run_logged".
- `output_table` / `output_id` / `output_count` — pointer to the result row(s) so a future debugger can jump from feed → data.
- `error` — first 500 chars of error message on failure, NULL on success.
- `trigger_source` — `manual` | `cron` | `webhook` | `dashboard`.
- `duration_ms` — auto-computed when you use `start` + `finish`.

## Outputs

Zirak emits two kinds of output:
1. **Writes** — one row inserted (or updated) in `agent_journal` per call.
2. **Reads** — JSON arrays for the dashboard or for ad-hoc inspection (`tail`, `for-agent`, `failures`).

## How to call Zirak

Always via the helper script `zirak.py`. Two patterns:

### Pattern A — single-shot log (most common)

Use this when an agent has already finished and you want to record it in one call:

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/zirak/zirak.py" log \
  --agent pooya \
  --status success \
  --input "intel last-7d (12 snapshots)" \
  --output "3 briefs inserted at pending_g1" \
  --table content_briefs --count 3 \
  --trigger manual
```

### Pattern B — start + finish (for long-running agents)

Use this when you want the dashboard to show the agent as `running` while it works (rare for our local pipeline, but supported):

```bash
# at the start
RUN_ID=$(python zirak.py start --agent sepehr --input "brief df7d2847" --trigger dashboard)

# at the end
python zirak.py finish "$RUN_ID" --status success \
  --output "1500-word EN master, 4 citations" \
  --table content_assets --ref-id 1c92e0fa-... --count 1
```

`start` prints the new row's UUID to stdout so you can pass it to `finish`.

### Reading the journal

```bash
python zirak.py tail              # last 20 rows as JSON
python zirak.py tail 50           # last 50
python zirak.py for-agent pooya 10
python zirak.py failures 20
```

These are what the admin dashboard's activity panel and the failure-banner panel will eventually read (right now the dashboard talks to Supabase REST directly, but `zirak.py` mirrors the same data shape for CLI use and for the prompts editor).

## Workflow when invoked

1. Decide which pattern fits — single-shot `log` for "I just ran X, record it" or `start`/`finish` for "this will take a while".
2. Build the command with concrete values. Keep `input_summary` and `output_summary` to one short line each — the activity feed has no room for paragraphs.
3. Run the command. The script returns 0 on success, prints the new row's UUID, and exits.
4. If the user asked to **read** the journal, pick the right subcommand (`tail`, `for-agent`, `failures`) and print the JSON output.

## Voice

Telegraphic. Zirak's lines are not articles — they are narrator captions for an operations dashboard. Ten words is plenty.

Good: `"3 briefs inserted at pending_g1"`
Bad: `"Pooya synthesized three editorial briefs based on the last 7 days of intel snapshots and inserted them into content_briefs..."`

## Edge cases

- **agent_journal table missing**: the helper exits with a clear error pointing to `apply-migration-agent-journal.bat`.
- **status not in (running|success|fail)**: helper rejects with `exit 2` — the table has a CHECK constraint.
- **Postgres unreachable**: the helper returns non-zero. Tell the user to confirm `supabase_db_rxapply-test` is running (`docker ps`).
- **finish on an already-finished row**: still works (UPDATE), but `started_at` is preserved so duration_ms recomputes against the original start.

## Helper script

The full source of `zirak.py` is in this folder. It uses `docker exec` to talk to the Supabase Postgres container, so it has zero pip dependencies — just stdlib Python. Run it with whatever Python is on PATH (3.11 or 3.13 both work).
