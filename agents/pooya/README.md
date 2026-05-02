# pooya/

Pooya is RxApply's first agent: takes a week of intelligence snapshots, returns 3 editorial topic briefs ready for Sepehr to write up.

This folder is structured as a Cowork **skill**, so once you register it Claude can run Pooya as a single chat prompt.

## Files

| File         | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `SKILL.md`   | Instructions Claude reads when the skill is triggered              |
| `pooya.py`   | DB helper — `fetch` reads intel; `insert` saves briefs (no pip deps) |
| `README.md`  | This file                                                          |

## Running it manually (right now, no skill registration needed)

```powershell
cd C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents\pooya

# 1. See what intel Pooya will look at
python pooya.py fetch

# 2. (You / Claude) compose a JSON array of 3 briefs grounded in that intel.
#    Save it to briefs.json. Each brief must have:
#      title, language_priorities[], target_destinations[],
#      suggested_angle, predicted_seo_yield ("high"|"med"|"low"),
#      source_citations[]    (use "intel_snapshot:<uuid>" strings)

# 3. Insert
python pooya.py insert < briefs.json
# → prints  <uuid>|<title>  for each row inserted
```

The inserts land in `content_briefs` with `source='pooya'` and `status='pending_g1'`. View them in Studio at `http://127.0.0.1:54323`.

## Registering Pooya as a Cowork skill

Cowork auto-loads skills from a specific folder on your machine. To make Pooya trigger on phrases like *"run pooya"* or *"generate topic briefs"* in any Cowork conversation:

1. Find your Cowork user-skills folder. On this machine the path is something like:
   ```
   C:\Users\Hojat\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\<plugin-uuid>\<session-uuid>\skills\user\
   ```
   (The `skills-plugin/.../skills/user/` part is consistent; the UUIDs vary.)

2. Create a junction (symlink) from there to this folder. In an admin PowerShell:
   ```powershell
   New-Item -ItemType Junction `
     -Path "<that-path>\pooya" `
     -Target "C:\Users\Hojat\OneDrive\Desktop\rxapply-test\agents\pooya"
   ```
   Junction = "the OS treats this name like a folder, but it actually points to that folder." Edits to the source flow through automatically — no copy needed.

3. Restart Cowork (or open a new conversation). Claude should pick up `pooya` in its `available_skills` list. Test with: *"run pooya"*.

If you'd rather not deal with junctions, an ordinary `Copy-Item -Recurse` works too — but you'd have to re-copy after every edit to `SKILL.md`.

## Why this design

- **No n8n.** Pooya's job is small enough that a Cowork skill + 50 lines of Python is sufficient. We'd add n8n if we needed timed triggers, parallel fan-out across many agents, or webhook entrypoints — none of which T1 needs.
- **No pip dependencies.** `pooya.py` shells out to `docker exec ... psql`. Trade-off: slower than a real Postgres driver, but zero install friction and one less place for Python-version weirdness.
- **JSON in / JSON out for the DB layer.** The Python helper never tries to "understand" the briefs — that's Claude's job. The script just shuttles bytes safely.
- **Auto-insert as `pending_g1`.** Per your call. Skips the chat-preview pause; downstream G1 gate is the formal approval. If you want the preview pause back, edit `SKILL.md` step 3 to "show then ask".

## What you can do with Pooya right now

- **Run it end-to-end** — verifies T1 of the test phase scorecard.
- **Reuse the pattern for the other 20 agents** — `roya/`, `shahed/`, `sepehr/`, etc. Same shape: SKILL.md + helper.py.
- **Hand-feed it new intel** — INSERT a fake `intel_snapshots` row, re-run Pooya, see what brief it generates.
