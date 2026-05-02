# rxapply-test

Working directory for the **RxApply Test Phase**. Companion folder to the plan at:
`C:\Users\Hojat\OneDrive\Desktop\RxApply\test-phase\`

This holds the actual code, configs, and Docker glue. The plan HTML files describe what we're trying to validate; this folder is where we build it.

## Structure

| Folder              | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| cowork-proxy/       | Tiny Node HTTP server bridging n8n -> Claude Code        |
| apps/web/           | Next.js dev server for the Destination Advisor quiz      |
| supabase/migrations | SQL schema files applied to local Supabase Postgres      |
| n8n/workflows/      | Imported `.test.json` workflow files                     |
| fixtures/           | 6 synthetic JSON / CSV fixtures (download from page 02)  |
| prompts/            | 21 minimal-viable agent prompt stubs (from page 04)      |

## Open `STATUS.md` for the live progress log.
