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

## 2026-05-01 · M11 · Auth hardening (Track 1 #6 DONE)

Four security improvements + first 2FA implementation. All verified
end-to-end on the local Supabase.

**1. Login rate limit**
- `express-rate-limit` mounted on `POST /auth/login`. 5 attempts per 15
  minutes per IP. Sixth → 429.
- `app.set('trust proxy', 1)` in production so Railway's reverse-proxy
  IPs are unwrapped correctly for fingerprinting.

**2. Cookie hardening**
- New `auth.buildSessionCookie(name, value, opts)` helper.
- HttpOnly + `SameSite=Strict` always.
- `Secure` flag in production (when `NODE_ENV=production`).
- All four auth routes (`set-password`, `login`, `logout`) use it.

**3. CSRF gate**
- New `auth.csrfMiddleware` mounted globally after firstRunGate.
- State-changing requests (POST/PATCH/DELETE) must include
  `X-CSRF-Token` header matching the session's CSRF token (returned
  in the login response).
- Skips: GET/HEAD/OPTIONS · `AUTH_DISABLED=1` (dev) · pre-bootstrap
  (no password set yet) · requests with no auth token (other gates
  reject those).
- Constant-time compare via `crypto.timingSafeEqual`.

**4. TOTP 2FA**
- `setupTotp()` generates a 16-char base32 secret + a 6×6 QR data-URL
  + 10 recovery codes. Returned to the wizard; **not persisted** yet.
- `confirmTotpSetup({ secret, code, recoveryCodes })` verifies the
  first code, then persists:
    - `totp_secret`     bytea  (pgp_sym_encrypt with SECRETS_KEY)
    - `totp_recovery`   jsonb  (sha256-hashed recovery codes)
- `disableTotp()` clears both columns.
- `login(password, totpCode)` requires the second factor when
  `totp_secret` is set. Recovery codes are single-use (removed
  from the array after consumption).
- New routes: `POST /auth/2fa/setup` · `POST /auth/2fa/confirm` ·
  `POST /auth/2fa/disable` (all 🔒 auth-gated).

**Schema**: migration `20260515000000_first_run.sql` updated — `totp_secret`
column type changed from `text` → `bytea` (so `pgp_sym_encrypt` output
fits cleanly).

**Dashboard**: new `setAuthFromLogin()` helper stores both auth + CSRF
tokens in localStorage; `authFetch` and `authHeaders` now include
`X-CSRF-Token` automatically. `doLogin()` re-prompts for the 6-digit
code when the server returns `requires_totp: true`.

**Smoke tests (with AUTH_DISABLED toggled off):**
- Rate limit: 5×401 then 429 ✓
- CSRF gate (with token): 200 ✓
- CSRF gate (without): 403 ✓
- Cookie flags: `HttpOnly; Path=/; SameSite=Strict; Max-Age=N` ✓
- TOTP setup → confirm → login: ✓
- TOTP recovery code first-use ✓ / reuse-rejected ✓
- TOTP disable → plain password login works ✓

Track 1 #6 (auth hardening) is **DONE**.

## 2026-05-01 · M10 · Migration runner + first-run middleware (Track 1 #8 DONE)

The cloud build now self-provisions its schema on first deploy and
gates the dashboard until the founder finishes setup.

**Migration runner (`cowork-proxy/migrate.js`)**
- Reads `supabase/migrations/*.sql` in filename order. Tracks applied
  versions in a `schema_migrations(version, applied_at)` table.
- Each migration runs inside a transaction; on failure the runner
  ROLLBACKs and exits 1 (so Railway's release-command halts the deploy).
- CLI flags:
    `node migrate.js`            apply pending
    `node migrate.js --status`   list applied vs pending
    `node migrate.js --pretend`  dry run
    `node migrate.js --baseline` mark all local files as applied without
                                 running them (for adopting an existing DB)
- `migrate.runIfNeeded()` is called at boot (server.js) so a fresh
  Railway deploy provisions schema before serving its first request.
  Disable via `MIGRATE_ON_BOOT=false` env when you'd rather apply by hand.

**First-run gate (`firstRunGate` middleware in server.js)**
- Reads cached `dashboard_settings.first_run_done`. If false:
    - `Accept: text/html` → 302 redirect to `/setup`
    - JSON / fetch         → 503 `{ ok:false, error:'setup_required' }`
- Allowlist: `/health`, `/config.js`, `/setup*`, `/static`, `/storage`,
  `/auth/*`. Everything else (the dashboard, /tools, /agents, /kb, …)
  is gated until `first_run_done = true`.
- Cache TTL: 30s. Refreshed on boot and after `POST /setup/api/finish`.

**`/setup` placeholder UI** — single-page HTML (4.1 KB) that:
1. Probes /health, /auth/status to show what's set up
2. Captures founder password (delegates to `/auth/set-password`)
3. POSTs `/setup/api/finish` to flip `first_run_done`
4. Redirects to `/dashboard`
The polished 8-step wizard ships in Track 2 (next milestone).

**`/setup/api/*`** — JSON layer for the wizard:
- `GET  /setup/api/state`    cursor + flags
- `POST /setup/api/progress` save resumable state
- `POST /setup/api/finish`   mark first_run_done = true
- `POST /setup/api/reset`    🔒 re-engage gate (debug)

**Schema migration `20260515000000_first_run.sql`** adds:
- `first_run_done   boolean default false`
- `setup_progress   jsonb   default '{}'`
- `totp_secret      text`               (placeholder for Track 1 #6)
- `totp_recovery    jsonb   default '[]'`
- `founder_email    text`

**Smoke test (local Supabase, fresh first_run_done = false):**
- `GET /dashboard` (Accept: html) → 302 /setup ✓
- `GET /dashboard` (Accept: json) → 503 setup_required ✓
- `GET /setup`                    → 200 HTML, 4.1 KB ✓
- `GET /setup/api/state`          → JSON cursor + flags ✓
- `GET /tools` (gated)            → 503 ✓
- `GET /health` (allowlisted)     → 200 ✓
- `POST /setup/api/finish`        → flips done ✓
- `GET /tools` (after finish)     → 200 with 13 tools ✓
- Migration runner on boot logged: `already up to date (17 applied)` ✓

Track 1 #8 (migration runner + first-run middleware) is **DONE**.

## 2026-05-01 · M9 · Cloudflare R2 storage layer (Track 1 #2 DONE)

Volatile-fs problem solved. All file uploads now flow through a single
storage abstraction that picks R2 in cloud and disk in dev.

- New **`cowork-proxy/storage.js`** — S3-SDK-backed adapter with a
  local-disk fallback. Public API: `put`, `get`, `remove`, `exists`,
  `urlFor`, `serveHandler`. Backend auto-detected from env (`R2_*`
  vars present → R2; otherwise local under `.local-storage/`).
- Key naming convention exposed via `storage.KEYS`:
    avatars/<agent>.<ext>
    media/drafts/<id>.svg
    media/renders/<id>.png
    kb/uploads/<id>/<filename>
- Express route **`GET /storage/*`** mounted in server.js — streams
  any object back. Used for the local-fallback path and as an
  authenticated read path for private R2 buckets. When `R2_PUBLIC_URL`
  is set (custom domain like `media.rxapply.com`), the dashboard
  fetches assets directly from the CDN instead.

**Avatars refactored** (server.js):
- New `dashboard_settings.avatars` jsonb column (migration
  `20260514000000_avatars_index.sql`) maps agent → ext. Replaces the
  on-disk directory scan with a single DB read.
- Avatar upload now: `storage.put(KEYS.AVATAR(name, ext), buf)` →
  index update → return `storage.urlFor(...)`.
- Avatar delete: `storage.remove(...)` → index update.

**Afshin draft + render** (afshin-router.js):
- SVG drafts: `storage.put(KEYS.DRAFT(id), svg)` instead of
  `fs.writeFileSync(DRAFTS_DIR/...)`.
- PNG renders: same pattern.
- `gallery()` now adds `draft_url` and `render_url` (resolved via
  `storage.urlFor`) to each row. Legacy on-disk paths
  (`assets/generated/...`) still resolve via express.static for
  backward-compat with the local sandbox.

**dashboard.html** updated: prefers `d.draft_url`/`d.render_url`
when present, falls back to the legacy `${PROXY}/${path}` shape.

**Smoke test (local fallback, no R2 creds):**
- POST /agents/test/avatar → key `avatars/test.png`, 70 bytes ✓
- /agents/avatars returns the index ✓
- GET /storage/avatars/test.png → 200, image/png, file present ✓

Track 1 #2 (R2 storage) is **DONE**. Cloud build can now survive a
Railway redeploy without losing avatars, drafts, or renders.

## 2026-05-01 · M8 · Dockerfile + railway.json + Procfile (Track 1 #4+#5 DONE)

Containerised the cloud build. First deployable artefact.

- **`Dockerfile`** (repo root) and **`cowork-proxy/Dockerfile`** (kept in
  sync) — two-stage build. Stage 1: node:20-bookworm-slim + Python 3 +
  build-essential, runs `npm ci --omit=dev` + `pip install -r` for any
  agent's `requirements.txt`. Stage 2: stripped-down runtime with just
  Python 3 (for KB extract.py and helper scripts).
- Image runs as non-root `rxapply` user. `HEALTHCHECK` hits `/health`
  every 30s with 5s timeout.
- **`railway.json`** — pins the Dockerfile builder, sets healthcheck
  path/timeout, `restartPolicy: ON_FAILURE` (5 retries).
- **`Procfile`** — fallback for hosts that prefer Procfile over Dockerfile.
- **`.dockerignore`** — excludes `node_modules`, logs, `.env*`,
  legacy V1 HTML files, and OneDrive cruft. Whitelists `dashboard.html`,
  `architecture.html`, agent SKILL.md.
- **`db.js` SSL detection improved.** Three signals now:
    1. `?sslmode=disable` URL param → SSL OFF
    2. `?sslmode=require/verify-*/prefer` → SSL ON
    3. Hostname `localhost`/`127.0.0.1`/`host.docker.internal`/`[::1]`
       → SSL OFF
    4. Anything else → SSL ON (Supabase Cloud, RDS, Neon, …)

**Local build + run test:**
- `docker build -t rxapply-cloud:test .` succeeded; image 482 MB.
- Ran the container with DATABASE_URL pointing at host's local Supabase
  via `host.docker.internal:54322`. Results:
    - `/health` 200 with `llmTransport: anthropic-api-direct` ✓
    - `/tools` returned the 13-entry catalog ✓
    - `/dashboard` 200 (HTML served) ✓
    - tools registry synced 13 rows to Postgres ✓
    - Zero startup errors ✓

Track 1 #4 (secrets out of `.bat` into env vars) was already done in
the initial commit (start-proxy.bat scrubbed; `.env.example` rewritten
for the cloud stack). Track 1 #5 (Dockerfile + railway.json) is done now.

## 2026-05-01 · M7 · `claude` CLI subprocess removed (Track 1 #3 DONE)

- `runClaude()` in server.js was the only use of `spawn('claude' …)`.
  Rewritten as a direct Anthropic API call using `fetch`. Same in/out
  shape so the two callers (`/run-agent`, `/run-agents-parallel`) work
  unchanged.
- Added `MODEL_ALIASES` map: shorthand `sonnet`/`opus`/`haiku` (which
  the old CLI accepted) resolve to current snapshots:
    sonnet → claude-sonnet-4-5-20250929
    opus   → claude-opus-4-7
    haiku  → claude-haiku-4-5-20251001
  Anything else passes through unchanged so a caller can ask for a
  specific model snapshot directly.
- Removed `CLAUDE_BIN` env var + `claudeBin` field from `/health`
  (no longer meaningful; replaced with `llmTransport: 'anthropic-api-direct'`).
- Boot log now reads `llm=anthropic-api-direct`.
- Boot test: cloud proxy listened on :7779, `/health` returned 200
  with the new fields, zero startup errors.

Track 1 #3 (drop CLI subprocess) is **DONE**. Cloud build now has
zero subprocess spawns for LLM work — Python helpers are the only
remaining child processes (still needed for KB extract.py and
agent-helper scripts).

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
