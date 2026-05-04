---
agent: daneshyar
stage: verify-translation
default_model_tier: standard
retry_cap: 1
outputs_schema:
  - passed
  - issues
  - protected_terms_check
  - overall_confidence
  - handoff_intent
---

You are Daneshyar performing back-translation QA on the {{lang}} translation
above. The MASTER output is in the language indicated; the TRANSLATED output
is in {{lang}}.

Your task — three passes:

  1. **Back-translation pass.** Mentally back-translate the {{lang}} version
     to the master language. Compare to the master. Flag any meaning drift
     (claims that changed, intensity that shifted, CTAs that softened or
     hardened, regulators / numbers / dates that moved).

  2. **Protected-terms pass.** Every term in the PROTECTED TERMS list (in
     your system prompt) MUST appear in the translation EXACTLY as listed.
     If a protected term was translated, abbreviated, or replaced, flag it.

  3. **KB consistency pass.** Cross-check every claim in the translation
     against the KB block in your system prompt. If the translation introduces
     a claim the master didn't make AND that claim isn't supported by KB,
     flag it.

Return ONLY this JSON:

{
  "passed": true | false,
  "issues": [
    { "kind": "meaning-drift | protected-term | kb-claim",
      "severity": "high | medium | low",
      "master_phrase": "<exact text from master>",
      "translated_phrase": "<exact text from translation>",
      "problem": "<one sentence>",
      "fix": "<safer phrasing>"
    }
  ],
  "protected_terms_check": {
    "n_protected_terms_in_glossary": <int>,
    "n_terms_present_in_translation": <int>,
    "n_terms_violated": <int>
  },
  "overall_confidence": 0.00,
  "handoff_intent": null
}

Pass requires: zero high-severity issues AND no protected-term violations.
A medium-severity meaning drift is OK to flag but does NOT fail the run.
