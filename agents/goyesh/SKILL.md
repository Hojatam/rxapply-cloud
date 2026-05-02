---
name: goyesh
description: Goyesh is RxApply's translation + cultural re-weighting agent. It takes one EN master article from content_assets and produces a Markdown version in Farsi (fa) or Arabic (ar) that matches the section structure, preserves all [^citation] markers, but adjusts examples, emphasis, and statistics for the target audience. FA gets the Iranian credential-conversion angle. AR gets the Gulf private-practice angle. Use this skill whenever the user says "run goyesh", "translate this master to FA/AR", "make the Farsi version", "produce the Arabic version", or wants to test scenario T3 of the test phase. Also use it whenever the user wants to fan an EN article out to Iranian or Arab audiences.
---

# Goyesh — EN master → FA / AR culturally-reweighted versions

Goyesh is the third link in RxApply's content chain. Sepehr writes the EN long-form. Goyesh produces the Farsi and Arabic versions that aren't just translations — they're culturally re-tilted for audiences with different decision-making contexts.

## Inputs

One row from `content_assets` where `kind = 'master'` and `language = 'en'`, fetched by id. The relevant fields:

- `brief_id` — keep this; the new row points at the same brief
- `body_md` — the English article you'll re-version
- `body_json` — counts (word_count, citation_count, h2_count) you'll try to roughly match

Plus a target language code: `fa` or `ar`.

## Output

One Markdown document per target language, saved as a new row in `content_assets` with:

- `brief_id` = same UUID as the EN master
- `language` = `fa` or `ar`
- `kind` = `master`
- `body_md` = the translated, re-weighted article
- `status` = `pending_g2` (gate G2 covers all language masters before Avang fans out to platforms)
- `body_json` = `{word_count, citation_count, h2_count}`

Constraints:

- **Match section structure.** Same number and ordering of H2 sections. Same TLDR-then-body-then-FAQ shape. Same H1 (translated). The downstream platform fan-out (Avang) relies on a stable cross-language structure.
- **Preserve [^N] citation markers.** Every `[^N]` from the EN that you're keeping a paragraph for must appear in the translation, attached to the equivalent claim. Footnotes at the bottom must reference the same `intel_snapshot:<uuid>` strings as the EN. Don't invent new citations.
- **Length: 80–110% of EN word count.** Substantially shorter loses fidelity; substantially longer means you're writing a different article. Aim within 10% if you can.
- **Disclaimer line is non-negotiable** in any language, translated appropriately.

## Cultural re-weighting rules

These are *not* style changes — they're substantive shifts in what gets emphasised vs. mentioned vs. cut.

### FA (Farsi, Iranian audience)

The default reader is an Iranian-trained dentist with 5+ years of practice, weighing migration as a credential-conversion problem. Their decision pivot is "how do my Iranian DDS, my exam scores, and my clinical hours convert into a recognised credential abroad?"

- **Foreground**: NDEB Canada specifics; how Iranian dental degrees evaluate at WES/ECE; bridging programs that have explicit Iranian-credential pathways (UofT IDAPP, UWO); German Approbation if the candidate has B2 German.
- **Background**: General "Western country options" framing. Iranians rarely target Australia/NZ; UK is harder because of GDC backlog *and* visa specifics for Iranian passport holders.
- **Examples and persona**: family-with-kids context is more salient than single. Emphasise schools, healthcare, and Persian-speaking community hubs (Toronto, Vancouver, Hamburg).
- **Numbers**: keep the Roya fa-canada +18% data point prominent — it's the strongest signal Iranian readers respond to.

### AR (Arabic, Gulf/Egyptian audience)

The default reader is an Arabic-speaking dentist (Egyptian, Jordanian, Lebanese, Syrian, Palestinian) practising in or willing to move within MENA, weighing migration as a private-practice income problem. Their decision pivot is "what's the cost-vs-income return of a credential conversion abroad vs. a faster regional move?"

- **Foreground**: DHA/MOH/HAAD pathways in the UAE (closer to home, faster, no full bridging). Saudi Arabia's expanding private market. UK ORE for those who can clear IELTS 7.5+ and have the GDC patience. Canada gets one substantive section but framed as the long-game alternative, not the default.
- **Background**: The 24-month NDEB/OSCE timeline is less of a sell to this audience than to the Iranian one. Don't over-explain Canadian bridging programs; one paragraph naming UofT IDAPP as the gold-standard option is enough.
- **Examples and persona**: married-no-kids or single, low-to-medium budget, income-prioritising. Family infrastructure matters less than first-year earning ceiling.
- **Numbers**: keep the Roya ar-uae +14% / DHA fee reduction front and centre.

## Workflow when invoked

The user will name the master (by id, brief title, or descriptor) and the target language(s). If both `fa` and `ar` are wanted, do them sequentially — run the helper twice.

### 1. List or fetch the master

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/goyesh/goyesh.py" list-masters
```

Lists EN masters with id, title, word_count, brief_id. Pick the right one.

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/goyesh/goyesh.py" fetch <asset_id>
```

Fetches the full EN master (including `body_md`).

### 2. Re-weight, then translate

Read the EN article completely. For each H2 section, decide:

- **Keep, translate as-is** — applies to most structural sections (H1, TLDR shape, FAQ shape).
- **Keep, re-weight** — adjust which examples lead, which sub-points get more space.
- **Cut and replace** — drop a section that's irrelevant to the target audience and substitute one that's relevant. Use sparingly: more than 2 cut/replace operations means you're drifting from the master.

Then write the translated Markdown. **Translate fluently — don't word-for-word.** Idiomatic FA/AR matters; awkward calques are worse than slight content drift.

### 3. Save

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/goyesh/goyesh.py" save \
    --master-id <en_asset_id> --language fa < article-fa.md
```

The script INSERTs the new row, computes stats, and prints `<new_id>|<language>|<kind>`.

### 4. Confirm and self-check

In your reply, report:

- The new asset id, language, word count, citation count, H2 count
- Pass/fail for the T3 criteria:
  - Contains `/[؀-ۿ]/` Farsi or Arabic Unicode block? (the helper computes this)
  - Word count ≥80% of EN?
  - Citation count ≥80% of EN?
  - H2 count matches?

## Edge cases

- **Master not found / not EN / not kind=master**: abort and tell the user.
- **Already a non-EN master for this brief**: warn the user; ask to overwrite or insert a second.
- **Citation count drops below 80%**: re-draft. Don't ship a translation that's lost the evidence base.
- **A section genuinely doesn't apply** to the target audience: cut it, but keep the H2 count by adding an audience-relevant section. Don't quietly shrink the structure.

## Why no n8n

In production, n8n would fan-out Goyesh to FA + AR in parallel via cowork-proxy `/run-agents-parallel` and then trigger the G2 gate. For test-phase validation we run it sequentially as a Cowork skill — the parallelism doesn't change correctness, only wall-clock. T3's pass criteria don't include "did it run in parallel," so sequential is fine for the scorecard.
