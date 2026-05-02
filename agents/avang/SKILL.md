---
name: avang
description: Avang is RxApply's platform fan-out agent. For each approved master article in content_assets (one per language), it generates platform-specific variants and inserts them as rows in scheduled_posts. Use this skill whenever the user says "run avang", "fan this article out to platforms", "schedule the cross-posts", or wants to test scenario T4 of the test phase. Also use it whenever the user wants the master content distributed to ig/fb/telegram/linkedin/youtube.
---

# Avang — Master → platform variants

Avang takes a finished, approved master article and produces the platform-specific variants that downstream cross-post sends. Each (master, platform) pair becomes one row in `scheduled_posts`.

## Inputs

All masters for a brief — typically 3 rows in `content_assets` (en/fa/ar) with `kind='master'` and `status` of g2_approved (or pending_g2 in test phase).

## Output — 11 rows in scheduled_posts

For RxApply's first wave, the platform matrix is:

| platform   | langs                  | rationale                                                    |
| ---------- | ---------------------- | ------------------------------------------------------------ |
| `ig`       | en, fa, ar (×3)        | Instagram is multilingual; each region gets its own account  |
| `fb`       | en, fa, ar (×3)        | Same                                                         |
| `telegram` | en, fa, ar (×3)        | Same                                                         |
| `linkedin` | en only (×1)           | LinkedIn audience is overwhelmingly English-reading          |
| `youtube`  | en only (×1)           | Same                                                         |

Total: **11 rows per brief.**

Each row has: `asset_id`, `platform`, `account_key` (e.g. `ig_fa`, `fb_en`), `language`, `text` (the platform-specific copy), `scheduled_at` (staggered across 24h), `status='pending'`.

## Workflow

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/avang/avang.py" run --brief-id <brief_uuid>
```

The helper:
1. Looks up all `kind='master'` rows for the brief.
2. Iterates the platform matrix above; for each (platform, language) pair where there's a corresponding master, generates a platform-shaped excerpt of `body_md`.
3. Computes a staggered `scheduled_at` (Avang's heuristic: spread across 24h to avoid posting all-at-once, weighted to local prime times by language).
4. INSERTs all 11 rows.

In production Claude generates each variant's copy with platform-aware prose. For the test phase, Avang's helper produces deterministic excerpts from `body_md` — title + first ≤N words depending on platform — so the architecture test runs in seconds without burning tokens.

## Pass criteria (T4)

`SELECT COUNT(*) FROM scheduled_posts WHERE asset_id IN (the brief's masters)` returns **11**.
