# RxApply Test-Phase — Status

Last updated **2026-05-01** end of V2.5. The local stack now ships a complete Compose-for-Instagram flow with a per-step pipeline (Pooya → compose-ig → Kherad → Afshin), per-agent LLM model selection, and a central Brand profile injected into every prompt.

---

## TL;DR

| Layer | What's live | How to verify |
| --- | --- | --- |
| Local stack | Supabase + n8n + MailHog + cowork-proxy, all on Docker | `verify.bat` · MailHog now on port **8125** (Windows reserves 7932–8031) |
| Schema | **23 Postgres tables** (16 baseline + agent_journal + 6 V2 + V2.5 column additions) | `smoke-v2.bat` step 2 |
| Agents | **23 agents** (21 plan-v3 + Afshin + compose-ig) | direct CLI: `python agents/<name>/<name>.py help` |
| Workflows | 5 n8n cron/webhook JSONs · all 5 runnable on demand via simulated-cron | Workflows panel → click ▶ on each |
| Dashboard | One consolidated `dashboard.html` · also served at `http://localhost:7777/dashboard` | open it; `auth: off` in the topbar means AUTH_DISABLED=1 in .env |
| Proxy | **50+ routes on `:7777`** spanning F2–F9 + V2.5 features | `/health` |
| Compose | type a topic → 3 IG captions in en/fa/ar with copy buttons + design plan + image | Compose sidebar item · ~$0.08 per topic |
| LLM models | per-agent overrides (Opus 4.7 / Sonnet 4.6 / Sonnet 4.5 / Haiku 4.5 / Opus 4.6) | Settings → Per-agent LLM model |
| Brand profile | single jsonb in `dashboard_settings.brand_profile` injected into every agent prompt | Settings → Brand profile |

If something isn't green, run `smoke-v2.bat` and read the FAIL lines.

---

## Architecture in one breath

n8n is **only** a trigger surface. It fires on schedule or webhook and HTTP-POSTs to `cowork-proxy:7777`. The proxy is the load-bearing **control plane** — it spawns Python helpers (DB shuttles), calls the Anthropic API directly for LLM work (compose-ig, Afshin drafts, F5 chat, Pooya brief, Kherad score), enforces auth + cost cap + per-agent model resolution + brand profile injection, and serves the dashboard. Postgres is reached via `docker exec psql`. Every agent invocation ends with a row appended to `agent_journal` via Zirak.

**Two writer-wrapper agents anchor the data layer.** `Zirak` is the only sanctioned writer for `agent_journal`. `Paya` is the only sanctioned writer for `intel_snapshots` — it validates payload shape per `kind` so Pooya can trust what she reads.

**No autonomous external action.** Every email is sent to local MailHog (`:1025`). Every social post writes a `ready_to_post` (Compose) or `dry_run_logged` (cron-cross-post) row to `scheduled_posts`. Every outreach draft sits at `pending_human_review` inside `partnerships.outreach_drafts`. Nothing goes out without a founder click. The schema is forecast-ready for auto-posting (columns: `posted_url`, `posting_provider`, `posting_error`, `posted_at`).

**LLM gateway is the proxy, not the helpers.** Per Anthropic API best-practice we route all LLM calls through the proxy with central rate-limiting, cost cap, brand injection, and per-agent model resolution. The legacy `/run-agent` shell-out to `claude --print` (Cowork CLI) is preserved but unused by V2.5 features.

---

## The 21 agents

### Content pipeline (4)

| Agent | Role | Output table |
| --- | --- | --- |
| **Pooya** | Intel → 3 weekly editorial briefs | `content_briefs` |
| **Sepehr** | Brief → 1500-word EN master | `content_assets` (lang=en, kind=master) |
| **Goyesh** | EN master → FA + AR translations | `content_assets` (lang=fa, ar) |
| **Avang** | Master → 11 platform fan-outs | `scheduled_posts` |

### Quality + governance (3)

| Agent | Role | Drives |
| --- | --- | --- |
| **Kherad** | Score `pending_g2` assets, write `corrections` | G2 gate |
| **Bidar** | Nightly efficiency rollups + recommendations | `agent_efficiency` |
| **Davari** | n8n flow-health audit | dashboard alerts |

### Lead lifecycle (4)

| Agent | Role | Output |
| --- | --- | --- |
| **Rahnama** | Destination Advisor scoring (3 personas) | scoring write-back |
| **Rahbar** | Lead-ingress nurture enrollment | `nurture_schedule` |
| **Bineh** | Engagement score 0–1 + top signals | per-lead score |
| **Mehrban** | Farsi DM reply with disclaimer | DM artifact |

### Intelligence (5, all write `intel_snapshots`)

| Agent | Snapshot kind | Source signal |
| --- | --- | --- |
| **Roya** | `market_heatmap` | local leads/customers, last 14d |
| **Shahed** | `competitor_diff` | local fixture vs. last snapshot |
| **Dadbeh** | `regulatory_change` | seeded 2026 events, ±90d window |
| **Nasim** | `trend_spike` | `engagement_events` 3d vs. 14d |
| **Ramin** | `keyword_candidates` | cross-product of the four above |

### Operations (5)

| Agent | Role | Output |
| --- | --- | --- |
| **Zirak** | Append-only journal writer | `agent_journal` |
| **Paya** | Intel-snapshot writer + validator | gates writes to `intel_snapshots` |
| **Ravi** | Monday narrative email | MailHog |
| **Payvand** | Partnership outreach drafter | `partnerships.outreach_drafts` |
| **Mehmandar** | Guest-pipeline curator + digest | `guest_pipeline` + MailHog |

### Cross-post runner (1)
| Agent | Role | Output |
| --- | --- | --- |
| **cross-post** (dryrun.py) | Tick scheduled posts due → DRY_RUN log | `scheduled_posts.status` advances |

### Design pipeline (V2 / 1)
| Agent | Role | Output |
| --- | --- | --- |
| **Afshin** | Claude SVG draft + multi-provider PNG render | `media_library` |

### Compose synthesizer (V2.5 / 1)
| Agent | Role | Output |
| --- | --- | --- |
| **compose-ig** | Topic + brief → 3 IG captions (en/fa/ar) + design plan in one Anthropic call | JSON consumed by Compose viewer |

---

## The 23 tables

**Originals (16):** leads, customers, consultations, content_briefs, content_assets, engagement_events, corrections, partnerships, guest_pipeline, intel_snapshots, agent_runs, agent_efficiency, approval_queue, n8n_executions, scheduled_posts, nurture_schedule.

**V1 added:** `agent_journal` (Zirak — append-only log for the activity feed).

**V2 / Phase F added (6 tables + columns):** `agent_actions` (F2 sub-step rows), `prompt_versions` (F7 SKILL.md history), `agent_chats` (F5 streaming chats), `dashboard_settings` (F7+F8b+F9 singleton — auth, cap, image_model_defaults), `media_library` (F8 designs), `pipelines` (F6 Drawflow graphs).

**V2.5 added (columns only — no new tables):**
- `media_library` gained: `design_plan`, `captions`, `plan_approved_at`, `plan_approved_by`, `slide_index`, `parent_media_id` (last two forecast-ready for carousels).
- `scheduled_posts` gained: `compose_media_id`, `approved_for_posting_at`, `approved_for_posting_by`, `posted_url`, `posted_at`, `posting_provider`, `posting_error` (last four forecast-ready for auto-post via Meta Graph / Publer / MCP).
- `dashboard_settings` gained: `agent_models jsonb` (per-agent LLM overrides), `brand_profile jsonb` (central brand spec).

**Migrations applied (in order):** `20260429_initial_schema`, `20260430_agent_journal`, `20260501_logs_l2`, `20260502_prompts_chats`, `20260503_media_library`, `20260504_image_model_defaults`, `20260505_compose_ig`, `20260506_per_agent_models`, `20260507_brand_profile`.

---

## One consolidated dashboard (V2)

`dashboard.html` is now the single operator surface. The V1 `dashboard.html` (test scorecard) and `admin-dashboard.html` (operations) were merged. Sections in the sidebar:

**Operate**
- **Overview** — RUNS TODAY · PENDING APPROVALS · ACTIVE LEADS · SPEND (30D) · activity feed · service health
- **Services** — start/stop Supabase, n8n, MailHog from the UI
- **Workflows** — the 5 n8n workflows · ▶ Run · activate/deactivate · import-from-library

**Run**
- **Agents** — 23 cards · per-agent Run / Chat (Anthropic streaming) / History / Forward tabs
- **Pipelines** — Drawflow visual editor · drag agent/conditional/transform/output nodes · save graphs · run with SSE log
- **Compose** (V2.5) — type a topic → Pooya brief → compose-ig captions → Kherad score → 3-card output viewer with copy buttons

**Inspect**
- **Logs** — L2 with Input / Actions / Output / Stderr / Errors tabs per run · downloadable bundles
- **Approvals** — `approval_queue` rows with Approve/Reject

**Build**
- **Designs** — Afshin gallery · per-card Render PNG / Approve / Archive · multi-model picker
- **Settings** — auth (or AUTH_DISABLED) · sandbox mode · monthly cap · per-kind image model defaults · **per-agent LLM model** (V2.5) · **Brand profile** (V2.5) · prompts editor with rollback

**Reference**
- Phase F plan · Architecture · STATUS · plan-v3 anchors

Auto-refresh: cost widget every 30s, /health every 15s.

---

## The 5 n8n workflows

All in `n8n-workflows/`, imported via `import-n8n-workflows.bat`. They're imported as **inactive** — toggle each one on in the n8n UI after sanity-checking the cron expression and HTTP target.

| File | Trigger | Action |
| --- | --- | --- |
| cron-bidar-nightly.json | `0 2 * * *` | `POST /run-helper {bidar, run}` |
| cron-ravi-monday.json | `0 9 * * 1` | Ravi fetch → Ravi send (MailHog) |
| cron-intel-daily.json | `0 6 * * *` | Roya → Shahed → Dadbeh → Nasim → Ramin (chained) |
| cron-cross-post-5min.json | `*/5 * * * *` | `POST /run-helper {cross-post, run}` |
| webhook-lead-form.json | `POST /webhook/lead-form` | Forward body to `{rahbar, enroll-all}`, respond 202 |

The proxy URL is `http://host.docker.internal:7777/run-helper` — works on Windows Docker Desktop and Mac. On Linux you may need to swap to the host bridge IP.

---

## Costs

The test stack itself runs on $0/month for infrastructure (Supabase + n8n + MailHog all local).

**Anthropic API (V2.5):**
- One Compose run (Pooya + compose-ig + Kherad on default Sonnet 4.5) ≈ **$0.08**
- F5 chat per turn ≈ $0.01–0.05
- Afshin SVG draft ≈ $0.005
- Afshin PNG render (gpt-image-1) ≈ $0.04 — billed to OpenAI not Anthropic

**Realistic monthly:**
- Today (you exploring): **$2–8/mo** on Anthropic API
- M3 launch (real content, ~10 posts/wk): **$15–30/mo**
- Steady-state full plan-v3: **$60–150/mo**

**Cost cap:** Set in Settings → Monthly cap (default $25). `canSpend()` hard-blocks Anthropic + Afshin render calls when month-to-date hits the cap. Topbar widget polls every 30s.

**Per-agent model overrides** (Settings → Per-agent LLM model) let you cut cost by ~5× for routine agents (Zirak, Paya, Mehrban, Bineh, Rahbar → Haiku 4.5) while keeping flagship-quality on the agents that compound (Pooya, Sepehr, Kherad → Opus 4.7).

---

## What's intentionally not here yet

- **Production triggers from n8n to real platforms** — every agent that would post to Instagram/Telegram/Email is gated to MailHog (Ravi, Mehmandar) or `dry_run_logged` / `ready_to_post` (Avang, Compose). Schema is forecast-ready (`posted_url`, `posting_provider`, `posting_error`). When you flip the switch (Meta Graph / Publer / MCP server), no migration needed.
- **Paid intel sources.** Roya/Shahed/Dadbeh/Nasim/Ramin in production would each pull from SerpAPI / Telegram API / regulatory RSS. Locally each one explicitly notes "(local-signals only)" in its snapshot summary so a downstream reader knows the limitation.
- **The 18 missing plan-v3 destinations / 4 missing languages.** Compose currently supports en/fa/ar; tr/hi/es/ko deferred to M-real-build. 9 destination Guides (UK→Saudi) deferred too — the Compose flow scales there with no changes.
- **Real RBAC.** The dashboard talks to Supabase REST with the local-only secret key — fine for `localhost`, never for a deployed instance. AUTH_DISABLED=1 is dev-mode only.
- **Public-facing site / Destination Advisor quiz UI.** None of the customer-facing surfaces (Next.js site, RTL routing, advisor quiz public form) exist yet. Plan-v3 §6 M1.

---

## Cold-start quickref

```
# 1. Bring up the stack
docker start n8n-test mailhog-test           # if not auto-started
                                              # (note: mailhog now on host port 8125)
start-v2.bat                                  # applies all migrations + starts proxy

# 2. Smoke test
smoke-v2.bat                                  # 11 checks across F2–F9 + V2.5

# 3. Open the dashboard
http://localhost:7777/dashboard               # served via proxy (preferred)
# or                                          (file:// also works)
file:///.../rxapply-test/dashboard.html
```

**Bypass sign-in (dev only):** `AUTH_DISABLED=1` already in `.env`. Topbar shows "auth: off" in amber.

**Try Compose:** Compose sidebar → type "NDEB AFK pass rates 2025" → Generate → ~60s later 3 cards appear with copy-ready captions in en/fa/ar.

---

## Phase log

| Phase | Items | Status |
| --- | --- | --- |
| Test Phase | T1–T12 scenarios | ✅ 12/12 PASS |
| A → E | foundation · admin dashboard · 10 agents · n8n workflows · polish | ✅ 28/28 closed |
| V2 / Phase F | F2–F9 + F8b (logs · services · n8n · chat · pipelines · auth · designs · multi-model · cost) | ✅ shipped |
| Report v.1 hardening | 21 audit fixes (route order · UTF-8 · auth cache · sandbox eval · etc.) | ✅ all actionable closed |
| **V2.5** | **Compose (Pooya→compose-ig→Kherad) · per-agent LLM · Brand profile** | **✅ shipped** |

The next concrete step toward revenue is what plan-v3 calls M1 — public site + Destination Advisor quiz + 3,000-list reactivation. The internal stack is ready; what's missing is customer-facing surfaces. See `next-steps.html` for the post-V2.5 path.
