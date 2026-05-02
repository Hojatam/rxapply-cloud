# Migration Log

Append-only ledger of every change made on the road from local sandbox
to live `rxapply.com`. Newest entry on top. Each entry references the
git commit hash so the actual diff is one click away.

Format:
```
## YYYY-MM-DD HH:MM · <short label> · <commit-hash>
- bullet 1
- bullet 2
```

---

## 2026-05-01 · session start · baseline

- Copied `rxapply-test/` → `rxapply-cloud/` (5.9 MB, 51 files / 11 dirs,
  excluding `node_modules/`, `.git/`, `logs/`, `*.log`).
- Original local sandbox `rxapply-test/` left untouched as fallback.
- `git init` in `rxapply-cloud/`, default branch `main`.
- Remote `origin` → `https://github.com/Hojatam/rxapply-cloud.git` (private).
- Wrote `CLOUD-MIGRATION-PLAN.md` (canonical plan + tracker).
- Wrote `MIGRATION-LOG.md` (this file).
- Confirmed scope with founder:
    - Cloudflare account ✓ · GitHub repo ✓ · Railway account ✓
    - 2FA: yes (TOTP)
    - Sample data on first-run wizard: **off**
    - LLM transport: direct Anthropic API (CLI removed)
