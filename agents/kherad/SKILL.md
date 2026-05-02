---
name: kherad
description: Kherad is RxApply's content quality scorer. After Sepehr writes an EN master and Goyesh translates it to FA/AR, Kherad reads the asset, scores it against four hard rules (citation density, banned-word filler, keyword coverage from Ramin's latest candidates, factual anchoring in intel_snapshots), and writes a quality verdict. Assets scoring ≥0.7 advance to G2 (founder approval); below that, Kherad writes one row per issue to the corrections table so a refinement pass knows what to fix. Use this skill whenever the user says "run kherad", "score this article", "check the master quality", "any issues with the FA translation", or asks anything about whether a content_asset is publish-ready. Kherad drives the G2 gate.
---

# Kherad — Content Quality Scorer

Kherad answers: **"Is this article publish-ready, and if not, what specifically needs fixing?"**

## Inputs

Kherad reads `content_assets` rows whose `status='pending_g2'`. For each one he checks four rules:

1. **Citation density** — at least 1 citation per ~400 words of `body_md`. Below 1 per 800 words is a fail.
2. **Banned-word filler** — list of marketing-fluff words ("absolutely", "ultimate", "game-changing", "supercharge", …). Each occurrence costs 0.05 from the score.
3. **Keyword coverage** — Ramin's latest `keyword_candidates` payload from `intel_snapshots`. The article's body should contain at least 30% of those keywords' top phrases.
4. **Factual anchoring** — the asset's brief's `source_citations` must point to real `intel_snapshots.id` rows that still exist. A dead pointer is a fail.

He computes a 0–1 quality score from those four signals. The score is written to a journal row (and, in production, would update an `agent_efficiency.quality_score` rollup). For each rule that fails, Kherad writes one row to `corrections` with `before_text` describing the issue and `after_text` empty (a refinement agent will fill it).

## Output

For each scored asset:

- **journal**: one Zirak row, `status=success` if quality≥0.7 else `status=fail` with the issue list in `output_summary`.
- **corrections**: zero or more rows depending on issues found.
- **content_assets.status**: updated to `g2_ready` (≥0.7) or `needs_refine` (<0.7).
- **stdout**: a JSON summary of `[{asset_id, score, issues, status}]`.

## How to call Kherad

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/kherad/kherad.py" run
python kherad.py score <asset-uuid>     # score one asset, no DB writes
python kherad.py issues <asset-uuid>    # detailed per-rule breakdown
```

`run` walks every `pending_g2` asset.

## Voice

Diagnostic, specific. The `issues` array contains one short string per failed rule: `"citation density 1/1300w (need 1/400w)"`, `"banned-words: 'ultimate', 'supercharge'"`, etc.

## Edge cases

- **No `pending_g2` assets**: emits zero scores and journals "no assets to score".
- **No Ramin keywords yet**: rule 3 is skipped (not failed) and the issue list notes "no keyword baseline".
- **Postgres unreachable**: same handling as the rest — non-zero exit with Zirak fail.
