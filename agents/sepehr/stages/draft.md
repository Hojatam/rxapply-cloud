---
agent: sepehr
stage: draft
default_model_tier: standard
retry_cap: 2
outputs_schema:
  - title
  - body
  - word_count
  - tone_notes
  - length_check
  - partition_compliance
  - handoff_intent
---

Using the plan + research, write the FIRST DRAFT in the master voice for the format below.
Format: {{recipe.label}}. Length target (recipe-level guidance): {{recipe.length_target_words}}.
Master language: {{run.master_lang}}. Do NOT translate; downstream stages handle that.

CONTENT-PARTITION CONTRACT (M83 — read this first):
  The PLAN stage above produced a `content_partition` field. Open it.
    • caption_purpose tells you what the caption is FOR (tease | summarize | …)
    • caption_max_words is the explicit target word count
    • caption_must_not_include lists topics the slides will cover —
      KEEP THESE OUT of your caption. The slides educate; the caption teases.
    • slide_count_target tells you how many slides will follow.
  Your draft IS the caption. The slides come later from Tarrah.
  If `caption_must_not_include` lists "all bullet points" → don't bullet
  the answer in the caption. If it lists "the actual answer" → the caption
  asks the question; the slides answer it.

PRIORITY ORDER FOR LENGTH AND VOICE (M58/M83 hard rules):
  1. The "Brand intelligence" rules in your system prompt are the BRAND'S
     ACTUAL DATA from 5 years of real posts. They WIN over the recipe.
  2. content_partition.caption_max_words is your TARGET; respect it.
  3. Brand voice opener patterns (lead-with-bullet emoji, plain-statement
     etc.) — match the highest-frequency pattern relevant to platform+language.
  4. Brand voice CTA patterns — use the dominant statement-close style;
     hard-sell CTAs are explicitly avoided by the brand (<2% of all posts).

HARD CAPS (never exceed — automatic critique fail):
  • Instagram FA: never exceed 119 words (brand p95).
  • Telegram FA:  never exceed 139 words (brand p95).

Return ONLY this JSON:

{
  "title": "<the headline / subject / hook line>",
  "body": "<the full draft body in the master language>",
  "word_count": <integer — count words in body, you must be honest>,
  "tone_notes": "<one sentence — how the voice carries>",
  "length_check": "<one sentence — which brand length rule applies and your word count vs that range>",
  "partition_compliance": "<one sentence — confirm you respected caption_must_not_include and didn't duplicate slide content>",
  "handoff_intent": null
}
