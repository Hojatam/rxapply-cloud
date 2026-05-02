# Dashboard refinement plan · post live audit

A full audit of `dashboard.html` based on **walking every section + every sub-tab live in the browser**. Every finding below was observed on screen, not inferred from code grep. Each item is paired with a fix and an effort estimate.

The current dashboard works, but it has accumulated layers from V1 → V2 → V2.5 → V3/K1 → K2 → K3 → K4 → K5 → K6, and three of those layers ship parallel surfaces for the same concept. This plan picks one canonical place for each idea and demolishes the rest.

---

## 1 · Findings — what's actually there, observed live

Sections walked (in order): **Overview · Services · Workflows · Agents (+ all 7 detail tabs of `pooya`) · Pipelines · Compose · Inbox · Logs · Approvals · Designs · Knowledge · Settings (all 9 cards).** Notes below are what I saw on screen, with screenshot evidence.

### 1A. Sidebar — keys collide, footer is stale

- **Compose is `6` and Logs is `6`.** Both display `6` in the nav num column. Press `6` and JS routes you to whichever the keymap binds — currently `logs` per the code. Compose's number is just visual decoration with no key.
- **Inbox has no key.** It's the most-used surface (20 items pending right now in the live view) yet has no shortcut.
- **Knowledge is `9`** but the sidebar footer reads **"Press 1–8 to jump"** — out of date.
- **Sidebar footer reads "v2.0 · phase F"** — two phases stale (V2.5 + V3/K1–K6 shipped since).
- **Reference section** still links `phase-f-v2-plan.html` (largely superseded by V3 and `architecture.html` itself), but no link to the new `architecture.html` V3 section, no link to this refinement plan, and the labels are inconsistent: "Phase F plan" / "Architecture" / "STATUS.md" — three different naming styles.

### 1B. Overview — three independent counts of "pending stuff", and one card never populates

- **"Pending approvals" stat reads `0`** at the top of Overview — but the **Inbox sidebar badge shows `20`** at the same time (and the page-title counter `(20) RxApply…`). Two numbers, both about "things needing the founder's attention", neither agreeing.  
  *Why:* the stat queries `approval_queue` (Supabase REST, pre-K1), the badge polls `/inbox/count` + `/handoffs/count` (K1+K4). They're parallel queues from different eras.
- **"Service health" card on the right column never renders.** The card shell shows but the content list is empty in every view I tried. Functional bug — `loadServices()` for Overview either isn't called or fails silently.
- **Org chart card title says "23 employees across 6 divisions"** but the rendered chart actually has **7 division rows** (Content, Engagement, Intel, Inspection, Operations, Design, Knowledge — Decision was never populated; Knowledge was added by K6). The number is wrong.
- **"Team quality · last 7 days" only shows zirak** (3.5/5). All other agents are filtered out because they have zero ratings, leaving a near-empty card that suggests the system is broken when really nobody has rated anyone yet. No "no ratings yet" empty state.
- **Recent activity rows show `agent + status pill + one-line description`** but no cost, no model, no duration. Mismatched with Logs page which shows COST column.
- **Two refresh buttons** — one for the whole page, one for the org chart card. Inconsistent.

### 1C. Agents — page list lies about the count, and Daneshyar is missing

- **Header reads "22 agents across 6 divisions"** — both numbers wrong. The actual count from `AGENTS` array is 23 across 7 divisions.
- **Daneshyar is missing from the Agents page list entirely.** I scrolled all the way down and the last division shown is `DESIGN · afshin`. No `KNOWLEDGE` row, no Daneshyar card. The agent IS visible on Overview's org chart (so the data is there) and the route `/knowledge` exists — but `renderAgents()` iterates a different group list than `loadOrgChart()`, and forgot to add Knowledge.
- **No search box on the Agents page.** With 23 cards over 7 division rows the founder has to scroll to find a specific agent.

#### Agent detail (clicked into pooya) — 7 tabs, 3 of them are dead weight

| Tab | Default? | What it actually is | Verdict |
|---|---|---|---|
| **Skill** | ✓ default | SKILL.md displayed read-only, footer says "edits go through Settings → Prompts" | **Redundant** — the Settings → Prompts editor is the only place that can actually edit. The Skill tab is a viewer at best, and shouldn't be the default. |
| **Run** | — | Form: `COMMAND` text field + `ARGS (JSON ARRAY)` field + `STDIN (OPTIONAL)` textarea + Run button. Calls `POST /run-helper`. | **Wrong shape** — this is a CLI form, not a "human employee" interface. It violates the founder's stated constraint ("agents must be like human employees"). Pre-K1 leftover. |
| **Chat** | — | Proper chat UI, "+ New chat", past chats sidebar. Hint text says "agent gets SKILL.md + last 10 runs as context" | Works, but the **hint text is stale** — agents now also get Brand + KB + Memory blocks (K2, K6). Should be the **default** tab. |
| **Memory** | — | Filter by type + search + add manually + 👁 Preview prompt block + past runs (episodic) with star rating + ✎/✕ on rows | Solid. Keep as-is. |
| **Train** | — | 4 KPIs (Avg rating · Ratings 7d · Corrections · Examples) + "Show example" + "Add a rule" cards | Solid. Keep as-is. |
| **History** | — | Table: when / status / duration / cost / view. **Cost column is `—` for every legacy run** (because they used the python helper, not the API). | Works but the empty cost column looks broken. Add a "—" tooltip ("legacy run, no cost data"). |
| **Forward** | — | One hardcoded button: "→ sepehr · Open sepehr ▶ Run" | **Redundant with K4 handoffs.** Forward only chains to one pre-mapped target. K4 handoffs (in Inbox) lets any agent route to any other. Demote to a button row inside History. |

### 1D. Inbox — works well, but renderer templates produce awkward copy

- Two clearly grouped sections with stripes: **HANDOFF REQUESTS · 1** (indigo) and **ACTION APPROVALS · 19** (amber). Auto-refresh works, badge updates live.
- **Awkward narrative line**: many cards read literally **"Run cross-post run --trigger cron"**. The renderer template generates `Run {agent} {action} {args}` and when the agent's action is named `run` you get the duplicate "cross-post run". Same problem on the **Logs** page — "DID THIS" column shows **"cross-post ran run."** for the same reason.
- "Recent decisions" subsection at the bottom is a small all-caps `<h3>` inside the same card, while the active queue uses normal-case section labels. Inconsistent.

### 1E. Logs — fine, but wears the renderer bug too

- Filter bar (Agent · Status · Limit · Apply) + table (when / agent / status / DID THIS / cost). Each row has an expand arrow → input/output detail.
- DID THIS produces "X ran run." for cross-post and zirak — same renderer template problem as Inbox.
- Cost column is "—" for every run on the visible page — all are legacy python-helper runs.

### 1F. Approvals — ghost town

- **"Nothing pending. 🎉"** Empty, while the Inbox right next to it has 20 pending items. The two are wired to **different queues** from different eras. Approvals queries Supabase REST `approval_queue` directly (V1 era). Inbox queries `/inbox` + `/handoffs` (K1+K4). They have never been merged.
- The legacy queue is still wired to specific old paths (compose Gate B, Afshin approval) so deleting it would break those flows — but exposing it as a sidebar tab confuses the founder.

### 1G. Compose — clean

- Topic textarea (last topic remembered in localStorage) + Tone dropdown + Generate button.
- Recent runs list with reload buttons.
- No issues observed.

### 1H. Pipelines — works, but breadcrumb leaks internal jargon

- "F6 · Visual drag-and-drop orchestration" — `F6` is the internal phase code from V2/Phase F. Founder-facing copy should drop it. "Visual drag-and-drop orchestration" alone is enough.
- 4 node types as draggable handles (Agent · Conditional · Transform · Output) + Pipeline name+desc + Save / Clear log / Run pipeline / Delete buttons.
- Delete button up top (right column) feels like it could destroy the open pipeline accidentally — it's labeled Delete with a red trash icon, but no confirm dialog observed.

### 1I. Designs — one rendering bug + duplicate approval surface

- Card grid with SVG previews. Per-card: kind / dimensions / title / multi flag / date / cost / status pill + actions (Approve / Reject for pending; Render PNG for approved; SVG ↗ link).
- **One card's preview shows literal XML error text** ("This page contains the following errors..." / "error on line 4 at column 91"). The SVG is malformed and the dashboard renders the error rather than catching it.
- **Approve/Reject on Designs cards is yet another approval surface** — separate from Inbox AND from Approvals. Three approval queues: K1 Inbox actions, legacy `approval_queue`, and per-design buttons.

### 1J. Knowledge — newest section, mostly clean

- Upload file card + Paste & parse card + filter bar + per-entry cards.
- Per-entry cards have title + status pill + category + importance stars + content + facts as `key=value` pills + tags + verification line + 4 vertical action buttons (Verify / Find more / Edit / **X**).
- **The X (delete) button is icon-only with no text label** — inconsistent with the other three labeled buttons in the same column.

### 1K. Settings — 9 large cards on a single 720+ row scroll

The page never tells you how long it is. You scroll forever. Order:

1. **General** — sandbox toggle + monthly cap + session hours. Three fields.
2. **API keys (read-only)** — 7 keys with set/not-set pills.
3. **Image model defaults** — 6 kind→model dropdowns (ig_carousel_slide, telegram_cover, youtube_thumb, web_banner, email_header_ravi, custom).
4. **Brand profile** — 9 fields (name, founder, tagline, audience, primary color, typography, secondary colors, voice rules, visual rules) + example_captions + Save button. **Single biggest card on the page.**
5. **Hire a new employee** — agent name + role + division + description + Hire button.
6. **Permissions matrix** — 23 agents × ~6 actions each = ~80+ controls on one card. **Sub-card for `kasra`** appears here — *but `kasra` is not in the AGENTS array*. Schema drift between the dashboard registry and `agent_permissions` table.
7. **Output renderers** — per-agent per-action template textareas, **each row has its own individual Save button**. To save 5 templates you click Save 5 times. Heavy click economy.
8. **Per-agent LLM model** — grid of agent → model dropdowns. All entries say "using default". Functional but visually monotonous.
9. **Prompts editor** — agent picker → SKILL.md textarea + version history list. **Same SKILL.md content the Agents → Skill tab shows read-only.** This is the only place where it's editable, hence the Skill tab's "edits go through Settings → Prompts" hint.

### 1L. Visual & copy inconsistencies (recurring)

- **Card title casing**: most are sentence-case `<h3 class="font-semibold">` ("Brand profile", "Permissions matrix") but Inbox, Compose, Knowledge use **all-caps tracking-wider** sub-headers ("HANDOFF REQUESTS · 1", "ADD MEMORY MANUALLY", "PASTE & PARSE"). No clear rule.
- **Refresh buttons**: most say `↻ Refresh` (Overview, Workflows, Settings), Memory tab and a few others just `↻`. Inconsistent.
- **Empty states**: Approvals uses `Nothing pending. 🎉`, Knowledge uses an icon + text two-row block, Inbox uses a different copy template. Different idioms across surfaces.
- **Card spacings**: mix of `mb-4`, `mb-6`, `mt-6`, `mb-3` with no rule. Some sections feel cramped, some feel airy, all in the same screen.
- **Action button density**: Knowledge has 4 vertical buttons per card (one icon-only); Designs has 3 horizontal; Inbox has 2–3 horizontal; Memory has 2 icon-only. Different approaches to "row actions" in every panel.
- **Header refresh buttons**: Overview has both a top-right Refresh AND a card-level Refresh on the org chart. Settings has Refresh on every individual card (Image model defaults, Brand profile, Permissions, Renderers, LLM model). Visually loud.

---

## 2 · Bugs to fix immediately (independent of structural changes)

These aren't refactors — they're broken things visible on screen.

| # | Bug | Where | Fix |
|---|---|---|---|
| B1 | Service health card never populates | Overview right column | Wire / fix `loadServices()` for Overview |
| B2 | Org chart says "6 divisions" but renders 7 | Overview org chart card title | Use `Object.keys(groups).length` instead of hardcoded 6 |
| B3 | Agents page header says "22 agents across 6 divisions" | Agents `<h1>` breadcrumb | Use `${AGENTS.length} agents across ${groupCount} divisions` |
| B4 | Daneshyar missing from Agents page list | `renderAgents()` iterates an old groupOrder | Add `Knowledge` to the rendered groupOrder |
| B5 | Renderer template makes "X ran run." | All `output_renderers` rows where action === `'run'` | Update template to `{agent} ran {action_or_blank}` (skip action if it's the literal `run`); or special-case when action == agent's run command |
| B6 | "Pending approvals" Overview stat shows 0 while Inbox has 20+ | Overview stat card | Either fold into Inbox (preferred) or change label to "Legacy approvals only" |
| B7 | Sidebar footer "Press 1-8" / "v2.0 · phase F" | sidebar footer block | Update to "Press 1-9 + 0 to jump" / "v3 · K6" |
| B8 | Designs SVG preview shows literal XML error in one card | render of malformed SVG | Wrap SVG render in try/catch; if SVG parse fails, show an "⚠ SVG parse error · view raw" placeholder |
| B9 | Permissions matrix shows kasra (not in AGENTS) | `agent_permissions` table has rows for agents not in dashboard registry | Add a "ghost agent" warning row at top of matrix, OR clean up table to only show registered agents |
| B10 | Pipelines breadcrumb says "F6 · …" | section header | Drop "F6 ·" prefix |

These are the 10 wrong-thing items. Fixing all of them is roughly 60 minutes of work and doesn't require any structural reshuffle.

---

## 3 · Structural reshuffle — proposed final shape

Once the bugs are fixed, the dashboard still has too many parallel surfaces. Here's the target structure with **everything observed in the audit slotted into exactly one home**.

### 3A. Sidebar — 9 routes, every key bound, no collisions

```
OPERATE
  📊 Overview         1
  ✨ Compose          2          ← bumped up (most-used "make something")
  🤖 Agents           3
INSPECT
  📥 Inbox            4          ← gets a key for the first time
  🧾 Logs             5
BUILD
  📚 Knowledge        6
  🎨 Designs          7
  🪢 Pipelines        8
CONFIGURE
  ⚙️ Services         9
  🔁 Workflows        0
  🔒 Settings         (no key)
REFERENCE
  🏛 Architecture     (opens new tab)
  📜 Refinement plan  (opens new tab — links here)
  📍 STATUS.md        (opens new tab)
```

**Removed**: Approvals (folded into Inbox).

**Reordered**: Compose moves up next to Overview (it's the daily action). Services + Workflows demoted to "Configure" — they're admin tasks, not daily.

**Footer**: "Press 1-9 + 0 to jump · v3 · K6 (Knowledge Base)"

### 3B. Approvals tab → killed; legacy queue moves into Inbox

The `approval_queue` table is still queried by some old workflow paths, so we don't drop the data. But the founder needs **one** place that says "here is everything waiting for you."

- Inbox grows a third sub-section: **"LEGACY APPROVALS · N"** (only shown when N > 0). Same approve/reject buttons, same audit trail.
- Overview stat card "Pending approvals" → renamed **"Inbox"**, sums all three sources (K1 actions + K4 handoffs + legacy approvals). Matches the badge.
- Designs page: per-card Approve/Reject buttons stay (they're contextual — you want to see the SVG before approving), but each click also writes through to Inbox so the founder can see the decision history in one log.

### 3C. Settings split into 4 tabs inside Settings

The 9-card scroll is the worst page on the dashboard. Split it:

| Sub-tab | Cards |
|---|---|
| **General** | General fields (sandbox · cap · session) + API keys (read-only) + Sign out |
| **Brand & Models** | Brand profile + Image model defaults + Per-agent LLM model |
| **Governance** | Permissions matrix + Output renderers (renamed "Output formatting") |
| **Authoring** | Prompts editor (single card; SKILL.md edit + version history) |

**Hire a new employee → moves out of Settings entirely** — exposed as a `+ Hire` button on the Agents page header (modal). It's a founder action, not a setting.

### 3D. Agents detail tab order — Chat first, Run + Forward demoted

Old: `Skill · Run · Chat · Memory · Train · History · Forward`

New: `Chat · Memory · Train · History · Skill`

- **Chat is default** — the most common action 90% of the time.
- **Run tab dropped from the tab strip.** Move its functionality into a small "advanced: invoke helper directly" disclosure inside History (it's still occasionally useful for debugging python helpers like ravi or roya, but it's NOT the founder-facing path).
- **Forward tab dropped from the tab strip.** Move its single button into the History tab as a **row action** ("⏵ pass to sepehr") on the most recent successful run. Or remove entirely — K4 handoffs already cover this with more flexibility.
- **Skill demoted to last position** — it's a viewer, not a workspace.
- The Skill viewer's footer hint stays ("edits go through Settings → Prompts → Authoring") but is now sentence-cased: "Read-only. Edit in Settings → Authoring."

### 3E. Agents page — add search + put Daneshyar in

- Add a `🔍 search agents…` input at the top of the Agents page. With 23 cards across 7 divisions, scroll-find is annoying.
- Fix the missing **Knowledge** division (B4 above).
- Update the hardcoded breadcrumb (B3 above).

### 3F. Overview — three changes, all small

- Add an empty-state for "Team quality" when no agent has any ratings yet ("No ratings yet — rate a run on any Agent → Train tab to start tracking quality.").
- Make the org chart card title dynamic (B2).
- Fix the Service health card (B1).
- Add cost + model to Recent activity rows (one-line addendum: `· $0.0023 · sonnet-4-5`).

### 3G. Visual & copy consistency — pick one rule, apply across all 11 sections

| Rule | Decision |
|---|---|
| Card titles | `<h3 class="font-semibold">` sentence-case for primary card titles. The all-caps tracking-wider style is reserved for **section labels inside a card** (e.g., "ACTION APPROVALS · 19" inside Inbox). |
| Refresh buttons | Always `↻ Refresh` with text label. Drop the icon-only variants. |
| Card spacing | `mb-6` between cards · `mb-3` inside a card · no `mt-6` (use `mb-6` on previous card instead) · ban `mb-4`. |
| Empty states | One shared snippet: icon + 2 lines of text, optionally a CTA button below. Memory tab's pattern is the cleanest — adopt that. |
| Row action buttons | Vertical stack on the right when there are 4+ actions; horizontal row when ≤3. Always include a text label, even one-character ones (X → "Delete"). |
| Refresh location | Once per section (top-right, in `section-h`). No card-level refresh buttons unless the card is independently fetched on a slow channel — kill the four extra ones in Settings. |

### 3H. Reference links — refresh to current docs

- Drop "Phase F plan" (superseded by V3 sections in `architecture.html`).
- Add this **"Refinement plan"** link.
- Re-label all three so they look uniform (`📜 Refinement plan`, `🏛 Architecture map`, `📍 STATUS.md`).

---

## 4 · Suggested execution order

A single, mostly-mechanical pass. Each step is testable independently — none requires a schema change.

| Step | Scope | Effort |
|---|---|---|
| **S1** Bug pass | Fix B1–B10 from §2 in one go | 60 min |
| **S2** Sidebar reorder + footer | §3A (just markup + keymap) | 15 min |
| **S3** Kill Approvals route, fold queue into Inbox | §3B | 30 min |
| **S4** Settings tab-strip split | §3C (one new tab UI inside `renderSettingsMain`) | 60 min |
| **S5** Move Hire to Agents page | §3C — modal on Agents header | 20 min |
| **S6** Agent detail tab reorder + drop Run/Forward tabs | §3D | 25 min |
| **S7** Agents page: search + Knowledge row | §3E | 20 min |
| **S8** Overview polish (empty state · dynamic counts · activity row enrichment) | §3F | 25 min |
| **S9** Visual consistency sweep (all 11 sections) | §3G | 60 min |
| **S10** Reference section refresh | §3H | 5 min |

**Total ≈ 5 hours** of careful work. No new agents, no new tables, no new routes.

---

## 5 · Out of scope (deliberately, again)

- **Mobile / sidebar collapse.** Worth doing later, but not part of "make the desktop view tidy".
- **Theme / dark mode.** Separate.
- **Renaming agents page tabs from "Skill" to something else.** Bigger discussion.
- **Removing the Workflows tab.** n8n integration still earns its place; just demote it to Configure.
- **Building a "Today" / morning digest view.** Worth a separate plan after this lands.
- **Adding RBAC / multi-user.** This is a single-founder dashboard; not now.

---

## 6 · What success looks like (acceptance criteria, post-pass)

- The header on every section uses `${AGENTS.length}` and `${groupCount}` — no hardcoded numbers anywhere.
- Inbox sidebar badge, Overview stat, and the page-title counter all show the **same number**.
- Pressing keys 1-9 + 0 jumps to exactly one section each, and the footer hint says so.
- Settings is **4 tabs**, not 9 cards on a 720-row scroll.
- The Agents page detail panel **opens to Chat by default**.
- Daneshyar appears in the Agents page list under a **Knowledge** division row (mint dot).
- The Agents page has a **search box** that filters across all 23 cards.
- All the renderer templates produce sentences without "ran run" duplication.
- The Service health card on Overview actually populates.
- Per-card Refresh buttons in Settings disappear (replaced by one section-level Refresh).
- The Reference section links to `architecture.html` and this `REFINEMENT-PLAN.md`, not `phase-f-v2-plan.html`.

If any of these still fails after the pass, the pass isn't done.
