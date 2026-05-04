---
agent: avang
stage: adapt
default_model_tier: standard
retry_cap: 1
outputs_schema:
  - fields
  - handoff_intent
---

Reshape the approved draft into channel-native form for {{recipe.label}}. Produce the fields
listed in params.produce. Return ONLY this JSON:

{
  "fields": {
    /* keys from params.produce — e.g. for email: "subject", "preview", "body" */
  },
  "handoff_intent": null
}
