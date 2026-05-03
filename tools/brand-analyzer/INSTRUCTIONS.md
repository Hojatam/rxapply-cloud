# Brand Voice Archive — Claude Code instructions

This is a self-contained set of instructions Claude Code follows to run a one-shot brand-voice analysis on a parsed archive. Read this whole file first, then execute the steps in order.

**Goal**: produce 5 output files that capture the brand's voice and visual identity, so the production agents can be seeded with them.

---

## Pre-flight check

Before running anything, confirm these files exist (the human ran `node parse-archive.js` first):

- `output/archive-input.json` — every post normalised
- `output/archive-input-images/` — top-N images copied flat
- `output/posts.csv` — flat dump for spot-checking

If they're missing, tell the user to run:
```
node parse-archive.js --telegram <path> [--instagram <path>] [--instagram-csv <path>]
```

---

## Outputs to produce

By the end you must have written, into `output/`:

1. **`brand_voice_profile.json`** — structural patterns per platform per language
2. **`exemplars.json`** — the canonical exemplar set (last-30 + engagement-top per group)
3. **`voice_fingerprint.json`** — the 30-60 paragraphs most representative of the voice (the cluster centroid, picked qualitatively since we're not embedding)
4. **`visual_style_profile.json`** — palette + layout taxonomy + logo patterns + motifs
5. **`style_references/`** — folder with the top-50 reference images copied + renamed

Plus a one-page **`SUMMARY.md`** at the end summarising what you found, in plain English, for the human to review before uploading to the control plane.

---

## Stage 1 — Read and understand the archive

Read `output/archive-input.json`. Note:
- The `counts` block tells you how many posts per (platform, language)
- `posts[]` has captions + hashtags + engagement + which images belong to each post
- `images_manifest[]` maps copied filenames back to post metadata

Read `output/posts.csv` for a sanity check — does the data look right? If something obvious is wrong (e.g. all captions are empty), stop and tell the user.

---

## Stage 2 — Text pattern analysis (per platform per language)

For each (platform, language) group with at least 5 posts, group all the captions together and extract structured voice patterns. Output goes into `output/brand_voice_profile.json` under `patterns[<platform>:<language>]`.

For each group, produce this JSON shape:

```json
{
  "platform": "telegram",
  "language": "fa",
  "n_samples": 87,
  "openers": {
    "templates": [
      { "shape": "Question to reader, 'آیا می‌دانستید…'", "example": "آیا می‌دانستید NDEB Part 1…", "frequency": 12 },
      { "shape": "Direct address with verb-first invitation", "example": "بیایید درباره GDC صحبت کنیم", "frequency": 7 }
    ]
  },
  "body_shapes": [
    { "shape": "problem→solution", "frequency": 31 },
    { "shape": "list of facts", "frequency": 18 },
    { "shape": "story arc", "frequency": 12 },
    { "shape": "data + insight", "frequency": 9 }
  ],
  "ctas": {
    "templates": [
      { "form": "soft question", "example": "نظر شما چیست؟", "frequency": 22 },
      { "form": "imperative + emoji", "example": "Save this post 📌", "frequency": 14 },
      { "form": "DM invitation", "example": "برای مشاوره DM بدهید", "frequency": 9 }
    ],
    "always_present": true
  },
  "length_stats": {
    "word_count": { "mean": 142, "p25": 98, "p75": 184, "p95": 240 },
    "line_breaks_per_100w": 4.2
  },
  "emoji": {
    "density_per_100w": 1.8,
    "favorites": ["🦷", "📌", "✅", "🌍", "💡"]
  },
  "hashtags": {
    "count_distribution": { "mean": 11, "p25": 8, "p75": 14 },
    "language_mix_pct": { "fa": 60, "en": 30, "ar": 10, "other": 0 },
    "favorites": ["#مهاجرت_دندانپزشکی", "#NDEB", "#ORE", "#dentalmigration"]
  },
  "punctuation_tics": [
    "Em-dash for asides — often used to add nuance",
    "Single line breaks for emphasis between sentences",
    "Trailing ellipsis on rhetorical questions"
  ],
  "favored_phrases": [
    "اگر این مسیر را در نظر دارید",
    "based on years of helping dentists",
    "مهم این است که"
  ],
  "voice_signature_words": ["RxApply", "مهاجرت تخصصی", "regulatory journey", "AGAM"],
  "banned_or_avoided": [
    "Hype language ('amazing', 'incredible') — never appears",
    "Aggressive sales CTAs — never used",
    "Generic motivational quotes — absent"
  ]
}
```

**Important:**
- Be PRECISE — don't invent patterns. Only list what you can verify in the captions.
- For each `frequency`, count actual occurrences across the captions, not your impression.
- If a section is genuinely sparse (e.g. only 3 CTAs found), still report what's there but say `"n_samples": 3` so the human knows.
- Pay special attention to the **openers + closers + CTA forms** — that's what the user explicitly cares about most.

If a group has fewer than 5 posts, set `"insufficient_data": true` and skip detailed extraction for that group.

---

## Stage 3 — Pick exemplars

For each (platform, language) group, pick:
- The **last 30 posts by `post_date`** — these match the user's "current desired tone"
- The **top 30 by engagement** (excluding any already in the last-30) — these match "what works"

Tag each:
- `importance: 5, source: "last-30"` for recency-picked
- `importance: 4, source: "engagement-top"` for performance-picked

Write to `output/exemplars.json`:

```json
{
  "generated_at": "<ISO timestamp>",
  "exemplars": [
    {
      "id": "tg-1234",
      "platform": "telegram",
      "language": "fa",
      "caption": "<full caption>",
      "hashtags": ["#tag1", "#tag2"],
      "post_date": "2026-04-15T10:30:00Z",
      "engagement": { "views": 4200 },
      "importance": 5,
      "source": "last-30"
    }
  ]
}
```

If `engagement` is null for everything (no metrics), just use last-30 + recency-2nd-pass (posts 31-60 by date) and tag the second batch as `source: "recency-second-pass"`.

---

## Stage 4 — Voice fingerprint (qualitative cluster)

Without embeddings, we pick the cluster qualitatively. Read the last-30 from each (platform, language) group and pick the **30-50 paragraphs that most represent the brand's typical voice**. Look for:

- Recurring tone (which paragraphs sound MOST like the brand?)
- Diversity across topics (don't pick 30 IELTS posts; cover the topic spread)
- Both languages represented proportionally
- Skip outliers (one-off announcements, repost shoutouts, very short posts)

Write to `output/voice_fingerprint.json`:

```json
{
  "generated_at": "<ISO timestamp>",
  "method": "qualitative-cluster",
  "n_total_considered": 240,
  "n_picked": 42,
  "cluster": [
    {
      "id": "tg-9876",
      "platform": "telegram",
      "language": "fa",
      "caption": "<full caption>",
      "post_date": "2026-04-20T...",
      "why_picked": "Canonical opener pattern + soft CTA + brand voice intact"
    }
  ]
}
```

Each cluster item gets a `why_picked` field — one short sentence about what makes it canonical. This becomes the seed for the future voice-critic agent.

---

## Stage 5 — Vision analysis (look at every image in the manifest)

For every image in `output/archive-input-images/`, look at it directly (Claude Code can read images). For each image, produce:

```json
{
  "file": "001-tg-1234.jpg",
  "post_id": "tg-1234",
  "platform": "telegram",
  "language": "fa",
  "style": "illustration | photoreal | minimal-vector | mixed-media | data-viz | quote-card | poster | meme",
  "layout": "hero | carousel-slide | grid | split | list | stack | quote | infographic",
  "subject": "<short — people | places | object | abstract | data | scene>",
  "dominant_colors": ["#1a4d4d", "#f4a261"],
  "accent_colors": ["#e76f51"],
  "typography": {
    "present": true,
    "weight": "heavy | medium | light | mixed",
    "size_relative_to_canvas": "tiny | small | medium | large | hero",
    "position": "top | center | bottom | left | right | overlaid | split"
  },
  "logo": {
    "present": true,
    "position": "TL | TR | BL | BR | center | none",
    "size_pct": 8,
    "opacity": "solid | semi | watermark | none"
  },
  "brand_pattern_motifs": ["thin teal frame around content", "lower-third caption strip"],
  "mood": "calm + authoritative"
}
```

Be **specific** about colors — extract them from what you actually see, not generic guesses.

For **logo position** especially: if you see the same wordmark/icon recurring at the same spot (e.g. always TR with low opacity), say so — that's a brand rule we want to capture.

For **brand_pattern_motifs**: look for recurring graphic elements (frames, lines, divider styles, icon styles, gradient directions). These are what make the brand recognizable.

After processing all images, aggregate into `output/visual_style_profile.json`:

```json
{
  "generated_at": "<ISO>",
  "n_images": 200,
  "aggregate": {
    "palette": [
      { "color": "#1a4d4d", "weight": 380, "role": "primary brand teal" },
      { "color": "#f4a261", "weight": 145, "role": "warm accent" }
    ],
    "style_distribution": { "illustration": 110, "photoreal": 50, "quote-card": 40 },
    "layout_distribution": { "carousel-slide": 80, "hero": 60, "quote": 40, "infographic": 20 },
    "typography_present_pct": 78,
    "logo_position_distribution": { "TR": 140, "BR": 30, "none": 30 },
    "logo_present_pct": 85,
    "motif_frequency": {
      "thin teal frame": 95,
      "lower-third caption strip": 60,
      "diagonal split": 22
    },
    "brand_rules_inferred": [
      "Logo placed top-right at ~8% size, semi-opacity, in 85% of designs",
      "Primary teal #1a4d4d appears in 85% of posts; secondary accent #f4a261 in ~30%",
      "Carousel slides use a thin teal frame with 24px padding",
      "Quote cards always have hero-size typography centered"
    ]
  },
  "samples": [ /* the per-image JSONs from above */ ]
}
```

The `brand_rules_inferred` array is the most important section — it's what Afshin (the design agent) will read on every image generation.

---

## Stage 6 — Style references

Pick the **top 50 images** to keep as the style reference library. Criteria, in order:

1. Posts in the last-30 group (most recent + on-current-tone)
2. Posts with high engagement
3. Diversity of layouts (not all carousel-slides; include hero shots, quote cards, infographics)
4. Each image must be brand-consistent (skip outliers, reposts of others' content)

Copy them to `output/style_references/` with names like `01-telegram-tg-1234.jpg`, `02-telegram-tg-9876.jpg`, etc. (preserving order of importance — `01` is the most canonical).

---

## Stage 7 — Summary for the human

Write `output/SUMMARY.md` — a one-page plain-English summary the human can read in 2 minutes. Include:

- **Counts**: how many posts per platform per language; date range
- **Top 5 voice rules** (e.g. "Captions on Telegram-FA are 120-180 words, always end with a soft question CTA, and use 8-12 hashtags split FA/EN.")
- **Top 5 visual rules** (e.g. "Brand teal #1a4d4d primary, sand #f4a261 accent. Logo top-right at 8% size in 85% of posts. Carousel slides have thin teal frame with 24px padding.")
- **Anything surprising** — patterns you found that the user might not have noticed
- **Anything missing** — gaps you'd want more data on (e.g. "Only 3 X/Twitter posts found — won't be able to extract reliable patterns for that platform.")

End the summary with: "Review the JSON files. If the patterns match your sense of the brand, run `node upload.js` to seed the agents."

---

## Working tips

- **Process in chunks.** If there are 500 posts, don't try to read them all in one read. Use Grep / Read with offsets to sample.
- **Cache your work.** Write each output file as soon as it's complete, so you can resume if something goes wrong.
- **Be honest about uncertainty.** If the data is sparse, say so. Don't pad with invented patterns.
- **Keep extractions concrete.** "Uses authoritative voice" is too vague. "Refers to regulators by full name in 92% of FA posts; uses 'NDEB' / 'ORE' / 'AGAM' as primary anchor terms" is useful.
