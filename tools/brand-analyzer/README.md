# Brand Voice Archive — Cowork-driven analyzer

Local analysis of your published content using **Claude Cowork** (the agentic surface inside Claude Desktop). **Uses your Claude Max plan** — zero API tokens.

```
┌────────────────────┐    ┌────────────────────────┐    ┌────────────────────┐
│  Telegram +        │    │  parse-archive.js      │    │ Claude Cowork      │
│  Instagram exports │ ─▶ │  (parses + palette)    │ ─▶ │ (text analysis)    │
└────────────────────┘    │  no LLM, no API cost   │    │ Max plan, no API   │
                          └────────────────────────┘    └─────────┬──────────┘
                                       │                          │
                                       │   (optional vision)      │
                                       ▼                          ▼
                            ┌──────────────────────┐    ┌──────────────────┐
                            │ vision-fallback.js   │    │ output/          │
                            │ ~$0.20 for 200 imgs  │    │ ├ brand_voice…   │
                            │ adds layout/logo/    │ ─▶ │ ├ exemplars…     │
                            │ motif analysis       │    │ ├ voice_finger…  │
                            └──────────────────────┘    │ ├ visual_style…  │
                                                        │ └ SUMMARY.md     │
                                                        └────────┬─────────┘
                                                                 ▼
                                                        ┌────────────────┐
                                                        │ upload.js      │
                                                        │ → control plane│
                                                        └────────────────┘
```

## What is Claude Cowork?

The agentic surface inside Claude Desktop (Mac + Windows). Reads/writes files in folders you grant access to, executes scripts in a sandbox VM, uses your **paid Claude.ai subscription quota** (not API tokens).

It's perfect for our text-heavy analysis pass — but it currently **doesn't view images directly**. So image-derived signals (palette, layout, logo, motifs) come from the local script + an optional ~$0.20 vision fallback.

Anthropic docs: https://www.anthropic.com/product/claude-cowork

## What you get out

| File | Purpose |
|---|---|
| `output/brand_voice_profile.json` | Structural patterns: opener templates, body shapes, CTA forms, length stats per platform per language, emoji + hashtag patterns, voice signature words |
| `output/exemplars.json` | Top exemplar captions (last-30 per platform + engagement-top) tagged with importance |
| `output/voice_fingerprint.json` | The 30-50 paragraphs Cowork judged most-canonical |
| `output/visual_style_profile.json` | Color palette + (optionally) layout/logo/motif aggregate |
| `output/style_references/` | Top-50 reference images, ordered by importance (Afshin uses these) |
| `output/SUMMARY.md` | One-page plain-English review |

## Prerequisites

- **Node 20+** (for parse-archive.js)
- **Claude Desktop** with Cowork enabled (Mac or Windows): https://claude.com/download
- An active **Claude Pro / Max / Team / Enterprise** plan
- Your archive data (see "Getting your data" below)

```bash
cd rxapply-cloud/tools/brand-analyzer
npm install
```

## Getting your data

### Telegram (you already have this)

Telegram **Desktop** → your channel → **⋮ More** → **Export channel history**:
- Format: **JSON** (NOT HTML)
- Include photos: ✓
- Date range: **All time** (or last 12-24 months)

You'll have a folder with `result.json` + `photos/` subfolder.

### Instagram — you need to recover account access first

You said you can't sign in to Instagram, which is blocking the export. There's no legitimate workaround:

1. https://www.instagram.com/accounts/password/reset/ — email reset
2. https://help.instagram.com/contact/740949042640030 — Meta's account-recovery form
3. https://help.instagram.com/686598299863572 — trusted-contact recovery

Don't use third-party scrapers — they violate IG TOS and get accounts banned. Your account is too valuable to risk.

**Until you recover access, run on Telegram alone.** It has captions + view counts (engagement). It's enough. Add IG as a second pass when access is restored — the analyzer is incremental.

### Instagram — once you can sign in

1. https://accountscenter.instagram.com → **Your information and permissions** → **Download your information**
2. **Some of your information** → tick **Posts** + optionally **Stories** + **Reels**
3. Format: **JSON** · Media quality: **High** · Date range: **All time**
4. Submit. Email arrives in 1-48 hours with the .zip.
5. Optionally also export the Meta Business Suite engagement CSV for likes/saves/comments/reach.

## Run it · Step 1 — Parse (always free)

```bash
# Telegram only — what you can do today:
node parse-archive.js \
  --telegram "C:\path\to\Telegram-export-folder" \
  --output ./output

# Once you have IG too:
node parse-archive.js \
  --telegram "C:\path\to\Telegram-export-folder" \
  --instagram "C:\path\to\instagram-archive.zip" \
  --instagram-csv "C:\path\to\meta-business-suite.csv" \
  --output ./output \
  --max-images 200
```

Flags:

| Flag | What |
|---|---|
| `--telegram <folder>` | Telegram export folder |
| `--instagram <zip-or-folder>` | IG archive (.zip or extracted folder) |
| `--instagram-csv <path>` | Optional: Meta Business Suite engagement CSV |
| `--max-images <N>` | Cap how many images to copy + extract palette from (default 200) |
| `--output <folder>` | Output folder (default `./output`) |

This pre-pass:
- Parses both archives into a single `archive-input.json`
- Copies the top-N images (last-30 + engagement-prioritised) into `archive-input-images/`
- **Extracts a brand color palette locally** with `node-vibrant` (no LLM, no API) → `palette.json`
- Dumps `posts.csv` for spot-checking

## Run it · Step 2 — Open Cowork

1. Open **Claude Desktop**
2. Switch to the **Cowork** tab
3. **Add this folder** to Cowork's allowed paths: `tools/brand-analyzer/` (or its parent)
4. In a new Cowork chat, paste:

> Run the brand analysis using INSTRUCTIONS.md

That's it. Cowork:
- Reads `archive-input.json`, `posts.csv`, `palette.json`
- Runs the 6 stages described in `INSTRUCTIONS.md`
- Writes `brand_voice_profile.json`, `exemplars.json`, `voice_fingerprint.json`, `visual_style_profile.json`, `SUMMARY.md`
- Asks you to review along the way (you can interrupt or correct)

This typically takes 10-30 minutes depending on archive size, and counts against your **Max-plan usage allocation** — no API tokens billed.

## Run it · Step 3 — (optional) Add layout/logo/motif analysis

If you want layout / logo placement / motif analysis (in addition to palette), run the **vision fallback** script. Cost: about $0.20 for 200 images using OpenAI's `gpt-4o-mini` vision.

```bash
# Set OPENAI_API_KEY in .env (only used by this optional script)
copy .env.example .env
notepad .env

node vision-fallback.js --max-images 200
```

This writes `output/visual_style_samples.json`. When Cowork runs Stage 5, it'll automatically pick up this file and produce a richer `visual_style_profile.json`. If the file isn't there, Cowork falls back to palette-only analysis (still useful, just less detailed).

You can run this BEFORE or AFTER opening Cowork — either order works.

## Run it · Step 4 — Review

Open `output/SUMMARY.md` first — Cowork's plain-English summary of what was found. If it matches your sense of the brand, move on. If something is off (e.g. Cowork picked a phrase you'd never use as a "favored phrase"), you can hand-edit the JSON files before uploading. The patterns are yours.

## Run it · Step 5 — Upload to control plane

```bash
node upload.js \
  --to https://rxapply.com \
  --token <YOUR_FOUNDER_API_TOKEN>
```

(Get the token from your dashboard's localStorage → `rxapply-auth-token`.)

The control-plane endpoint (M39 part 2, shipping next) consumes the 5 JSONs and:
- Updates `brand_profile.tone_patterns` + `visual_patterns` JSONB columns
- Seeds Sepehr / Avang / Goyesh / Bidar `agent_memory` with exemplars (importance 4-5)
- Stores the voice fingerprint in a new `brand_voice_fingerprint` table
- Uploads style references to R2 + creates `media_library` entries (so they appear in Designs)

## Files in this folder

```
tools/brand-analyzer/
├── README.md                  ← this file
├── INSTRUCTIONS.md            ← what Cowork follows
├── package.json
├── .env.example               ← only needed for vision-fallback.js
├── .gitignore
├── parsers.js                 ← pure-JS Telegram + IG parsing
├── parse-archive.js           ← CLI: parse + palette + flat image dump (no LLM, free)
├── vision-fallback.js         ← OPTIONAL: ~$0.20 layout/logo/motif via gpt-4o-mini
├── pipelines.js               ← (legacy) full API-driven pipelines, only if you don't have Max
├── analyze.js                 ← (legacy) API-driven CLI, only if you don't have Max
└── upload.js                  ← POST 5 JSONs to /brand/archive/upload
```

For the Cowork workflow you only use: `parsers.js` + `parse-archive.js` + `INSTRUCTIONS.md` + (optional) `vision-fallback.js` + `upload.js`. The `analyze.js` + `pipelines.js` are kept for users without a Max plan.

## Resume / iterate

- All output files are JSON — you can hand-edit any of them before uploading.
- `parse-archive.js` is deterministic — re-run any time.
- `vision-fallback.js` caches per-image results in `output/.cache-vision/` — interrupting + re-running is free.
- After upload, you can re-run with new posts later — the upload endpoint is idempotent on exemplar IDs.

## Privacy

Nothing leaves your computer except:
- Cowork uses your Claude.ai subscription (Anthropic's servers, but no API key in your code)
- (Optional) `vision-fallback.js` calls OpenAI for image analysis
- The final upload to your own control plane (one HTTP call when you're ready)

`output/` is gitignored. Don't commit it.
