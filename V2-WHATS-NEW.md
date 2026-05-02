# V2 — what's new (Phase F)

The V1 dashboards and the helper architecture are unchanged. V2 adds a
single unified control plane on top, the L2 logs layer, prompt
versioning, service control, n8n workflow management, agent chat (with
Anthropic), cost telemetry + monthly cap, and Afshin (the design agent).

The only deliverable still in the backlog is **F6 — the Drawflow visual
pipeline editor** (heaviest item; deferred to a follow-up session).

---

## TL;DR — first thing to do

```
start-v2.bat
```

That applies the three new migrations, restarts cowork-proxy, runs
`smoke-v2.bat`, and prints PASS/FAIL across all of phase F. Then open
`dashboard.html` in a browser.

If any check fails, the smoke output names the migration to apply.

---

## What landed

### F1 — Workspace skeleton + plan doc
- New `dashboard.html` (single page, 9-section sidebar layout, replaces both old dashboards)
- Old dashboards kept as `dashboard-v1.html` and `admin-dashboard-v1.html` for reference
- `move-to-c-dev.bat` — safely moves the workspace from OneDrive to `C:\dev\rxapply-test\` (run when ready; build-in-place works fine on OneDrive in the meantime)
- `phase-f-v2-plan.html` — the locked plan as an interactive document

### F2 — Logs L2 (full I/O capture)
- Migration `20260501000000_logs_l2.sql`: `agent_runs` gets `input_payload`, `output_payload`, `error_payload`, `log_file_path`, `cost_usd_actual`. New table `agent_actions` for per-step logging.
- `cowork-proxy/log-writer.js`: every `/run-helper` invocation now writes a row in `agent_runs` at start, updates at end, dumps raw `stdout` + `stderr` files to `logs/YYYY-MM-DD/<agent>-<runid>.{json,stdout,stderr}`. 30-day retention, gzip after 7 days, automatic cleanup at proxy startup.
- New routes: `GET /logs?agent=&status=`, `GET /logs/:runid`, `GET /logs/:runid/download`.
- Dashboard "Logs" panel: searchable table; click a row to expand into Input · Actions · Output · Stderr · Errors tabs; download bundle as JSON.

### F3 — Service control
- `cowork-proxy/services.js` — manages Supabase (via CLI), n8n + MailHog (via `docker`), and the proxy itself.
- Routes: `GET /services`, `POST /services/:name/{start|stop|restart}`. Stop/start gated by auth (F7).
- Dashboard "Services" panel: 4 cards with toggle, status, health-URL probe, last action.
- Cowork-proxy refuses to stop itself — Ctrl+C in the proxy terminal. (Mid-request self-stop would kill the response.)

### F4 — n8n workflow control
- `cowork-proxy/n8n-control.js` — wraps the n8n REST API.
- Requires `N8N_API_KEY` in `.env` (create in n8n UI → Settings → API). Without it, every n8n route returns a clear "key not set" error.
- Routes: `GET /n8n/workflows`, `PATCH /n8n/workflows/:id/active`, `POST /n8n/workflows/:id/run`, `POST /n8n/workflows/import`, `GET /n8n/executions`.
- Dashboard "Workflows" panel: list with toggle + run-now buttons, library import from `n8n-workflows/`, recent executions feed.

### F5 — Agent chat (Anthropic streaming)
- `cowork-proxy/anthropic-chat.js` — Server-Sent Events wrapper around `https://api.anthropic.com/v1/messages` with `stream:true`.
- Each chat sends the agent's `SKILL.md` + last 10 `agent_runs` rows + prior chat messages as system context, then the user's message.
- Persisted to new `agent_chats` table (Q7). Each chat gets a title from the first message.
- Routes: `POST /agent/:name/chat` (SSE), `GET /agent/:name/chats`, `GET /agent/:name/chats/:chatId`.
- Dashboard "Agents" panel: 22-tile grid grouped by division. Clicking a tile opens a 5-tab detail pane: **Skill** (read-only SKILL.md), **Run** (form-driven helper invocation with output streaming), **Chat** (streaming Q&A with Claude), **History** (last 50 runs), **Forward** (linear hand-off mapping per architecture contracts).

### F7 — Settings + prompt versioning + sandbox toggle
- Migration `20260502000000_prompts_chats.sql`: `prompt_versions`, `agent_chats`, `dashboard_settings` (singleton).
- `cowork-proxy/auth.js` — single-user password auth via scrypt + in-memory session map. 4-hour token, configurable in Settings. Bootstrap: until first password is set, Settings is open with a "Set password" form.
- `cowork-proxy/prompt-versions.js` — every `PUT /prompts/:agent` now writes a version row before saving.
- Routes: `POST /auth/{login,logout,set-password}`, `GET /auth/status`, `GET/PATCH /settings`, `GET /prompts/:agent/versions`, `POST /prompts/:agent/rollback`.
- Dashboard "Settings 🔒" panel: bootstrap → login → main view with sandbox toggle, monthly cap, session hours, API key indicators (env-only, never persisted), and the prompts editor with version history + rollback.

### F8 — Afshin (design agent #22)
- Migration `20260503000000_media_library.sql`: gallery + lifecycle for design assets.
- New agent `agents/afshin/{SKILL.md, afshin.py}` — minimal CLI for inspecting media_library; design generation lives in the proxy.
- `cowork-proxy/afshin-router.js`:
  - **Draft mode** — Claude generates an SVG mock for the requested kind + topic. Saved to `assets/generated/drafts/<id>.svg`. ~$0.005 per draft.
  - **Render mode** — gpt-image-1 produces final raster PNG (only when `OPENAI_API_KEY` is set). Saved to `assets/generated/renders/<id>.png`. ~$0.05 per render. Gated on `approved=true`.
- Five kinds: `ig_carousel_slide` (1080×1080), `telegram_cover` (1280×720), `youtube_thumb` (1280×720), `web_banner` (1920×600), `email_header_ravi` (600×200).
- Routes: `POST /afshin/draft`, `POST /afshin/render/:id`, `POST /afshin/approve/:id`, `POST /afshin/archive/:id`, `GET /afshin/gallery`. Generated assets served read-only from `/assets/generated/*`.
- Dashboard "Designs" panel: kind/status filters, gallery grid with inline SVG previews, "+ New design" modal, per-card Approve/Reject/Render/Download actions.

### F9 — Cost telemetry + monthly cap
- `cowork-proxy/cost.js` aggregates from `agent_runs.cost_usd_actual` + `agent_chats.total_cost`.
- Route: `GET /cost` returns `{ today, week, month, all_time, cap, pct_of_cap, over_cap, near_cap }`.
- Anthropic chat AND Afshin draft+render call `cost.canSpend(estimated)` first; if cap exceeded, the call is refused with HTTP 402.
- Dashboard topbar widget polls `/cost` every 30s. Bar turns amber at 80%, red at 100%.
- Cap is editable in **Settings → General** (default $25/mo).

### F10 — smoke-v2.bat
- 12 checks across all of phase F. Run via `start-v2.bat` or directly. Shows PASS/FAIL with hints.

---

## What you need to do once

```
start-v2.bat
```

That's it. Apply migrations, restart proxy, smoke test in one go.

After that:

1. **Open `dashboard.html` in a browser** (file:// is fine; uses Authorization header instead of cookies).
2. **Go to Settings 🔒 → set a password** (first time only). You're auto-logged in.
3. **Drop any keys** you have into `cowork-proxy/.env`:
   - `ANTHROPIC_API_KEY=sk-ant-…` enables F5 chat + F8 draft. (You said you have this.)
   - `OPENAI_API_KEY=sk-…` enables F8 render mode. (Optional — Afshin still drafts without it.)
   - `N8N_API_KEY=…` enables F4 workflow control. Create in n8n UI → Settings → API.
   Restart proxy after editing `.env`.

---

## Open follow-up

**F6 — Drawflow visual pipeline editor** (~7h) is intentionally deferred — it's the heaviest item and needs the rest of phase F to be settled first. Linear pipeline chaining is already possible via the **Forward** tab on the agent detail pane. Visual canvas-based pipelines come next.

---

## File map

```
rxapply-test/
├─ phase-f-v2-plan.html              ← reference plan (open in browser)
├─ dashboard.html                    ← NEW unified control plane (was 2 dashboards)
├─ dashboard-v1.html                 ← old read-only test scorecard (kept for reference)
├─ admin-dashboard-v1.html           ← old ops dashboard (kept for reference)
├─ start-v2.bat                      ← NEW · one-click apply migrations + restart proxy + smoke
├─ smoke-v2.bat                      ← NEW · 12 PASS/FAIL checks across phase F
├─ move-to-c-dev.bat                 ← NEW · workspace migrator (run when ready)
├─ apply-migration-logs-l2.bat       ← NEW · F2 migration apply
├─ apply-migration-prompts-chats.bat ← NEW · F7 migration apply
├─ apply-migration-media-library.bat ← NEW · F8 migration apply
├─ V2-WHATS-NEW.md                   ← this file
│
├─ supabase/migrations/
│   ├─ 20260501000000_logs_l2.sql           ← F2
│   ├─ 20260502000000_prompts_chats.sql     ← F7
│   └─ 20260503000000_media_library.sql     ← F8
│
├─ cowork-proxy/
│   ├─ server.js                    ← extended (added ~200 lines for F2–F9)
│   ├─ log-writer.js                ← NEW · F2
│   ├─ auth.js                      ← NEW · F7
│   ├─ prompt-versions.js           ← NEW · F7
│   ├─ services.js                  ← NEW · F3
│   ├─ n8n-control.js               ← NEW · F4
│   ├─ anthropic-chat.js            ← NEW · F5
│   ├─ cost.js                      ← NEW · F9
│   └─ afshin-router.js             ← NEW · F8
│
├─ agents/afshin/                   ← NEW agent #22
│   ├─ SKILL.md
│   └─ afshin.py
│
├─ assets/generated/                ← NEW · auto-created when first design lands
│   ├─ drafts/<uuid>.svg
│   └─ renders/<uuid>.png
│
└─ logs/                            ← NEW · auto-created on first run
    └─ YYYY-MM-DD/<agent>-<runid>.{json,stdout,stderr}
```
