---
name: cross-post-dryrun
description: The DRY_RUN cross-poster — reads scheduled_posts WHERE status='pending', console-logs the would-be API call for each row, and updates status to 'dry_run_logged'. Never actually posts to social platforms. Use this skill whenever the user says "run cross-post dryrun", "dry-run the scheduled posts", "validate the post queue without sending", or wants to test scenario T5 of the test phase.
---

# Cross-post DRY_RUN

The cross-post step in production picks up `scheduled_posts WHERE status='pending'` rows and calls the actual social platform APIs. In test phase we run a DRY_RUN: we log exactly what *would* be sent, mark each row as `dry_run_logged`, and never touch a real API.

## Why this exists

Two reasons. First, validating that scheduling logic produces the right number of rows in the right shape, without paying for real posts. Second, smoke-testing our cross-post worker code paths (auth, payload building, error handling) without leaking test content to a public audience.

## Output

For each pending row:
```
[DRY_RUN] platform=fb account=fb_en language=en scheduled_at=2026-04-30T07:02:03+00:00 text="..." chars=1492
```
Then `UPDATE scheduled_posts SET status='dry_run_logged' WHERE id = <row>`.

## Workflow

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/cross-post/dryrun.py" run
```

The helper:
1. SELECTs all `scheduled_posts WHERE status='pending'`.
2. Prints one `[DRY_RUN]` line per row (truncated text excerpt for readability).
3. UPDATEs `status='dry_run_logged'` for those rows.
4. Returns count of rows logged.

## Pass criteria (T5)

`SELECT COUNT(*) FROM scheduled_posts WHERE status='dry_run_logged'` returns **11** (matching T4's row count).
