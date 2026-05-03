# Brand Voice Archive — Claude-Code-driven analyzer

Two-step local analysis of your published content. **Uses your Claude Max plan** via Claude Code — zero API tokens spent.

```
┌────────────────────┐    ┌────────────────────────┐    ┌────────────────┐
│  Telegram +        │    │  parse-archive.js      │    │ Claude Code    │
│  Instagram exports │ ─▶ │  (parses → JSON)       │ ─▶ │ (analyzes)     │
└────────────────────┘    │  no LLM, no API cost   │    │ uses Max plan  │
                          └────────────────────────┘    └───────┬────────┘
                                                                ▼
                                                      ┌──────────────────┐
                                                      │ output/          │
                                                      │ ├ brand_voice…   │
                                                      │ ├ exemplars…     │
                                                      │ ├ voice_finger…  │
                                                      │ ├ visual_style…  │
                                                      │ └ style_refs/    │
                                                      └────────┬─────────┘
                                                               ▼
                                                      ┌──────────────────┐
                                                      │ upload.js        │
                                                      │ → control plane  │
                                                      └──────────────────┘
```

## What you get out

| File | Purpose |
|---|---|
| `output/brand_voice_profile.json` | Structural patterns: opener templates, body shapes, CTA forms, length stats per platform per language, emoji + hashtag patterns, voice signature words, banned phrases inferred |
| `output/exemplars.json` | Top exemplar captions (last-30 per platform + engagement-top) tagged with importance |
| `output/voice_fingerprint.json` | The 30-50 paragraphs Claude judged most-canonical (used by the future voice-critic agent) |
| `output/visual_style_profile.json` | Color palette, layout taxonomy, typography rules, logo placement patterns, motif library, **brand rules inferred** |
| `output/style_references/` | Top-50 reference images, ordered by importance (Afshin uses these) |
| `output/SUMMARY.md` | One-page plain-English review for you to read before uploading |

## Prerequisites

- Node 20+
- **Claude Code** desktop app (you already have this — it's what you call "Cowork")
- Active **Claude Max** subscription (or Pro)
- Your archive data (see below)

```bash
cd rxapply-cloud/tools/brand-analyzer
npm install
```

`npm install` only needs `yauzl` (for IG zip extraction). The Anthropic + OpenAI SDKs are still in `package.json` for the optional `analyze.js` API-driven path; if you don't plan to use that, you can safely ignore them.

## Getting your data

### Telegram (you already have this)

Telegram **Desktop** → your channel → **⋮ More** → **Export channel history**:
- Format: **JSON** (NOT HTML)
- Include photos: ✓
- Date range: **All time** (or last 12-24 months)

You'll have a folder with `result.json` + `photos/` subfolder.

### Instagram — if you can't sign in

You currently can't export from IG because you're not logged in. **Recover IG access first**, in priority order:

1. https://www.instagram.com/accounts/password/reset/ — email reset
2. https://help.instagram.com/contact/740949042640030 — Meta's account-recovery form
3. https://help.instagram.com/686598299863572 — trusted-contact recovery

Don't use third-party scrapers — they violate IG TOS and get accounts banned.

**Until you regain access, run on Telegram alone.** Telegram has captions + view counts (which is engagement). It's enough to extract solid patterns. Add IG later as a second pass when access is restored.

### Instagram — once you can sign in

1. https://accountscenter.instagram.com → **Your information and permissions** → **Download your information**
2. **Some of your information** → tick **Posts** + optionally **Stories** + **Reels**
3. Format: **JSON**
4. Media quality: **High**
5. Date range: **All time** (or last 18-24 months)
6. Submit. Email arrives in 1-48 hours with the .zip
7. Optionally: also export the Meta Business Suite engagement CSV from `https://business.facebook.com/latest/insights` (gives likes/saves/comments/reach)

## Run it · Step 1 — Parse

```bash
# Telegram only:
node parse-archive.js \
  --telegram "C:\path\to\Telegram-export-folder" \
  --output ./output

# With Instagram once you have it:
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
| `--telegram <folder>` | Telegram export folder (with `result.json` + `photos/`) |
| `--instagram <zip-or-folder>` | IG archive (.zip or extracted folder) |
| `--instagram-csv <path>` | Optional: Meta Business Suite engagement CSV |
| `--max-images <N>` | Cap how many images to copy (default 200; prioritises last-30 + engagement-top) |
| `--output <folder>` | Output folder (default `./output`) |

The parser produces:
- `output/archive-input.json` — every post normalised
- `output/archive-input-images/` — flat folder of priority images
- `output/posts.csv` — for spot-checking

**Zero API cost. Zero LLM calls.** Just parsing.

## Run it · Step 2 — Open Claude Code in this folder

```bash
cd tools/brand-analyzer
claude
```

Then say to Claude:

> Run the brand analysis using INSTRUCTIONS.md

Claude Code reads `INSTRUCTIONS.md`, processes the archive, looks at the images, and writes the 5 output JSONs + `SUMMARY.md`. Uses your Max-plan quota; **no API tokens billed**.

This typically takes 10-30 minutes depending on archive size. You can interrupt + resume by saying "continue from stage 4" etc.

## Run it · Step 3 — Review

Open `output/SUMMARY.md` first — Claude's plain-English summary of what was found. If it matches your sense of the brand, move on. If something is off (e.g. it picked a phrase you'd never use as a "favored phrase"), you can hand-edit the JSON files before uploading.

## Run it · Step 4 — Upload to control plane

```bash
node upload.js \
  --to https://rxapply.com \
  --token <YOUR_FOUNDER_API_TOKEN>
```

(Get the token by logging into the dashboard, opening DevTools → Application → Local Storage → copy `rxapply-auth-token`.)

The control plane consumes the 5 JSONs and:
- Updates `brand_profile.tone_patterns` + `visual_patterns` jsonb columns
- Seeds `agent_memory` exemplars for Sepehr, Avang, Goyesh, Bidar (importance 4-5)
- Writes the voice fingerprint to a new `brand_voice_fingerprint` table
- Uploads style references to R2 + creates `media_library` entries (so they appear in Designs)

(The control-plane endpoint ships in M39 part 2.)

## Resume + iterate

- Hand-edit any JSON before uploading. The patterns are yours; if Claude misread something, fix it.
- Re-run `parse-archive.js` any time — it's deterministic, so it just regenerates the same input.
- After upload, you can re-analyze with new posts (incremental ingest) — the upload endpoint will be idempotent for exemplar IDs.

## Files in this folder

```
tools/brand-analyzer/
├── README.md                    ← this file
├── INSTRUCTIONS.md              ← the prompt Claude Code follows
├── package.json
├── .env.example                 ← only needed for the optional API-driven analyze.js
├── .gitignore                   ← keeps output/ + .env out of git
├── parsers.js                   ← pure JS: telegram + instagram parsing
├── parse-archive.js             ← CLI: parse + dump archive-input.json (no LLM)
├── pipelines.js                 ← optional API-driven analysis pipelines (not used in Claude Code path)
├── analyze.js                   ← optional API-driven CLI (alternative to Claude Code)
└── upload.js                    ← post the 5 JSONs to /brand/archive/upload
```

You only need: `parsers.js` + `parse-archive.js` + `INSTRUCTIONS.md` + `upload.js` for the Claude Code workflow. The `analyze.js` + `pipelines.js` are kept in the repo as an alternative for users who don't have a Max plan — they cost ~$5 in API tokens.
