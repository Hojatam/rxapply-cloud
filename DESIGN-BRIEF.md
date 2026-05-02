# RxApply Control Plane — Design Brief

A specification of what the control plane *is* and what every screen *contains*, written for a UI/UX designer to redesign the surface from scratch. Implementation details are deliberately omitted — focus is on **information architecture, interaction patterns, and visual hierarchy**.

The current implementation is a working prototype that has accumulated layers over 6 phases of construction. It works; it isn't beautiful. We want a redesign that keeps every capability listed below but makes the dashboard feel like a single coherent product instead of a stack of bolted-on cards.

---

## 1 · Who uses this and what for

**One human user**: the founder of RxApply, a brand for internationally-trained dentists migrating to other countries (UK, USA, DE, AU, CA, UAE, SA). The founder spends ~2 hours a day in this dashboard.

**What they're doing**: managing a team of **23 AI "employee" agents** that produce content, score quality, parse knowledge, design social posts, and run cron-style intel jobs. The founder reads outputs, approves actions, corrects mistakes, and trains the agents over time.

**The mental model the UI must communicate**: agents are *employees*, not scripts. The founder hires them, gives them permissions, reads their work, rates it, corrects them, asks them to collaborate. The dashboard is their org chart + inbox + training surface + knowledge base, all in one tool.

**Tone constraints (from the brand profile)**:
- **Hype-free.** No celebratory copy, no rocket emojis, no "let's go!". Calm, direct, accurate.
- **Specific.** Numbers and named institutions over vague language.
- **Multilingual.** English UI, but content surfaces (Compose output, Knowledge entries) display Persian (RTL) and Arabic (RTL) alongside English.
- **Trust-led.** The product helps people make consequential migration decisions. The dashboard should feel like a quiet professional workspace, not a SaaS demo.

---

## 2 · Top-level structure

The app is a **single-page web dashboard**, desktop-first, fixed left sidebar + main content area. Width: ~1440px is the design target. Mobile is nice-to-have but not the primary target.

### 2.1 — Topbar (sticky, full width)

Left to right:
- **Brand mark** — square `R` tile + "RxApply Control Plane" wordmark
- **Environment pill** — `local · test` or `production`
- **Sandbox pill** — `sandbox: off` / `sandbox: on` (amber when on)
- *(spacer)*
- **Today's spend** — `TODAY $0.0023`
- **30-day spend / cap** — `30D / CAP · $14.21 / $25.00` (red when ≥ 90% of cap)
- **Proxy status** — `proxy: up` / `proxy: down` (color-coded)
- **Auth status** — `auth: off` / signed-in user / `Sign in` button

The topbar is monitoring + auth, not navigation. It should be quiet and stay out of the way.

### 2.2 — Left sidebar (fixed, ~260px)

Five grouped sections with dividers (small all-caps labels). Each item is `icon + label + key-hint` where the key hint is the keyboard shortcut (1–9 + 0).

**Order is intentional — top-to-bottom mirrors the founder's daily loop**: do things → check what happened → build new things → tweak the platform → read the docs.

| Group | Items | Keys |
|---|---|---|
| **Run** | 📊 Overview · ✨ Compose · 🤖 Agents | 1 · 2 · 3 |
| **Inspect** | 📥 Inbox (with live count badge) · 🧾 Logs | 4 · 5 |
| **Build** | 📚 Knowledge · 🎨 Designs · 🪢 Pipelines | 6 · 7 · 8 |
| **Configure** | ⚙️ Services · 🔁 Workflows · 🔒 Settings | 9 · 0 · — |
| **Reference** | 🏛 Architecture map · 📜 Refinement plan · 📍 STATUS | (open in new tab) |

Below the divider lines: a small footer with version string + the keyboard hint ("Press 1–9 + 0 to jump").

**Inbox badge behavior**:
- When pending count > 0: amber pill with white number on the right of the row.
- When count = 0: shows the plain key shortcut number (visually consistent with other rows).
- The page `<title>` also prepends `(N)` when the count is non-zero, so the founder sees the count from any other browser tab.

### 2.3 — Main content area

Fills the remaining width. Each route renders into a single scrollable column. Common header shape:

```
┌─────────────────────────────────────────────────────────┐
│  Section title (large)         [page-level actions]    │
│  Short breadcrumb / subtitle                            │
└─────────────────────────────────────────────────────────┘
```

Then a stack of **cards** (white panels with rounded corners + subtle shadow, ~16px gap between).

---

## 3 · Section-by-section specifications

For each section: what's on the page, what cards exist, what actions exist, what visual states matter.

### 3.1 — Overview

**Purpose**: the home dashboard. "What happened in the last 24 hours, what needs my attention, who's on the team?"

**Cards**, top to bottom:

1. **Stat strip** — 4 cards in a row (responsive grid):
   - **Runs today** — single big number, sub-label "all agents"
   - **Inbox** — total pending across all 3 sources (action approvals + handoffs + legacy queue), sub-label breaks it down ("23 actions · 1 handoff"). Clickable → jumps to Inbox.
   - **Active leads** — total in DB, sub-label "total in DB"
   - **Spend (30D)** — `$X.XX`, sub-label "cap $25"

2. **Team quality · last 7 days** — a card showing *only* agents that have ratings or training events in the window. Each agent appears as a small tile with: name, average rating (color-coded green ≥4, amber 3–4, red <3), rating count, trend arrow vs prior week, and a low-scoring flag if any runs scored ≤2★. Tile is clickable → opens that agent's Train tab. Empty state when no ratings exist anywhere: a friendly "No ratings yet — open any agent → Train tab → rate a recent run" message.

3. **Org chart · 23 employees across 7 divisions** — the single most important card on the page. A grouped grid where each division has a colored dot + name + count, then a tile for each agent in that division. Per-tile content: name, one-line role, model in use (e.g. `sonnet-4-5`), permission summary (e.g. `5a · 1k` = 5 auto, 1 ask actions), live KPI dot. Divisions and their accent colors:
   - Content (rose), Engagement (mint), Intel (pink), Decision (blue), Inspection (indigo), Knowledge (emerald), Operations (amber), Design (fuchsia)
   - Tiles are clickable → opens that agent's detail (defaults to Chat tab).

4. **Recent activity** (left column, ~⅔ width) + **Service health** (right column) — side by side.
   - Recent activity is a feed of journal rows: timestamp, agent name, status pill (success/fail/idle), one-line summary, optional duration.
   - Service health is a 4-row list: Supabase / cowork-proxy / n8n / MailHog, each with a green/red `up` or `down` pill.

**Visual signal priority**: status pills (green/red/amber/gray) and the colored division dots. The Org chart card is the visual anchor.

### 3.2 — Compose

**Purpose**: Type a topic, get 3 social-media-ready captions (English / Persian / Arabic) + an image plan. Two human approval gates along the way.

**Cards**:

1. **Topic input** — large `<textarea>`, tone selector (hype-free / informative / encouraging), prominent ✨ Generate button. Below the textarea, a row of progress chips appears during generation:
   - `1 · Pooya brief` (pending → running → done with cost)
   - `2 · compose-ig captions` (pending → running → done)
   - `3 · Kherad score` (pending → running → done)
   - Chips animate as they progress. Each chip turns green on success, red on fail, with a small cost annotation when complete.

2. **Output panel** (appears after generation) — a tabbed display of the three caption languages with copy-to-clipboard buttons. Persian and Arabic must render correctly with **right-to-left text alignment**. Below: a "design plan" sub-panel describing the image concept the next stage (Afshin) will use.

3. **Gate A** — a yellow approval banner: "approve plan → start paid SVG draft" / "edit plan first" / "skip drafting". If approved, Afshin draft appears below as it streams. If not, banner stays.

4. **Gate B** — after the SVG draft is shown, a second approval banner: "approve for posting" (per-language toggles + an "all 3" button). Approved entries flow to a "Scheduled posts" queue — currently dry-run; one day they'll auto-post.

5. **Recent runs strip** — at the bottom: last ~5 compose runs with a Reload button each (loads them back into the viewer above).

### 3.3 — Agents

**Purpose**: meet the team. Browse who's on the roster, click into one, manage that one.

**Header**:
- Section title `Agents`
- Subtitle `${N} agents across ${M} divisions [· current selection name]`
- Right side: `🔍 search input` (~160px wide) + `+ Hire` button (primary)

**Body** has two states:

#### 3.3a — List state (no agent selected)
A vertical stack of **8 division rows**. Each row:
- Small all-caps division name on the left (CONTENT, ENGAGEMENT, INTEL, INSPECTION, KNOWLEDGE, OPERATIONS, DESIGN, DECISION).
- A horizontal grid of agent tiles (4-5 per row depending on width).
- Tile content: colored division dot + agent name + one-line role.

The search input filters tiles live (matching name OR role substring). Empty division rows collapse automatically when filtering.

#### 3.3b — Detail state (an agent is selected)

Layout splits into **left (~⅓): the agent grid** + **right (~⅔): the detail panel**. Detail panel header:
- Agent name (large)
- One-line role + division
- Top-right: `× Close detail` button

Below the header, a **tab strip** (5 tabs):

1. **Chat** *(default tab)* — the most-used surface.
   - Center: chat transcript (assistant + user messages)
   - Below: text input + Send button
   - Right rail: "Past chats" list with a "+ New chat" button. Each past chat is clickable to load its transcript.
   - Empty state: *"Start a new chat by typing below. The agent reads its SKILL.md + brand profile + relevant knowledge-base facts + its own memory + the last 10 runs before responding."*

2. **Memory** — the agent's persistent memory store.
   - Header row: filter dropdown (`All types / Episodic / Semantic / Procedural`) + search input + `👁 Preview prompt block` button (shows what gets injected at the top of every prompt).
   - Add-memory card: type select + tags + importance slider + textarea + `+ Add memory` button.
   - Below: grouped list of past memories. Each memory card shows: importance stars, content text, type pill, tags, use_count, with `✎ Edit` and `✕ Delete` buttons on the right.

3. **Train** — KPIs + corrections + examples.
   - 4 stat cards in a row: Avg rating · 7d / Ratings · 7d / Corrections / Examples.
   - If low-scoring runs exist: an amber callout `⚠ N low-scoring runs (≤2★) · go review`.
   - Two side-by-side cards: `📌 Show an example` (paste a great output → auto-saved as a Semantic memory tagged 'exemplar') and `⚙ Add a rule / correction` (plain-language rule → auto-saved as a Procedural memory).
   - Below: a list of recent runs with star buttons (1-5) for rating + `✎ Correct` button per row.
   - Below that: an audit log of recent training events.

4. **History** — table view of past invocations.
   - Columns: When · Status · Duration · Cost · view link.
   - Clicking a row opens an expandable detail with input + output payloads.

5. **Skill** — read-only viewer of the agent's SKILL.md.
   - Header: `Read-only · X chars · edit via Settings → Authoring`.
   - Body: monospaced markdown preview.

### 3.4 — Inbox

**Purpose**: the single home for everything that needs the founder's decision. Auto-refreshes every 10 seconds.

**Header**: `Inbox` + subtitle `Pending decisions awaiting your approval · auto-refresh every 10s`.

**Body**: up to **three subsections**, each with its own colored left-edge stripe and a count label. Sections only appear when they have rows.

1. **HANDOFF REQUESTS · N** *(indigo stripe)* — agent-to-agent help requests. Each card:
   - Top row: `handoff` pill + `pooya → dadbeh` arrows + suggested action + timestamp
   - Body: one-line reason ("topic mentions DHA new licensing rules — Dadbeh has the regulatory radar")
   - Disclosure: `▶ payload` (expandable JSON)
   - Right side: vertical button stack: `✓ Run dadbeh` (primary) · `↪ Redirect` · `✕ Reject`

2. **ACTION APPROVALS · N** *(amber stripe)* — actions an agent wants to take that are gated as "ask" in the permissions matrix. Each card:
   - Top row: agent pill + action mono-text + estimated cost (if any) + timestamp
   - Body: one-line narrative ("Run cross-post --trigger cron")
   - Disclosure: `▶ payload`
   - Right side: `✓ Approve` (primary) · `✕ Reject`

3. **LEGACY APPROVALS · N** *(slate stripe)* — V1-era approval queue (drafts, scheduled posts). Each card:
   - Top row: `kind` pill (e.g., `draft_design`) + short id + timestamp
   - Body: short summary
   - Right side: `✓ Approve` · `✕ Reject`

Below all three sections: a **"Recent decisions"** card (sentence-case heading, no stripe) — a small history table of the last ~20 decisions the founder made, with reason notes if any.

Empty state for the whole Inbox: 📭 emoji + *"Inbox zero. Nothing waiting on you."*

### 3.5 — Logs

**Purpose**: the full audit log of every agent invocation, with input/output capture.

**Body**:
- **Filter bar** at top: Agent select (or "All agents") · Status select · Limit select · Apply button.
- **Table**: When · Agent · Status pill · "Did this" narrative · Cost · expand arrow.
- Each row's expand arrow opens an accordion with the input payload and output payload as syntax-highlighted JSON.
- Pagination via `Limit` selector + a "Load more" at the bottom.

The "Did this" narrative is a per-agent template — e.g., "Pooya researched 'X' and produced 4 key facts." Templates are configurable in Settings → Governance → Output formatting.

### 3.6 — Knowledge

**Purpose**: a per-country knowledge base of verified facts. Every agent reads from it before producing output.

**Header**: `Knowledge base` + subtitle `Per-country facts · maintained by you + Daneshyar · read by every agent`.

**Cards**, top to bottom:

1. **📎 Upload file** — a drag-and-drop zone with click-fallback. Supports `.pdf`, `.docx`, `.pptx`, `.html`, `.md`, `.txt`, `.rtf`. Below: country-hint dropdown (auto-detect / UK / USA / DE / AU / CA / UAE / SA / GLOBAL), an optional hint input ("GDC handbook 2025 chapter 4"), and a `save as drafts` checkbox. After dropping a file: per-file progress lines + a grand-total summary ("3 files · 11 drafts saved · 0 errors · total cost $0.0823").

2. **Paste & parse** — same idea but with a large textarea instead of file drop. `👁 Preview` button (shows extracted entries without saving) and `📥 Parse & save as drafts` button.

3. **Filter bar** — Country / Category / Status / search query / `+ New entry` button.

4. **Per-country group cards** — entries grouped by country. Each group card has the country code as title + entry count + a list of entry cards. Each entry card:
   - Title + status pill (active/draft/stale/superseded/rejected with semantic colors)
   - Category pill `[exam]`
   - Importance stars (★ 1-5)
   - Content text
   - **Facts pills** — small grey chips like `cost_gbp=1066`, `currency=GBP`, `exam_name=ORE Part 1`
   - **Tags** — small indigo chips like `ORE`, `eligibility`, `GDC`
   - Verified line: `· not verified` or `✓ founder · src: https://...`
   - Right side: vertical button stack: `🔍 Verify` · `💡 Find more` · `✎ Edit` · `✕ Delete`

Status pill colors: active (green), draft (amber), stale (red), superseded (slate), rejected (gray).

### 3.7 — Designs

**Purpose**: review and approve image designs (Instagram carousel slides, Telegram covers, YouTube thumbnails, web banners, email headers). A design starts as an SVG draft (cheap), then gets rendered to PNG via paid image-gen models (gpt-image-1 / Flux / Ideogram / Recraft) once approved.

**Body**:
- **Header**: section title + Refresh + `+ New design` (primary).
- **Filter bar**: Kind select / Status select.
- **Card grid** (3 columns at 1440px width). Each card:
  - **Preview area** at top, ~16:9 aspect ratio. Shows the rendered PNG if available, else the SVG draft, else a "no preview" placeholder. **Critical: malformed SVGs must NOT render the browser's raw XML error page** — show a friendly "⚠ SVG parse error · open SVG ↗ to inspect" placeholder instead.
  - **Meta line**: kind pill (`IG_CAROUSEL_SLIDE`) · dimensions (`1080×1080`)
  - **Title**: the topic
  - **Sub-meta**: language code · created date · cost line ("Cost: draft $0.0250 · render $0.0040 · model: gpt-image-1")
  - **Status pill**: `pending` / `approved`
  - **Actions** (horizontal row):
    - If pending: `✓ Approve` (primary) + `✕ Reject` (ghost) + `SVG ↗` (open SVG file in new tab)
    - If approved without render: `🎨 Render PNG` (primary) + `SVG ↗`
    - If approved with render: `⬇ PNG` (download) + `↻ Re-render` + `SVG ↗`

### 3.8 — Pipelines

**Purpose**: a visual drag-and-drop orchestrator (built on Drawflow). Compose multi-step flows by connecting node types.

**Header**: section title + `↻ Refresh list` + `+ New` + `💾 Save` + `✏ Clear log` + `▶ Run pipeline` (primary).

**Body**:
- **Top bar**: 4 draggable node-type chips (Agent · Conditional · Transform · Output) on the left, a `Pipeline name` input + `Description (optional)` input + `🗑 Delete` button on the right.
- **Two-column body**: left (~⅓) is the **Saved pipelines** list (each row: name + node count + date), right (~⅔) is the **canvas** where Drawflow renders.
- Below the canvas: a **black-themed run-log panel** with a `▸ run log will appear here after ▶ Run pipeline` placeholder. Streams agent invocation results live as nodes execute.

Nodes are connected with bezier curves. Output ports of conditional nodes branch — only the chosen output port marks downstream as live.

### 3.9 — Services

**Purpose**: monitor + control the four local services that the dashboard depends on.

**Body**: a 2×2 grid of service cards. Each card:
- **Top row**: service name + meta (`docker container · n8n-test`) + status pill (`running` / `stopped`)
- **Health probe URL**: a monospaced URL + a green `✓ reachable` badge
- **Action buttons** (horizontal): `▶ Start` (primary) · `■ Stop` (red) · `↻ Restart`

The four services: Supabase · n8n · MailHog · cowork-proxy. The cowork-proxy card has no Start/Stop (it's the page itself; it can't kill itself).

Below: a small **Notes** card with bullet points clarifying the dependency order ("Stopping Supabase ends the n8n DB connection too — stop n8n first, then Supabase.") and how to recover from a stuck proxy.

### 3.10 — Workflows

**Purpose**: manage n8n workflows (cron jobs + webhooks) without leaving the dashboard.

**Body**:
- **Two-column layout**:
  - **Left (~⅔)**: a table of currently active workflows. Columns: Name · Status pill · Updated · Nodes · actions (`■ Deactivate` / `▶ Run now`).
  - **Right (~⅓)**: two stacked cards:
    - **Library**: a list of importable workflow JSONs from disk. Each row: filename + `Import` button (primary).
    - **Recent executions**: a list of recent runs with status pills + timestamps.

### 3.11 — Settings

**Purpose**: founder controls. Split into **4 sub-tabs** to keep each page focused.

**Header**: `Settings ●` + subtitle `Founder controls — split into 4 focused pages` + `Sign out` button (right).

**Sub-tabs** (border-bottom indicator): General · Brand & Models · Governance · Authoring.

#### Sub-tab 1 — General
A 2-column grid:
- **General** card: 3 toggle/input rows (Sandbox mode toggle, Monthly cap input, Session hours input). Each row has a label, a help line, and the control on the right.
- **API keys (read-only)** card: list of 7 API key names with `✓ set` (green) or `not set` (gray) pills, and a help line below explaining how to add the missing ones.

#### Sub-tab 2 — Brand & Models
Three stacked cards:
- **Image model defaults (per kind)**: a grid of 6 design kinds (IG carousel slide, Telegram cover, YouTube thumb, Web banner, Email header (Ravi), Custom) each with a model dropdown.
- **Brand profile**: the most important config card in the app. ~10 input fields (Brand name, Founder, Tagline, Audience, Primary color, Typography, Secondary colors textarea, Voice rules textarea, Visual rules textarea, Example captions textarea). A `💾 Save brand profile` button (primary, top-right). A `▶ Preview the prompt block agents will see` disclosure at the bottom.
- **Per-agent LLM model**: a 2-column grid of all 23 agents, each with a model dropdown ("— use default (claude-sonnet-4-5-20250929)" or specific override). Above the grid: `Pick which Claude model each agent uses. Falls back to the global default when no override is set.`

#### Sub-tab 3 — Governance
Two stacked cards:
- **Permissions matrix**: per-agent sub-cards laid out in a 2-column grid. Each sub-card has the agent name + a list of action rows (action name + cost threshold + mode dropdown auto/ask/blocked). At the top of the matrix, an amber **ghost-agent banner** appears if there are permission rows for agents not in the dashboard registry: `⚠ Ghost agents detected: compose, kasra — these agents have permission rows but are not in the dashboard registry. Either re-hire them or run DELETE FROM agent_permissions...`
- **Output formatting**: per-agent sub-cards with one textarea + Save button per action template. Templates use `{path}` placeholders, e.g., `Pooya researched "{topic}" and produced {key_facts_count} key facts.`

#### Sub-tab 4 — Authoring
Single card:
- **Prompts editor**: agent picker dropdown at the top + version history badge ("latest version: v3 · 2 historical"). Below in a 2-column grid:
  - Left (⅔): the SKILL.md textarea (large, monospaced, ~480px tall) with a "Reason for this edit" input and Save & version + Discard buttons below.
  - Right (⅓): a scrollable Version history list with one row per version (version number, edited time, char count, optional reason, View / Rollback buttons).

---

## 4 · Recurring component patterns

These components appear across many sections and should have one consistent visual treatment.

### 4.1 — Cards
- White background, ~12-16px border radius, subtle shadow (one stop, low opacity).
- Internal padding: ~20-24px.
- Vertical gap between cards: ~24px.
- Card header pattern: `<h3>` (sentence-case, semibold) on the left + meta sub-text + actions on the right.

### 4.2 — Status pills
Tiny capsule shapes (~10-12px text, ~4-8px horizontal padding, fully rounded). One semantic color per state, with a leading dot:
| State | Color | Example use |
|---|---|---|
| `ok` | emerald | "running" / "success" / "approved" / "active" |
| `warn` | amber | "ask" / "pending" / "draft" |
| `err` | rose | "fail" / "blocked" / "stale" / "down" |
| `idle` | slate | "checking…" / "superseded" / "rejected" |
| `accent` | indigo | "handoff" / "exemplar" |

### 4.3 — Tabs
Border-bottom underline style (no rounded backgrounds). Active tab: indigo border-bottom + indigo text. Inactive: transparent border-bottom + slate text + slate-900 hover.

Used in: Agents detail (5 tabs), Settings (4 tabs), Compose output (3 language tabs).

### 4.4 — Modals
Centered, max-width ~600px (forms) or ~640px (Hire), background overlay at ~40% black. Modal card has a header row (title + close `✕`) and a footer row with Cancel + primary action buttons.

Used for: KB entry edit, Hire agent, Pipeline node editor.

### 4.5 — Empty states
Two-line block: a large emoji or icon + a one-line friendly message + an optional CTA button below. Always answer the question "what should I do next?". Examples:
- 📭 *Inbox zero. Nothing waiting on you.*
- ⏳ *Loading…*
- ∅ *No entries yet — paste some source text above, or click "+ New entry".*

### 4.6 — Live count badges
Amber pill with white bold number, on the right of the Inbox sidebar row + prepended to the page `<title>` as `(N)`. Polls every 10 seconds.

### 4.7 — Stripe-coded cards
For the Inbox: a 4px-wide colored left edge identifies the card type at a glance (indigo for handoffs, amber for action approvals, slate for legacy approvals). Designer can rethink this idiom but **the founder needs to distinguish three queue types instantly without reading.**

### 4.8 — Refresh buttons
Always `↻ Refresh` with text, never icon-only. `btn btn-ghost btn-xs` styling.

### 4.9 — Form fields
Border `1px solid slate-200`, rounded `4-6px`, padding `8px 12px`, focus state with indigo ring. Labels above inputs in small sentence-case (not all-caps).

### 4.10 — All-caps tracking-wider sub-section labels
Reserved for **labels INSIDE a card** (not card titles). Examples:
- "HANDOFF REQUESTS · 1" inside the Inbox panel
- "ADD MEMORY MANUALLY" inside the Memory tab
- "PAST CHATS" inside the Chat tab
- "RECENT" inside the Compose recent strip

Card-level titles (`<h3>`) stay sentence-case.

---

## 5 · Visual signals to design carefully

### 5.1 — Color semantics

The dashboard communicates a lot of state. We need a *small* palette of semantic colors used consistently:

- **Emerald** → ok, success, approved, active, up
- **Amber** → ask, pending, attention, draft, sandbox-on
- **Rose** → fail, blocked, stale, error, over-cap
- **Indigo** → primary action, handoff, accent / brand
- **Slate** → idle, superseded, neutral text
- **Mint / pink / pale-yellow / etc.** → division accent dots only (8 distinct hues, all desaturated)

The brand's primary color is currently `#4f46e5` (indigo-600). Designer can propose a different brand palette as long as the semantic states stay distinct.

### 5.2 — Typography hierarchy

Currently uses Inter (English) and Vazirmatn (Persian / Arabic). Suggested levels:
- `<h1>` section titles: ~22px, semibold, tight letter-spacing
- `<h3>` card titles: ~16px, semibold
- Body text: ~14px regular
- Sub-labels (the all-caps tracking-wider): ~11px, semibold, +0.05em letter-spacing
- Mono: JetBrains Mono for IDs, file paths, code snippets, model names

The dashboard renders Persian and Arabic content (in Compose output, Knowledge entries from FA/AR sources) — the design system **must support RTL gracefully** wherever multilingual content appears.

### 5.3 — Density

This is a power-user tool used hours per day. Information density is OK and welcome — but:
- **Cards must breathe** — never feel cramped.
- **Lists with 50+ rows** (Inbox, Logs, Knowledge) need clear row separation without garish lines.
- **Filter bars** at the top of long lists are non-negotiable — the founder will not scroll through 40 rows to find one.

### 5.4 — Motion

Minimal. Things we do animate:
- Compose progress chips (idle → running → success/fail)
- Stripe pulses on Inbox (subtle, optional)
- Modal enter/exit (200ms fade + 4px slide)
- Inbox badge appearance/count change (no animation — silent update)

No celebratory animations. Hype-free.

---

## 6 · Constraints and non-goals

### Hard constraints
- **Single-user**: no team views, no role-based access control, no organization switcher. The founder is alone.
- **All in this dashboard**: no companion mobile app, no Slack integration as primary surface, no email approvals. Everything funnels through this UI.
- **Desktop-first**: 1200-1920px is the design target. Tablet OK but secondary.
- **Auth-aware but not auth-heavy**: a simple sign-in + sign-out flow exists but is not visually prominent. AUTH_DISABLED dev mode shows an `auth: off` pill in the topbar.

### Non-goals
- **Marketing pages** — this is private to the founder; no landing pages, no public docs in-app.
- **Analytics dashboards** — no charts, no time-series. Just current state + recent activity.
- **Real-time collaboration** — no presence indicators, no shared cursors.
- **Onboarding flows** — the founder built it; no first-run wizard needed.

### Open design questions for the designer

1. **Dark mode?** The current dashboard is light-only. A founder who works late at night might prefer dark. Worth proposing.
2. **Sidebar collapse / icon-only mode?** At ~1200px width, the sidebar is generous; on a 14" laptop, the founder might want to collapse it to icons.
3. **Density toggle?** Not strictly needed but: should we have a "compact" mode that reduces card padding by 20% for power-user moments?
4. **Topbar simplification.** Currently the topbar has 6 elements (env pill, sandbox pill, today $, 30D / cap $, proxy status, auth status). That's a lot. Is there a way to consolidate without losing information?
5. **Inbox: is the stripe + section approach right?** Or should it be a unified single-stream feed with a Type column? The founder wants to scan all three queues in seconds.
6. **Knowledge entry cards: 4 vertical buttons feels heavy.** The 4 actions (Verify / Find more / Edit / Delete) all matter, but there might be a tidier pattern (overflow menu? hover-reveal?).
7. **Compose output: how to display 3 RTL/LTR captions side by side without making one feel cramped?** Tabs work but lose the "compare at a glance" property.

---

## 7 · What we want from you

We're not asking for a wireframe set — we're asking for a **complete visual redesign** that:

1. **Keeps every section + sub-tab listed above** (don't drop functionality).
2. **Reduces visual noise** while increasing legibility. The current dashboard has been audited; we know which corners are messy. We want a fresh take that doesn't feel like a "minor refresh".
3. **Picks one consistent style** for cards, pills, buttons, tabs, modals, and empty states — no more accumulated layers.
4. **Treats Persian and Arabic as first-class** wherever multilingual content surfaces.
5. **Respects the brand voice**: hype-free, calm, professional. Like a workspace, not a SaaS demo.
6. **Optionally proposes**: a dark mode, a sidebar-collapse pattern, a density toggle, or any other improvement that makes the dashboard feel like one product instead of eleven.

Deliverables we'd like to see:
- A coherent **design system** (color palette, typography scale, spacing scale, component library).
- **Wireframes for all 11 sections + the 5 Agent-detail tabs + the 4 Settings sub-tabs** — at fidelity high enough to implement.
- **2-3 hero shots** for Overview, Inbox, and Compose at a beautiful state (with realistic content, not lorem ipsum).
- A short **rationale doc** explaining the reasoning behind major decisions (especially anything that diverges from the spec above).

Implementation will be done by the engineering team in vanilla HTML + Tailwind. The designer doesn't need to deliver code — Figma / Penpot / static mockups are fine.

---

## Appendix A — Current data flow recap (for context only)

The dashboard reads from a local Postgres (Supabase) and a Node proxy on `localhost:7777`. Every agent invocation gets logged to `agent_runs`, narrated via `output_renderers`, and may queue an `agent_actions_pending` row (the K1 inbox) or an `agent_handoffs` row (the K4 inbox). Permission rules in `agent_permissions` decide whether an action runs immediately, queues for approval, or is blocked.

Per-agent memory lives in three flavors: episodic (past runs/chats), semantic (facts to know), procedural (rules/corrections). Memory is auto-injected into every agent's prompt at run time. The Brand Profile (a single jsonb in `dashboard_settings`) is also auto-injected. The Knowledge Base (per-country verified facts) is auto-injected too, country-detected from input text.

The Compose flow chains: **topic → Pooya brief (research) → compose-ig (3-language captions + design plan) → Kherad (brand-voice score)** → Gate A (founder approves) → **Afshin SVG draft** → Gate B (founder approves per-language) → scheduled posts queue.

Designer doesn't need to internalize any of this — just helpful context for why certain pages exist.

## Appendix B — Real content snippets to use in mockups

To make the design feel real, use these instead of lorem ipsum:

**Topics**: "AFK exam in Canada" · "CV writing tips for internationally-trained dentists" · "NDEB exam application timeline" · "Why partnering with an RCIC matters for Canadian licensure"

**Agent names**: pooya · sepehr · goyesh · avang · rahnama · rahbar · bineh · mehrban · roya · shahed · dadbeh · nasim · ramin · kherad · bidar · davari · zirak · paya · ravi · payvand · mehmandar · afshin · daneshyar

**Sample handoff**: "pooya → dadbeh — topic mentions DHA new licensing rules · Dadbeh has the regulatory radar"

**Sample inbox action**: "Run cross-post --trigger cron"

**Sample KB entry**: 
- title: "ORE Part 1 exam fee"
- content: "ORE Part 1 costs approximately 1066 GBP as of 2025."
- facts: `cost_gbp=1066`, `currency=GBP`, `exam_name=ORE Part 1`, `year=2025`
- tags: `ORE`, `Part 1`, `cost`, `exam fee`
- status: draft
- importance: 4 stars
- source: "founder note"
- verified: not verified

**Sample stat values**: Runs today: 25 · Inbox: 23 (22 actions · 1 handoff) · Active leads: 3 · Spend (30D): $0.00 / $25 cap

That's enough to build mockups that feel like a real working tool.
