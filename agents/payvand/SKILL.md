---
name: payvand
description: Payvand drafts cold-outreach messages to potential RxApply partners — RCICs (Canadian immigration consultants), MARA agents (Australia), exam-prep schools, recruiters, dental schools. Each draft is tailored to the partner's type and country and gets written into partnerships.outreach_drafts as JSON; nothing is sent automatically — every draft requires founder review before it goes out. Use this skill whenever the user says "run payvand", "draft outreach to <org>", "write an intro to that RCIC", or asks anything about new-partner messaging. Payvand never sends mail; it only writes drafts.
---

# Payvand — Partnership Outreach Drafter

Payvand answers: **"Given this partner's type and country, what's a tight first-message draft to start the relationship?"**

## Inputs

Payvand reads `partnerships` rows whose `status='targeted'` (the queue of orgs we want to approach). For each row he uses three signals to template a draft:

- `type` — picks the message frame (RCIC vs. exam-prep school vs. recruiter all need different opening lines).
- `country` — name-checks the regulatory body or licensing path most relevant to that country.
- `notes` — any human-written context already in the row (e.g. "met at IDS Cologne 2025") gets paraphrased into the second paragraph.

In production Payvand would also use Sepehr's recent EN masters as link suggestions; locally, the helper just templates a plain message.

## Output

Each draft is appended to `partnerships.outreach_drafts` as one JSON object:

```json
{
  "drafted_by": "payvand",
  "drafted_at": "2026-04-30T11:00:00Z",
  "channel": "email",
  "subject": "RxApply ↔ <Org> · partnership re: Canadian-bound dentists",
  "body": "Hi <ContactName>,\n\nI lead RxApply...",
  "status": "pending_human_review"
}
```

`partnerships.status` advances from `targeted` → `draft_ready`. Nothing is sent. The founder reviews drafts in the dashboard's outreach panel (future B-phase) and either edits-then-sends or rejects.

## How to call Payvand

```bash
python "C:/Users/Hojat/OneDrive/Desktop/rxapply-test/agents/payvand/payvand.py" run
python payvand.py draft <partnership-uuid>     # one row, no DB write
python payvand.py preview <partnership-uuid>   # show what would be written
```

## Voice

Direct, specific, no marketing fluff. The draft names a concrete reason this partnership matters now (a regulatory window, a lead-volume signal). First sentence is one line; the body is ≤120 words.

Good first line: `"Quick note from RxApply — we're matching Iranian-trained dentists with Canadian bridging programs and your RCIC practice keeps showing up in our research."`
Bad: `"Hope this email finds you well!"`

## Edge cases

- **No `targeted` partnerships**: emits zero drafts and journals "no partners to draft for".
- **Unknown `type`**: falls back to a generic dental-migration intro.
- **Row already has a draft**: skipped (we don't overwrite); journaled with status='skipped'-equivalent (counted under a `--force` flag if the user wants to redraft).
