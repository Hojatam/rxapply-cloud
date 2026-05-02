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

## 2026-05-01 · M6 · anthropic-chat + log-writer + server.js inline (pg port DONE)

- `anthropic-chat.js` ported. `streamChat`, `recentRuns`, `getChat`,
  `listChats`, `createChat`, `appendMessages` all async. `streamChat`
  now runs `recentRuns / agentMemory.renderAsBlock / KB.renderAsBlock`
  concurrently via `Promise.all` to shave a round-trip off chat boot.
- `log-writer.js` ported. `recordRunStart`, `recordRunEnd`, `recordAction`,
  `listRuns`, `loadRunBundle`, `logApiCall` all async. Internal
  `_psqlExecScript` is now a thin wrapper around `db.queryValue` for
  any future legacy callers.
- `server.js` 3 inline `_psql` calls (settings GET/PATCH + `_composePsql`)
  replaced with the pg pool. Removed unused `spawnSync` import. 6
  compose routes (`/compose/approve-for-posting`, `/compose/recent`,
  `/compose/:mediaId`) marked async.
- 6 `_logAnthropic` call sites updated to await the now-async helper.
- Updated callers to await: `/run-helper` (recordRunStart/End),
  `/logs` (listRuns), `/logs/:runid[/download]` (loadRunBundle),
  `/agent/:name/chats[/:chatId]` (listChats/getChat).

**End-of-port verification:**
- `node -c` syntax check passed on all 17 ported modules.
- Full proxy boot test against local Supabase:
    - Listened on :7778 ✓
    - 13 tools synced to Postgres ✓
    - `/health` returned 200 ✓
    - Zero startup errors ✓

Track 1 #1 (pg-client port) is **DONE**. The cloud proxy no longer
shells out to docker for any DB call. All ~17 modules use the same
single pg pool defined in `cowork-proxy/db.js`.

## 2026-05-01 · M5 · auth, output-renderers, pipeline-runner, afshin-router ported

- `auth.js` ported. Sync `middleware()` preserved (Express requires it)
  via cache-backed `isInitialized()`. `setPassword`, `login` async.
  `refresh()` does the boot-time async load. Reads `totp_secret` column
  too (placeholder for Track1#6 2FA work).
- `output-renderers.js` ported. `render()` stays sync (called inside
  pipeline output formatters). `setRendererForAgent` async.
- `pipeline-runner.js` ported (the 4 `_psql` calls). `savePipeline` and
  `deletePipeline` now async. Added comment noting Railway fs is volatile
  and pipelines DB will become source of truth in a future hardening.
- `afshin-router.js` 10 `_psql` calls replaced with `pg` queries.
  `gallery`, `approve`, `archive`, `setModelDefault` async. Cache for
  `image_model_defaults` so `getModelDefaults()` stays sync.
- Updated server.js callers: `/auth/set-password`, `/auth/login`,
  `/agent-models/defaults`, `/renderers/:agent`, `/pipelines POST/DELETE`,
  `/afshin/gallery`, `/afshin/approve/:id`, `/afshin/archive/:id`,
  `/afshin/models/defaults`.
- `services.js` left as-is (shells out to docker, not psql — local-dev
  only; cloud build will surface it as a managed-services health panel
  in a separate refactor).

15 of ~17 modules ported. Remaining: anthropic-chat (7), log-writer (11),
plus 3 inline `_psql` calls in server.js itself.

## 2026-05-01 · M4 · brand-profile + prompt-versions + tools/* tree ported

- `brand-profile.js` ported. `set` async; `get` and `renderAsPromptBlock`
  stay sync (called every LLM call). New `refresh()` for boot-time load.
- `prompt-versions.js` fully ported. SKILL.md history + rollback all
  async. Added comment about cloud volatility — agents/* SKILL.md will
  need re-materialising from DB on boot.
- `tools/db.js` rewritten as a thin pass-through to `../db.js`. `psql()`
  is now async and returns a Promise<string> matching the legacy shape.
- `tools/crypto.js` ported. `encrypt`/`decrypt` async; `encryptSqlExpr`/
  `decryptSqlExpr` stay sync (no DB I/O — pure SQL fragments).
- `tools/policy.js` ported. `_cacheGet` and `_cachePut` async.
- `tools/registry.js` `sync()` async. server.js boot path now does
  `toolsRegistry.sync().then(...)` instead of synchronous try/catch.
- `tools/runtime.js` fully ported. `getPermission`, `logStart`, `logEnd`,
  `bumpSpent`, `executeApproved`, `rejectCall` all async. The cloud build
  doesn't need the `INSERT 0 1` tag-strip workaround — pg returns just
  the value for RETURNING, so we removed `split(/[\r\n]+/)[0]`.
- `tools/router.js` 9 routes async-ified.
- `tools/adapters/rest.js` `_loadSecrets` async.
- `tools/adapters/mcp-http.js` `_loadSecrets` and `discoverOps` async.
- `tools/adapters/mcp-stdio.js` `_loadSecrets`, `_spawn`, and the persist
  step in `discoverOps` async.

12 of ~13 modules ported. Remaining: anthropic-chat, daneshyar-router,
compose-stages, afshin-router, log-writer, services. (`afshin-router`
has cost.js callers already done; the inline `_psql` is what's left.
`services.js` is the docker-control layer — also not strictly DB-bound.
`log-writer.js` is the largest remaining.)

## 2026-05-01 · M3 · agent-models, agent-memory, agent-evals, agent-handoffs ported

- `agent-models.js` ported. `setOverride` now async; `resolveModel` and
  `getOverrides` stay sync (hot-path resolution per LLM call). Added
  `refresh()` for the boot-time async load.
- `agent-memory.js` fully ported. K2 memory CRUD + recall + renderAsBlock
  all async. `summarizeForEpisodic` stays sync (no DB I/O).
- `agent-evals.js` fully ported. K3 ratings + corrections + examples
  + KPIs all async. `getKPIsAll` runs the per-agent KPI fetches
  concurrently via `Promise.all`.
- `agent-handoffs.js` fully ported. K4 handoff CRUD + approve/reject/
  redirect all async. `parseFromOutput` and `KNOWN_AGENTS` unchanged.

Updated callers in server.js: 21 routes touched (memory CRUD ×6, evals
CRUD + KPIs ×6, handoffs CRUD ×7, agent-models PATCH, compose memory
auto-write, KB renderAsBlock in compose).

7 of ~13 modules ported (cost, permissions, knowledge-base, agent-models,
agent-memory, agent-evals, agent-handoffs). Remaining: anthropic-chat,
compose-stages, daneshyar-router, afshin-router, brand-profile,
log-writer, prompt-versions, services, tools/db.

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
