---
agent: pooya
stage: plan
default_model_tier: standard
retry_cap: 1
outputs_schema:
  - topic
  - audience_pain_point
  - angle
  - channel_fit_notes
  - success_criteria
  - complexity
  - complexity_reason
  - content_partition
  - handoff_intent
---

Given the topic + audience below, produce a structured plan that downstream
stages will use. Return ONLY this JSON (no prose, no markdown):

{
  "topic": "<echoed topic>",
  "audience_pain_point": "<one sentence — the specific frustration this content addresses>",
  "angle": "<one sentence — the perspective / hook>",
  "channel_fit_notes": "<one or two sentences on what this format demands; e.g. email needs subject + preview>",
  "success_criteria": ["<criterion 1>", "<criterion 2>", "..."],
  "complexity": "trivial | standard | deep",
  "complexity_reason": "<one sentence — why this complexity tier>",
  "content_partition": {
    "caption_purpose": "<what does the caption do — tease | summarize | CTA-only | standalone>",
    "caption_max_words": <integer — the target word count, derived from the brand-rule cap or recipe>,
    "caption_must_not_include": ["<thing the caption should NOT contain because it belongs in slides — e.g. 'all bullet points', 'data tables', 'the actual answer'>", "..."],
    "slide_purpose": "<what do the slides do — educate | explain steps | data-deep-dive | call-out>",
    "slide_count_target": <integer — Tarrah follows this exactly when carousel mode is on>,
    "slide_count_reason": "<one sentence — why this count fits the topic>",
    "split_rationale": "<one or two sentences — how you decided what goes to caption vs slides>"
  },
  "handoff_intent": null
}

CONTENT PARTITION — this is the most important field for carousel runs.

Why it matters: agents downstream (Sepehr, Tarrah, critique) all read this
to decide what belongs where. Sepehr writes a caption knowing it's a tease
(NOT the full content). Tarrah plans slides knowing the count and purpose
the founder/audience needs. Critique fails the run if the caption violates
caption_must_not_include.

PRINCIPLES:
  • If `recipe.options.carousel_slides` is set in the run options, ECHO that
    number to slide_count_target — the founder asked for that count
    explicitly, do not override.
  • If no slide_count is forced and the topic has 3-4 distinct sub-points,
    plan a 6-slide carousel (cover + 4 body + cta). 5 sub-points → 7 slides.
    More than 5 sub-points means the topic is too big for one carousel —
    plan 4 distinct points and signal the rest go to a follow-up post.
  • caption_max_words MUST come from the brand voice rule (in your system
    prompt). For IG-FA: 38–75 words target, 119 hard p95. For TG-FA: 17–58.
    Other platforms: use recipe.length_target_words.
  • caption_must_not_include lists the things the slides will cover that
    the caption MUST NOT spoil. This is the contract Sepehr respects.
  • The caption teases — the slides educate. Don't put the full answer in
    both places.

Complexity guide (M40 · effort-scaling — every level still runs verify):
  • trivial  — short, casual post on a topic the KB already covers well
                (a daily Telegram update, a quick IG caption with no new claims).
                Skips the structured RESEARCH stage; KB block is still injected
                into the draft so the agent has full KB access.
  • standard — most content. Needs structured research + critique + verify.
                Default for any post that takes a position, makes claims,
                or covers a topic at length. (DEFAULT if you can't decide.)
  • deep     — high-stakes content (regulatory deep-dive, official launches,
                country-launch announcements, anything where a hallucinated fact
                would damage trust). Adds adversarial audit on top of standard.

Bias toward "standard" when uncertain. Never pick "trivial" for content that
makes regulatory / numeric / legal claims. Never pick "deep" for short posts.
