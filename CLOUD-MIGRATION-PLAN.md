# Cloud Migration · Plan & Tracker

This is the source-of-truth plan for taking RxApply from the local
`rxapply-test/` sandbox to a live deployment on **rxapply.com**. It is
read-only history once a step is checked off — every change has a
matching commit, every commit has a line in `MIGRATION-LOG.md`.

The local `rxapply-test/` folder is **untouched** and remains the
working dev environment. This (`rxapply-cloud/`) is the cloud-deploy
copy.

---

## 0 · Locked-in stack

| Concern | Choice |
|---|---|
| Domain | **rxapply.com** (apex = dashboard, `api.rxapply.com` reserved) |
| App host | **Railway** (push-to-deploy from GitHub) |
| Database | **Supabase Cloud** (managed Postgres, free tier to start) |
| File storage | **Cloudflare R2** (S3-compatible, free 10 GB) |
| DNS / TLS | **Cloudflare DNS** in front of Railway |
| LLM transport | **Direct Anthropic API** (drop the `claude` CLI) |
| Secret management | Railway env vars + Postgres `pgcrypto` for tool credentials |
| Auth | Founder password (bcrypt) + **TOTP 2FA** + rate-limit + HTTPS-only cookie |
| Repo | `github.com/Hojatam/rxapply-cloud` (private) |

---

## 1 · Track 1 · Make the cloud copy deployable

Each item ships independently. Order optimised so we can deploy a
working v0 to Railway as early as possible (item #5), then layer.

| # | Task | Status | Commit(s) | Notes |
|---|---|---|---|---|
| 1 | Replace `docker exec psql` with `pg` (node-postgres) client | ☐ todo | — | Largest single change. New `cowork-proxy/db.js`. Refactor every `_psql()` caller to async/await. |
| 2 | Replace local-disk file writes with Cloudflare R2 | ☐ todo | — | Avatars, KB uploads, Afshin renders. New `cowork-proxy/storage.js`. |
| 3 | Replace `claude` CLI subprocess with direct Anthropic API | ☐ todo | — | `compose-stages.js`, `pipeline-runner.js`. Cheaper *and* deploy-able. |
| 4 | Move secrets from `start-proxy.bat` to env vars | ☐ todo | — | `Procfile` replaces the `.bat`. SECRETS_KEY, ANTHROPIC_API_KEY, etc. |
| 5 | Add `Dockerfile` + `railway.json` | ☐ todo | — | Defines build/run. Includes Python 3 (for KB extract.py). |
| 6 | Auth hardening: rate-limit + CSRF + HTTPS-only cookie + TOTP 2FA | ☐ todo | — | `auth.js` + `server.js` middleware. New `totp_secret` column on `dashboard_settings`. |
| 7 | First-run detection + redirect to `/setup` | ☐ todo | — | Tiny middleware. `dashboard_settings.first_run_done`. |
| 8 | Migration runner (idempotent SQL apply) | ☐ todo | — | New `cowork-proxy/migrate.js`. Tracks applied versions in `schema_migrations`. Hooked into Railway release command. |
| 9 | DNS + TLS + first live deploy | ☐ todo | — | Cloudflare DNS → Railway. Auto TLS. |

---

## 2 · Track 2 · "Easy to Start" wizard

8 steps + 2FA. Founder lands on a fresh `rxapply.com` deploy and reaches a working
dashboard in **<10 minutes**, **zero terminal use**. Save-and-resume
between steps; re-runnable from Settings.

| Step | Title | Required? | Behind the scenes |
|------|---|---|---|
| 1 | Welcome / preflight checks | yes | Verifies env vars + DB + R2 reachability. Shows ✓/✕ per check with fix instructions if any fail. |
| 2 | Founder credentials (email + password) | yes | bcrypt hash → `dashboard_settings`. Sets HTTPS-only session cookie. Strength meter. |
| 2.5 | **2FA via TOTP** | optional | Generates secret, shows QR, verifies a 6-digit code before saving. Recovery codes printed once. |
| 3 | Anthropic API key | yes | "Test" button calls `/v1/messages` with 5 tokens to verify. Stored encrypted. |
| 4 | Database (Supabase Cloud or Railway PG) | yes | "Run setup migrations" → applies all 14 SQL files in order. Per-migration progress bar. |
| 5 | Brand profile | optional | Name, tagline, languages (multi-select), brand colors, logo upload. Writes `brand_profile`. Logo → R2. |
| 6 | Team avatars | optional | `team.jpg` sprite upload (auto-compressed). Optional per-agent custom avatars (drag multiple, auto-match by filename). |
| 7 | Connect tools | optional (skippable) | Cards for Tavily / Perplexity / IG / Buffer. Each = paste key + test. Behind the cards is the existing Tools framework. |
| 8 | Ready | yes | Sets `first_run_done = true`. Redirects to `/#/overview`. |

Sample data: **off** (per founder decision).

---

## 3 · Order of operations · daily checkpoints

Each milestone ends with a green smoke test + git commit + push.

- **Day 1 AM** — Track 1 #1 (pg layer port).
- **Day 1 PM** — Track 1 #3 (drop CLI), #4 (env vars).
- **Day 2 AM** — Track 1 #5 (Dockerfile + Railway scaffold) + first deploy attempt.
- **Day 2 PM** — Track 1 #2 (R2 storage), #8 (migration runner).
- **Day 3 AM** — Track 1 #7 (first-run middleware) + Track 2 wizard backend.
- **Day 3 PM** — Track 2 wizard UI (steps 1, 2, 2.5, 3).
- **Day 4 AM** — Track 2 wizard UI (steps 4–8).
- **Day 4 PM** — Track 1 #6 (auth hardening) + #9 (DNS cutover) + end-to-end smoke.

Total: **~3.5 working days.**

---

## 4 · Risk register

| Risk | Mitigation |
|---|---|
| OneDrive sync conflicts during git operations | Work happens in `rxapply-cloud/` which is OneDrive-synced; git internals are still safe (no merge issues seen so far) but if it ever bites us, move to `C:\dev\rxapply-cloud` outside OneDrive. |
| Railway free tier hits limit | $5/mo Hobby plan covers ~500 hrs. Upgrade trigger: any sustained outage. |
| Supabase free tier (500 MB / 2 GB transfer) too small at launch | Migrate to Pro ($25/mo) the moment we cross 50 active brand events / week. |
| Anthropic API rate limits | Existing global $/mo cap (cost.js) already gates this. Add per-minute concurrency cap if seen in production. |
| Iran block-list issues for Iranian IG candidates | Cloudflare DNS bot-fight mode OFF for `rxapply.com`. Use Railway-issued TLS, not Cloudflare proxy mode (orange cloud OFF). |
| 2FA lockout if founder loses authenticator | Recovery codes generated in step 2.5 are printed once, stored encrypted, downloadable as a file. |
| Production secret leakage in logs | Existing `args_redacted` pattern in tool_calls. Audit log-writer.js to ensure no env-var values ever hit stdout. |

---

## 5 · Backup strategy

| Layer | Backup |
|---|---|
| **Local working code** | `rxapply-test/` is the canonical local sandbox — never modified by this migration. |
| **Cloud copy code** | `rxapply-cloud/` is git-versioned. Every change is a commit. Pushed to private GitHub immediately after each milestone. |
| **Database (Supabase Cloud)** | Free tier: nightly snapshots (7-day retention). Pro tier: PITR. Manual `pg_dump` weekly to a local file before launch. |
| **R2 storage** | Cloudflare's underlying durability is 99.999999999%. Add an Object Lifecycle rule to keep deleted versions for 30 days. |
| **Configuration / secrets** | Railway env vars: exported to a local encrypted file (`.env.production.gpg`) once a week with `gpg --symmetric`. |

---

## 6 · Done = ?

We declare migration complete when **all** of the following are true:

- [ ] `https://rxapply.com` loads the dashboard with valid TLS.
- [ ] Login + 2FA works end-to-end.
- [ ] All 14 migrations applied to Supabase Cloud.
- [ ] Daneshyar can answer a Tavily-grounded question.
- [ ] Afshin can produce a draft + a render, stored in R2.
- [ ] Inbox approval flow works for a tool call.
- [ ] Cost cap enforced (existing tests pass against cloud DB).
- [ ] `pg_dump` of production DB succeeds and restores cleanly into a local Postgres.
- [ ] Wizard takes a stranger from "Railway project deployed" to "first agent ran" in under 10 minutes.
