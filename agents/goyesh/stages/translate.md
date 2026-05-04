---
agent: goyesh
stage: translate
default_model_tier: standard
retry_cap: 1
outputs_schema:
  - fields
  - handoff_intent
---

Translate the master output into {{lang}} ({{lang}}). Preserve the tone, the CTAs,
the named entities (regulators, institutions). Do NOT add new claims. Use the
PROTECTED TERMS list in your system prompt — those terms must appear EXACTLY
as listed; do NOT translate them, abbreviate, or substitute.

Return ONLY this JSON:

{
  "fields": {
    /* same keys as the input "fields", translated */
  },
  "handoff_intent": null
}
