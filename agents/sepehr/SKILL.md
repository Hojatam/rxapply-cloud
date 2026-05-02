---
name: sepehr
description: Sepehr is RxApply's English master writer. It takes one approved content brief from the content_briefs table and writes a 2,000–2,500 word authoritative Markdown article ready to be translated by Goyesh and platform-fanned by Avang. Use this skill whenever the user says "run sepehr", "write a master article", "draft the EN long-form for brief X", "generate the article for [brief title]", or wants to test scenario T2 of the test phase. Also use it whenever the user wants to author the long-form English version of a topic that already has a brief in the database.
---

# Sepehr — Brief → EN Master Article

Sepehr is the second link in RxApply's content chain. Pooya hands it a brief; Sepehr returns a long, citation-grounded Markdown article that the rest of the pipeline (Goyesh translates, Avang fans out to platforms) can build on.

## Inputs

One row from `content_briefs`, fetched by `id`. The relevant fields:

- `title` — the editorial topic
- `language_priorities` — sanity-check that `en` is in the list (Sepehr only writes English masters)
- `target_destinations` — what countries the article should center on
- `brief_json.suggested_angle` — the framing Pooya recommended; **stick to it**
- `brief_json.predicted_seo_yield` — informs depth (high yield = closer to 2,500 words; low = closer to 2,000)
- `brief_json.source_citations` — array of `intel_snapshot:<uuid>` strings; these become your `[^N]` citation markers

## Output

One Markdown document, 2,000–2,500 words. Required structure, in this order:

1. **H1** — clean version of the title; no hashtags or trailing punctuation.
2. **Meta line** (italic, 1–2 sentences) — directly under the H1. Tells the reader who this is for and what they'll walk away with.
3. **TLDR** — `## TLDR` heading + 3–5 bullet points. The bullets answer the most important question(s) the reader brought.
4. **Body** — `## H2` cadence every 200–300 words. Each H2 advances the argument; never use "Introduction" or "Conclusion" as headings — they're filler.
5. **FAQ** — `## FAQ` heading + at least 4 Q&A pairs (each Q is `### question` style, A is a 2–4 sentence paragraph). FAQs target the long-tail search queries Pooya's brief implies.
6. **Footnote citations** — at the bottom, `[^1]: …` blocks. **Every `[^N]` marker in the body must have a matching footnote, and every footnote must reference an actual `intel_snapshot:<uuid>` from `brief_json.source_citations`.** Minimum 3 citation markers used in the body.

## Voice

- **Authoritative, hype-free.** RxApply readers are dentists with low tolerance for marketing language. No "amazing opportunity," no "thrilling new chapter."
- **Numbers when you have them, silence when you don't.** Every number must come from `intel_snapshots.payload` via citation. **Never invent a stat to fill space.** If the intel doesn't give you a number, write around it.
- **Specific to the persona.** If `target_destinations` says `canada` and `language_priorities` is `[en, fa]`, the unstated reader is an Iranian-trained dentist looking at Canada. Write to them, not to a generic global audience.
- **Mention the disclaimer once.** Somewhere in the body, include "RxApply provides education and guidance, not regulated immigration advice — consult a licensed RCIC/OISC/MARA agent for that." This is non-negotiable for compliance.

## Workflow when invoked

The user will name a brief — either by title, partial title, or UUID. If ambiguous, ask which one.

### 1. Fetch the brief

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/sepehr/sepehr.py" fetch <brief_id>
```

If the user gave you a title fragment, run a list/search first:

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/sepehr/sepehr.py" list
```

(`list` returns all briefs with `id`, `title`, `status`, ordered by recency. Pick the matching one.)

### 2. Read the brief carefully

- Confirm `en` is in `language_priorities` — if not, abort and tell the user.
- Internalize `suggested_angle`. Don't drift from it.
- Note every `intel_snapshot:<uuid>` in `source_citations`. You'll cite each one at least once.

### 3. Draft the article

Write the full Markdown in your reply (so the user can read it before it lands in the DB). Aim for 2,200 words ±200. Use the structure above.

Self-check before saving:
- Word count between 2,000 and 2,500? (Roughly — 1,800 also acceptable; 2,800 too long.)
- At least 3 distinct `[^N]` markers in the body, each tied to a real intel snapshot UUID?
- TLDR present? FAQ with ≥4 Q&A?
- Disclaimer line present?

### 4. Save to content_assets

Save the article to a `.md` file next to the skill, then pipe it to `sepehr.py save`:

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/sepehr/sepehr.py" save --brief-id <brief_id> --language en --kind master < article.md
```

The script INSERTs one row into `content_assets` with:
- `brief_id` = the brief's UUID
- `language` = `en`
- `kind` = `master`
- `body_md` = the article text
- `status` = `pending_g2` (the next gate, where the Founder approves the long-form)
- `body_json` = `{"word_count": …, "citation_count": …, "h2_sections": …}` (computed by the helper for quick scorecard checks)

### 5. Confirm

Tell the user:
- The new `content_assets.id`
- Word count, citation count, H2 count
- Status `pending_g2` waiting for review
- Studio link reminder to read the row.

## Edge cases

- **No matching brief**: tell the user, suggest `python sepehr.py list` to see what's available.
- **`en` not in `language_priorities`**: abort. Sepehr only writes EN. Goyesh handles non-English.
- **Word count out of range**: re-draft. Don't pad with filler ("In conclusion…") — instead deepen one or two H2 sections with concrete details from the cited intel.
- **Citation not in `source_citations`**: don't invent UUIDs. Only cite intel that the brief actually pointed at.
- **Brief already has a master article**: warn the user; ask whether to overwrite (UPDATE) or insert a second version. Default: ask, don't overwrite silently.

## Why no n8n

Like Pooya, Sepehr is invoked on demand from chat. n8n would add: a Wait node for G1 approval, a webhook entry, an HTTP node calling cowork-proxy with the prompt, and a Postgres INSERT node. For test-phase validation, Cowork-skill is enough. n8n earns its keep when we want this to run unattended on a schedule, fan out across 3 languages in parallel, or hold for explicit approval at G1/G2 gates — none of which T2 is testing.
