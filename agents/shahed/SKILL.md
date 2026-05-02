---
name: shahed
description: Shahed is RxApply's competitor diff intel agent. He watches competitor sites and surfaces what's new since his last snapshot — new articles, new pricing pages, new translations. Output is one intel_snapshots row per detected change, kind='competitor_diff'. Use this skill whenever the user says "run shahed", "what are competitors doing", "show me competitor changes", "diff competitors", or asks about competitive intelligence for the dental-migration market. Shahed feeds Pooya's weekly brief — competitor moves often justify a counter-article.
---

# Shahed — Competitor Diff

Shahed answers: **"Which competitor shipped what this week?"**

## Inputs

For the test phase, Shahed reads a local fixture (`competitor_fixtures.json` in this folder if present, else a built-in default) describing each competitor's current state — what URLs they show, what topics they cover. He compares the current fixture against the most recent `competitor_diff` snapshot in `intel_snapshots` (his own prior output), and emits one row per change.

In production he would crawl actual competitor sitemaps and RSS feeds; that's out of scope for the local test phase, and his SKILL says so.

## Output

One or more `intel_snapshots` rows, each `kind='competitor_diff'`:

```json
{
  "competitor": "examplerival.com",
  "what_changed": "added '2026 NDEB AFK timeline guide'",
  "url": "https://examplerival.com/ndeb-afk-2026",
  "first_seen_at": "2026-04-30T10:00:00Z"
}
```

When nothing has changed since the last run, Shahed emits zero rows and journals "no diffs" (success, count=0).

## How to call Shahed

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/shahed/shahed.py" run
python shahed.py compose          # show diffs without writing
python shahed.py snapshot         # write the current fixture as the new baseline (no diffs emitted)
```

## Voice

Factual, terse. The `what_changed` line is one short noun phrase — "new pricing page", "added FAQ section about IELTS", "translated landing page to Farsi". Not opinion, not analysis.

## Edge cases

- **No fixture file**: falls back to a built-in 3-competitor seed so a fresh dev box still produces output.
- **No prior snapshot**: treats the entire fixture as new and emits one diff per competitor with `what_changed = "first observation"`.
- **Postgres unreachable / Paya rejects**: same handling as Roya — non-zero exit, fail journaled by Zirak.
