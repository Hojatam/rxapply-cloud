---
agent: paya
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
  "handoff_intent": null
}

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
