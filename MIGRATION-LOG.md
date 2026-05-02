# Migration Log

Append-only ledger of every change made on the road from local sandbox
to live `rxapply.com`. Newest entry on top. Each entry references the
git commit hash so the actual diff is one click away.

Format:
```
## YYYY-MM-DD HH:MM · <short label> · <commit-hash>
- bullet 1
- bullet 2
```

---

## 2026-05-01 · M2 · permissions.js + knowledge-base.js ported

- `permissions.js` ported to `pg`. All write operations are now async
  (`setMode`, `queue`, `approve`, `reject`, `recordExecutionResult`,
  `recordExecutionFailure`, `pruneExpired`). `getMode()` and `listAll()`
  intentionally stay sync — they're called inside synchronous validation
  chains (chat policy gate, etc.). New `refresh()` does the async cache
  reload; called on boot and after each `setMode()`.
- `knowledge-base.js` fully ported. Every CRUD + recall + render call
  now async. `recall()` still bumps `last_used_at` / `use_count` on
  the recalled rows.
- Updated KB callers in server.js: 9 routes now async.
- Updated permissions callers in server.js: `/permissions PATCH`,
  `/inbox`, `/inbox/count`, `/inbox/:id/approve`, `/inbox/:id/reject`,
  `/agents/hire`, plus `tools/runtime.js permissions.queue()` call.

Status of Track 1 #1 (pg port): 3 of ~13 modules ported (cost,
permissions, knowledge-base). Remaining: anthropic-chat, compose-stages,
daneshyar-router, afshin-router, agent-evals, agent-handoffs,
agent-memory, agent-models, brand-profile, log-writer, prompt-versions,
services, tools/db.

## 2026-05-01 · M1 · pg-client foundation + cost.js ported

- Added `cowork-proxy/db.js` — single `pg` (node-postgres) entry point.
  Replaces every `docker exec psql` shell-out from the legacy build.
  Exports: `query`, `queryRows`, `queryOne`, `queryValue`, `queryReturning`,
  + literal helpers `q`, `qJson`, `qArr`, `qBytea`, + `ping`, `close`.
  Uses `DATABASE_URL` env var. Auto-enables SSL for non-localhost (Supabase
  Cloud requires it). Connection pool capped at 10 (configurable via
  `DB_POOL_MAX`).
- Updated `package.json` dependencies for the cloud build:
  `pg`, `bcrypt`, `cookie-parser`, `express-rate-limit`, `otplib`,
  `qrcode`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`. Bumped
  Node engine to `>=20.0.0`.
- Ported `cost.js` to async (`getCap`, `getTotals`, `dailyTrend`,
  `byAgent`, `_freshSnapshot`, `snapshot`, `canSpend`). `_freshSnapshot`
  now runs the four queries concurrently via `Promise.all`.
- Updated callers to `await` cost.* methods:
    - `server.js` `/cost`, anthropic chat cap check, compose stream cap check
    - `afshin-router.js` draft + render cap checks
    - `tools/runtime.js` `checkCaps` (now async)

- Scrubbed pre-commit secrets to unblock GitHub push:
    - `start-proxy.bat` → stub (cloud build uses Procfile / env vars)
    - `dashboard.html` → reads runtime config from `/config.js` instead
      of hardcoded SUPABASE_KEY (added route in `server.js`)
    - Deleted legacy V1 prototypes (`admin-dashboard-v1.html`,
      `dashboard-v1.html`)
- Updated `.env.example` for cloud stack: `DATABASE_URL`,
  `ANTHROPIC_API_KEY`, `SECRETS_KEY`, `R2_*` group.
- Updated `.gitignore` to exclude `team-original.jpg` and per-run logs.

Status of Track 1 #1 (pg port): foundation done + 1 of ~13 modules
ported. Remaining modules (each gets its own commit): permissions,
knowledge-base, agent-evals, agent-handoffs, agent-memory, agent-models,
brand-profile, log-writer, prompt-versions, services, tools/db,
afshin-router, server.js inline `_psql` calls.

## 2026-05-01 · session start · baseline

- Copied `rxapply-test/` → `rxapply-cloud/` (5.9 MB, 51 files / 11 dirs,
  excluding `node_modules/`, `.git/`, `logs/`, `*.log`).
- Original local sandbox `rxapply-test/` left untouched as fallback.
- `git init` in `rxapply-cloud/`, default branch `main`.
- Remote `origin` → `https://github.com/Hojatam/rxapply-cloud.git` (private).
- Wrote `CLOUD-MIGRATION-PLAN.md` (canonical plan + tracker).
- Wrote `MIGRATION-LOG.md` (this file).
- Confirmed scope with founder:
    - Cloudflare account ✓ · GitHub repo ✓ · Railway account ✓
    - 2FA: yes (TOTP)
    - Sample data on first-run wizard: **off**
    - LLM transport: direct Anthropic API (CLI removed)
