# Brand Voice Archive — local analyzer

A local CLI that ingests your **Telegram channel export** and **Instagram
archive**, runs multi-modal analysis (text + vision), and produces 5 JSON
files plus a folder of style-reference images. You then upload those
results to the control plane (one HTTP call) and every relevant agent +
Afshin starts producing within your voice.

**Why local?** The analysis is a one-shot heavy job (10-30 min of LLM
calls). Doing it on your PC keeps the archive private, uses your
personal Anthropic/OpenAI quotas instead of the deployment's, and avoids
adding 1000+ images to the production database.

## What you get out

| File | Purpose |
|---|---|
| `output/brand_voice_profile.json` | Structural patterns: opener templates, body shapes, CTA forms, length stats per platform per language, emoji + hashtag patterns, voice signature words, banned phrases inferred |
| `output/exemplars.json` | Top exemplar captions (last-30 per platform + auto-clustered) with embeddings, importance scores, language tags |
| `output/voice_fingerprint.json` | The embedding cluster of your most-typical voice paragraphs — used by the new voice-critic agent |
| `output/visual_style_profile.json` | Color palette histogram, layout taxonomy, typography rules, logo-placement patterns, brand-pattern motifs |
| `output/style_references/` | Top-50 exemplar images, copied + renamed for the style reference library |
| `output/posts.csv` | Flat dump of every post for spot-checking |

## Prerequisites

- Node 20+
- An Anthropic API key (`ANTHROPIC_API_KEY`)
- An OpenAI API key (`OPENAI_API_KEY`) — used for embeddings only; cheaper than Anthropic for that
- Your archive data (see "Getting your data" below)

```bash
cd rxapply-cloud/tools/brand-analyzer
npm install
```

## Getting your data

### 1. Telegram channel export (you already have this)

In Telegram **Desktop** (mobile doesn't support exports):

1. Open your channel → **⋮ More** → **Export channel history**
2. Format: **JSON** (not HTML)
3. **Include photos** ✓
4. Date range: **All time** (or last 12-24 months — recent posts matter more)
5. Wait for it to finish, save the folder somewhere obvious like `~/Desktop/rxapply-tg-export/`

You'll have a folder with `result.json` and a `photos/` subfolder. That's the input we need.

### 2. Instagram archive (you don't have this yet — here's how)

Two paths — pick whichever is faster for you. Path B is recommended.

#### Path A — desktop browser (easiest)

1. Go to **https://accountscenter.instagram.com**
2. Click **Your information and permissions** → **Download your information**
3. Click **Request a download**
4. Choose **Some of your information** → tick **Posts** (under "Your Instagram activity") + optionally **Stories** + **Reels**
5. **Format**: **JSON** (NOT HTML — JSON is structured and we can parse it)
6. **Media quality**: High
7. **Date range**: All time (or last 18-24 months)
8. Click **Submit request**
9. Instagram emails you when ready (1-48 hours, usually a few hours)
10. Download the .zip from the email link

The zip contains `posts_1.json` (and posts_2 etc. if many posts), and a `media/` folder. That's the input.

#### Path B — Meta Business Suite (faster + includes engagement!)

If your Instagram is a **Business or Creator** account connected to a Facebook Page:

1. Go to **https://business.facebook.com/latest/insights/results**
2. Pick your IG account in the top-left
3. **Date range**: last 24 months
4. **Content**: Posts → tick "All posts"
5. Click **Export** → CSV
6. You get a CSV with: post ID, caption, timestamp, **likes**, **comments**, **saves**, **reach**, **engagement rate**
7. Separately, download the post images (or skip — the analyzer can fetch them via IG Graph API if you provide a token)

This path **gives you engagement metrics** the analyzer will use to weight exemplars.

#### Path C — IG Graph API (if you already have it wired in your tools framework)

If you have an IG Long-Lived Access Token + IG Business Account ID:

```bash
node analyze.js --ig-fetch --ig-token <YOUR_TOKEN> --ig-account-id <YOUR_IG_ID> --ig-limit 200
```

Pulls last N posts via the Graph API including all engagement metrics. No manual export needed.

## Usage

### Step 1 — Configure

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY + OPENAI_API_KEY
```

### Step 2 — Run analysis

```bash
node analyze.js \
  --telegram /path/to/Telegram-export-folder \
  --instagram /path/to/instagram-archive.zip \
  --output ./output
```

Run flags:

| Flag | What |
|---|---|
| `--telegram <path>` | Folder containing Telegram's `result.json` and `photos/` |
| `--instagram <path>` | Path to IG archive .zip OR a folder you've extracted |
| `--instagram-csv <path>` | Path to Meta Business Suite CSV (for engagement) — pairs with `--instagram` |
| `--ig-fetch` | Use IG Graph API instead of an archive (requires --ig-token + --ig-account-id) |
| `--output <path>` | Where to write the result JSON files (default: `./output/`) |
| `--vision-model <name>` | `claude-opus-4-7` (default) or `gpt-5.5-vision` |
| `--text-model <name>` | `claude-opus-4-7` (default) — used for pattern extraction |
| `--max-images <N>` | Cap how many images to vision-analyze (default: 200; cost: ~$0.02/image) |
| `--exemplars-per-lang <N>` | How many top exemplars to keep per language (default: 30) |
| `--dry-run` | Parse only, no LLM calls — sanity-check your data first |
| `--resume` | Continue from where a previous run left off (cached LLM results) |

### Step 3 — Review

```bash
ls output/
# brand_voice_profile.json
# exemplars.json
# voice_fingerprint.json
# visual_style_profile.json
# style_references/
# posts.csv
```

Open `posts.csv` in a spreadsheet and skim — make sure parsing worked.
Open `brand_voice_profile.json` and read the extracted patterns —
this is the single most important file. If something looks wrong
(e.g. it picked up a phrase you actually never use), you can edit
the JSON before uploading.

### Step 4 — Upload to the control plane

```bash
node upload.js \
  --to https://rxapply.com \
  --token <YOUR_FOUNDER_API_TOKEN> \
  --output ./output
```

This POSTs each JSON file to `/brand/archive/upload`, uploads style
reference images to R2, and triggers seeding of agent memories +
brand_profile enrichment.

## Cost estimate

For 500 captions + 1,500 images (typical solo founder archive):

| Step | Model | Cost |
|---|---|---|
| Text pattern analysis | Claude Opus 4.7 (~5 calls × ~$0.50) | $2.50 |
| Vision analysis | Claude Opus 4.7 vision @ ~$0.01/image × 200 images | $2.00 |
| Voice fingerprint embeddings | text-embedding-3-large @ ~$0.13/M | $0.05 |
| Engagement-weighted ranking | local code | $0 |
| **Total** | | **~$5** |

Bumping `--max-images` to 1500 and using `gpt-5.5-vision` instead pushes
to ~$15-25.

## Resume / cache

The analyzer caches every LLM response in `output/.cache/`. If your
power dies or you Ctrl-C, just re-run with `--resume` and it picks up
from the last completed step. Useful when iterating on the prompts.

## Privacy

Nothing leaves your machine except:
- LLM API calls (Anthropic + OpenAI) — only the captions/images you analyze
- The final upload to your own control plane (one POST when you're ready)

The `output/` folder is gitignored. Don't commit it.
