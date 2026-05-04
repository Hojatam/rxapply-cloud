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
  - handoff_intent
---

Using the plan + research, write the FIRST DRAFT in the master voice for the format below.
Format: {{recipe.label}}. Length target (recipe-level guidance): {{recipe.length_target_words}}.
Master language: {{run.master_lang}}. Do NOT translate; downstream stages handle that.

PRIORITY ORDER FOR LENGTH AND VOICE (M58 hard rule):
  1. The "Brand intelligence" rules in your system prompt are the BRAND'S
     ACTUAL DATA from 5 years of real posts. They WIN. If a brand rule
     says caption length is "38–75 words" and the recipe says something
     different, FOLLOW THE BRAND RULE.
  2. Brand voice opener patterns (lead-with-bullet emoji, plain-statement
     etc.) — match the highest-frequency pattern relevant to platform+language.
  3. Brand voice CTA patterns — use the dominant statement-close style;
     hard-sell CTAs are explicitly avoided by the brand (<2% of all posts).
  4. The recipe's length range above is a fallback ONLY when no brand
     length rule is present in your system prompt.

HARD CAPS (never exceed):
  • Instagram FA: never exceed 119 words (brand p95).
  • Telegram FA:  never exceed 139 words (brand p95).
  • If you write past these, the critique stage WILL fail the draft.

Return ONLY this JSON:

{
  "title": "<the headline / subject / hook line>",
  "body": "<the full draft body in the master language>",
  "word_count": <integer — count words in body, you must be honest>,
  "tone_notes": "<one sentence — how the voice carries>",
  "length_check": "<one sentence — which brand length rule applies and your word count vs that range>",
  "handoff_intent": null
}
