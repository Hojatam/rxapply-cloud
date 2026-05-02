---
name: compose-ig
description: Compose an Instagram post about a topic in 3 languages (English, Persian, Arabic) plus a shared image design plan. Use when the user says "make an IG post about X", "instagram post for Y", "compose for instagram", "social post about Z", or wants to draft an Instagram-ready post with localized captions and hashtags.
---

# Compose-IG — one topic in, three Instagram captions + design plan out

## What this agent does
Takes a single short topic (one or two sentences) and produces:
- A complete Instagram caption in **English**, **Persian (fa)**, and **Arabic (ar)**
- Localized hashtags per language (mostly native script + a few universal English tags)
- A shared **design plan** for the accompanying image: concept, brand-aligned palette, layout hint, image-gen prompt, alt text

Total: one Anthropic Sonnet API call (~$0.05). Output is structured JSON ready for the Compose viewer in the dashboard.

## What this agent does NOT do
- Doesn't generate the image itself (that's Afshin, in a separate step)
- Doesn't post to Instagram (manual copy + paste, or future MCP/Graph integration)
- Doesn't write long-form articles (that's Sepehr) or do platform fan-out (that's Avang)

## Inputs
- `--topic "..."` — required. One or two sentences describing what the post is about.
- `--tone hype-free | informative | encouraging` — optional, defaults to `hype-free` per RxApply brand voice.

## Output shape
```json
{
  "topic": "...",
  "tone": "hype-free",
  "languages": {
    "en": { "caption": "...", "hashtags": ["#NDEB", ...], "first_line_hook": "...", "alt_text": "..." },
    "fa": { "caption": "...", "hashtags": [...], "first_line_hook": "...", "alt_text": "..." },
    "ar": { "caption": "...", "hashtags": [...], "first_line_hook": "...", "alt_text": "..." }
  },
  "design_plan": {
    "concept": "...",
    "image_prompt": "...",
    "palette": ["#4f46e5", "#0f172a", "#f8fafc"],
    "layout": "...",
    "typography": "Inter EN / Vazirmatn FA-AR",
    "aspect_ratio": "1:1",
    "kind": "ig_carousel_slide"
  },
  "shared_meta": { "model": "...", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0 },
  "_warnings": ["optional list of soft validation warnings"]
}
```

## Brand voice rules enforced via system prompt
- Hype-free, calm, specific (real numbers, named regulators)
- Never gives regulated advice (immigration / clinical)
- Always includes a soft CTA
- Inclusive — never mocks any country or system
- Cites only verifiable institutions by name (NDEB, ADC, GDC, DHA, etc.)

## Hashtag rules
- ≥ 8, ≤ 30 per caption
- EN: primarily English (#NDEB, #DentalMigration, #InternationalDentist) + topic-specific
- FA: 4–6 Persian (#مهاجرت_دندانپزشکی, #دندانپزشکی_بین‌المللی) + 2–3 universal English
- AR: 4–6 Arabic (#طب_الأسنان, #هجرة_الأطباء) + 2–3 universal English

## Caption rules
- ≤ 2200 chars (Instagram hard limit)
- First line is the feed-preview hook, ≤ 100 chars
- Body 80–250 words
- Hashtags appended at end after a blank line
- Max 4 emojis total

## Why no n8n
The Compose flow is **founder-initiated** — the user types a topic, the agent runs once, the dashboard shows the result for the founder to approve. No cron, no webhook. Future "auto-compose from intel signals" use cases would chain Pooya → compose-ig in the Pipelines editor; n8n adds nothing.
