---
agent: kherad
stage: critique
default_model_tier: standard
retry_cap: 2
outputs_schema:
  - verdict
  - verdict_reason
  - word_count
  - length_rule_applied
  - scores
  - actionable_fixes
  - handoff_intent
---

Score the draft below against brand voice + format rules. Brand-voice rules in
your system prompt are the SOURCE OF TRUTH (5 years of real post data).

LENGTH CHECK — do this first, mechanically:
  1. Count words in draft.body.
  2. Look up the platform+language length rule in your "Brand intelligence"
     block (e.g. "instagram-fa caption length: target 38.5-75.5 words ...
     p95 = 119; rarely exceed").
  3. If word count > p95 from the brand rule → set verdict = "fail" and
     length_score = 0.00 with the actionable_fix "Cut to <range> words —
     current draft is N words, brand p95 is M".
  4. If word count is between target_max and p95 → length_score = 0.50,
     verdict at most "needs_refine", actionable_fix to bring it into target.
  5. If word count is in target range → length_score = 1.00.
  6. If word count is far below target_min → length_score = 0.50 (under-spec).

Return ONLY this JSON:

{
  "verdict": "pass" | "needs_refine" | "fail",
  "verdict_reason": "<one sentence — call out length explicitly if that's the issue>",
  "word_count": <integer>,
  "length_rule_applied": "<the exact brand length rule you applied, verbatim>",
  "scores": {
    "brand_voice": 0.00,
    "specificity": 0.00,
    "cta_present": 0.00,
    "banned_phrases_clean": 0.00,
    "format_fit": 0.00,
    "length_fit": 0.00
  },
  "actionable_fixes": ["<fix 1>", "..."],
  "handoff_intent": null
}

A draft passes if every score >= 0.70 AND no banned phrase AND word_count <= brand p95.
Length over p95 is an automatic FAIL regardless of other scores.
