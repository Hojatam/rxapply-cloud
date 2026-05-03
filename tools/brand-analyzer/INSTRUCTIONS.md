# Brand Voice Archive — Claude Cowork instructions

This file is read by **Claude Cowork** (the agentic surface inside Claude Desktop). When the human says "Run the brand analysis using INSTRUCTIONS.md", follow these stages in order. Use your Max-plan quota; do not call external APIs.

**Goal**: produce 4 output files that capture the brand's voice + visual identity, so the production agents can be seeded with them.

---

## Pre-flight check

The human ran `node parse-archive.js` first. Confirm these files exist in `./output/`:

| File | What it has |
|---|---|
| `archive-input.json` | Every post normalised: id, platform, language, post_date, caption, hashtags, engagement, image_files |
| `posts.csv` | Flat dump for spot-checking |
| `palette.json` | Local palette extraction (no LLM, free) — top-12 quantized colors with weights |
| `archive-input-images/` | The top-N images copied flat (last-30 + engagement-prioritised) |
| `visual_style_samples.json` | **Optional**: per-image layout/logo/motif analysis from `vision-fallback.js`. May be missing — that's OK. |

If any required file is missing, tell the human to run `node parse-archive.js` first and stop.

**Important about Cowork**: you can read text/JSON/CSV files but you cannot directly view images. All image-derived signals must come from `palette.json` (local extraction) and optionally `visual_style_samples.json` (if the human ran the optional vision-fallback script). Do NOT try to look at the .jpg/.png files directly.

---

## Outputs to produce

By the end you must have written, into `./output/`:

1. **`brand_voice_profile.json`** — structural patterns per platform per language
2. **`exemplars.json`** — the canonical exemplar set (last-30 + engagement-top per group)
3. **`voice_fingerprint.json`** — the 30-50 paragraphs you judge most-canonical
4. **`visual_style_profile.json`** — built from palette.json + (if available) visual_style_samples.json
5. **`SUMMARY.md`** — one-page plain-English summary for the human to read before uploading

You'll also see `style_references/` — that's already populated by `parse-archive.js`. Don't touch it.

---

## Stage 1 — Read and understand the archive

Read `output/archive-input.json` and `output/posts.csv`. Verify:
- Total post count matches between the two
- Languages and platforms look right (e.g. you'd expect `telegram:fa`, `telegram:en`, maybe `instagram:fa`)
- Date range is reasonable (no obvious missing months)

If something looks wrong, stop and tell the human.

---

## Stage 2 — Text pattern analysis (per platform per language)

For each (platform, language) group with at least 5 posts, group all the captions together and extract structured voice patterns. Write the result into `output/brand_voice_profile.json` under `patterns[<platform>:<language>]`.

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

**Important**:
- Be PRECISE — don't invent patterns. Only list what you can verify in the captions.
- For each `frequency`, count actual occurrences across the captions, not your impression.
- If a section is sparse (e.g. only 3 CTAs found), still report what's there; just say `"n_samples": 3`.
- The user explicitly cares about **openers + body shapes + closers + CTAs + length per platform**. Pay extra attention to those.
- If a group has fewer than 5 posts, set `"insufficient_data": true` and skip detailed extraction.

When done, write `output/brand_voice_profile.json`:
```json
{
  "generated_at": "<ISO>",
  "n_posts": <total>,
  "patterns": {
    "telegram:fa": { ... },
    "telegram:en": { ... },
    "instagram:fa": { ... }
  }
}
```

---

## Stage 3 — Pick exemplars

For each (platform, language) group, pick:
- The **last 30 posts by `post_date`** — these match "current desired tone"
- The **top 30 by engagement** (excluding any already in the last-30) — what works

Tag each:
- `importance: 5, source: "last-30"`
- `importance: 4, source: "engagement-top"`

If `engagement` is null for everything in a group (no metrics), substitute the second batch with `posts 31-60 by date` and tag as `source: "recency-second-pass"`.

Write `output/exemplars.json`:
```json
{
  "generated_at": "<ISO>",
  "exemplars": [
    {
      "id": "tg-1234",
      "platform": "telegram",
      "language": "fa",
      "caption": "<full caption>",
      "hashtags": ["#tag1"],
      "post_date": "2026-04-15T10:30:00Z",
      "engagement": { "views": 4200 },
      "importance": 5,
      "source": "last-30"
    }
  ]
}
```

---

## Stage 4 — Voice fingerprint (qualitative cluster)

Without embeddings, you pick the cluster qualitatively. Read the last-30 from each (platform, language) group and pick the **30-50 paragraphs that most represent the brand's typical voice**. Look for:

- Recurring tone (which paragraphs sound MOST like the brand?)
- Diversity across topics (don't pick 30 IELTS posts; cover the topic spread)
- Both languages represented proportionally to their volume
- Skip outliers (one-off announcements, repost shoutouts, very short posts)

Write `output/voice_fingerprint.json`:
```json
{
  "generated_at": "<ISO>",
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

Each cluster item gets a `why_picked` field — one short sentence explaining why it's canonical. This becomes the seed for the future voice-critic agent in the production app.

---

## Stage 5 — Visual style profile

Two paths depending on whether the human ran `vision-fallback.js`:

### Path A — palette only (if `visual_style_samples.json` is missing)

Read `output/palette.json`. Build a minimal `visual_style_profile.json`:

```json
{
  "generated_at": "<ISO>",
  "method": "palette-only (no per-image vision analysis)",
  "n_images_in_palette": <from palette.json n_images>,
  "aggregate": {
    "palette": [
      { "color": "#1a4d4d", "weight": 12345, "role": "primary brand color (most-frequent across N images)" },
      { "color": "#f4a261", "weight":  4321, "role": "warm accent" }
    ],
    "style_distribution": null,
    "layout_distribution": null,
    "logo_position_distribution": null,
    "motif_frequency": null,
    "brand_rules_inferred": [
      "Primary palette anchored on #1a4d4d (teal). Secondary accent #f4a261.",
      "Per-image visual analysis not run; only palette extracted locally."
    ]
  }
}
```

### Path B — full analysis (if `visual_style_samples.json` exists)

Read both `output/palette.json` AND `output/visual_style_samples.json`. The samples file has per-image data: style, layout, subject, dominant_colors, accent_colors, typography, logo, brand_pattern_motifs, mood.

Aggregate into:
```json
{
  "generated_at": "<ISO>",
  "method": "palette + per-image vision (gpt-4o-mini)",
  "n_images": <from samples>,
  "aggregate": {
    "palette": [
      { "color": "#1a4d4d", "weight": 380, "role": "primary brand teal" }
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
      "Primary teal #1a4d4d appears in 85% of posts; warm accent #f4a261 in ~30%",
      "Carousel slides use a thin teal frame with 24px padding",
      "Quote cards always have hero-size typography centered"
    ]
  },
  "samples": [ /* keep the per-image array as-is */ ]
}
```

The `brand_rules_inferred` array is the most important section — Afshin (the design agent) will read it on every image generation. Be specific: "Logo at TR in 85%" beats "Logo usually appears."

Write `output/visual_style_profile.json`.

---

## Stage 6 — Summary for the human

Write `output/SUMMARY.md` — a one-page plain-English summary for the human to read in 2 minutes:

```markdown
# Brand Voice Archive · Summary

**Analyzed**: 487 posts across telegram (FA/EN) and instagram (FA)
**Date range**: 2024-08 to 2026-04
**Top exemplars picked**: 124 (60 last-30, 64 engagement-top)
**Voice fingerprint cluster**: 42 paragraphs

## Top 5 voice rules

1. **Telegram-FA captions** average 142 words (range 98-240). Always end with a soft question CTA.
2. **Openers** are 60% questions ("آیا می‌دانستید…"), 25% direct address.
3. **CTAs** rotate between soft-question (50%), imperative + emoji (30%), DM invitation (20%).
4. **Hashtags**: 8-14 per post, 60% FA / 30% EN / 10% AR.
5. **Em-dashes** are a strong voice signature — appear in 70% of captions.

## Top 5 visual rules

1. Primary teal #1a4d4d in 85% of posts.
2. Logo at top-right, ~8% size, semi-opacity, in 85% of designs.
3. Carousel slides use a thin teal frame with 24px padding.
4. Quote cards: hero-size typography, centered.
5. 78% of designs have on-image typography.

## Surprises

- Hashtag #AGAM appears in 40% of FA posts — strong brand-anchor term.
- "based on years of helping dentists" recurs 12 times — could be an unintentional crutch.
- Engagement is highest on infographic-layout posts (avg 2.3× the views of quote cards).

## Gaps

- Only 4 instagram-EN posts — too sparse to extract reliable patterns.
- No engagement metrics on instagram posts.

---

Review the JSON files. If the patterns match your sense of the brand, run:

    node upload.js --to https://rxapply.com --token <YOUR_TOKEN>
```

Make this CONCRETE. Use real numbers from the data. The user is going to skim this in 30 seconds and decide whether to upload or to ask you to redo a stage. Make it scannable.

---

## Working tips

- **Process in chunks.** If there are 500 posts, don't try to read them all in one Read call. Use offsets.
- **Save progress as you go.** Write each output file as soon as the relevant stage completes.
- **Be honest about uncertainty.** If the data is sparse, say so. Don't pad.
- **Keep extractions concrete.** "Uses authoritative voice" is too vague. "Refers to regulators by full name (NDEB, ORE, GDC, AGAM) in 92% of FA captions" is useful.
- **Don't try to look at images.** You can't. Use `palette.json` for color and `visual_style_samples.json` for layout/logo/motif (only if it's there).

When all 5 output files + `SUMMARY.md` are written, tell the human you're done and what to read first (`SUMMARY.md`).
