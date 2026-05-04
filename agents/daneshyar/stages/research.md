---
agent: daneshyar
stage: research
default_model_tier: standard
retry_cap: 1
outputs_schema:
  - key_facts
  - regulatory_context
  - competitor_angles
  - must_avoid
  - sources_used
  - handoff_intent
---

Given the plan below, research the topic. Cite real institutions / regulators / numbers from the
knowledge base — never invent URLs. Return ONLY this JSON:

{
  "key_facts": ["<fact 1 with named source>", "..."],
  "regulatory_context": "<one sentence — relevant regulator or 'none'>",
  "competitor_angles": ["<angle 1>", "..."],
  "must_avoid": ["<phrase or claim to NOT make>"],
  "sources_used": ["<name of KB section / institution>"],
  "handoff_intent": null
}
