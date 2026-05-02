# rxapply-cloud

Source of truth for **rxapply.com** — the RxApply control plane. A
single-tenant agent-management dashboard for the founder of RxApply, a
multilingual brand that helps internationally-trained dentists migrate.

This repository ships a single Node application (the *cowork-proxy*) +
a single-page dashboard. The proxy speaks to:

- **Anthropic + OpenAI** for LLM chat / agent runs
- **Supabase Cloud (Postgres)** for state
- **Cloudflare R2** for object storage (avatars, designs, KB uploads)

It runs in production on **Railway** behind Cloudflare DNS.

```
┌─────────────────────── Cloudflare ───────────────────────┐
│  rxapply.com → Railway   ·   media.rxapply.com → R2      │
└──────────────────────────┬───────────────────────────────┘
                           ▼
                ┌─────────────────────┐
                │  Railway / Docker   │
                │  cowork-proxy       │
                │  + dashboard        │
                │  + Python helpers   │
                └─┬──────────────┬────┘
                  │              │
       ┌──────────▼───┐    ┌─────▼───────┐
       │ Supabase     │    │ Cloudflare  │
       │ Cloud (PG)   │    │ R2 (S3 api) │
       │ pooler :6543 │    │             │
       └──────────────┘    └─────────────┘
```

## Repository layout

```
.
├── cowork-proxy/        Express server. Serves /dashboard, /tools/*, /agents/*, etc.
│   ├── server.js        HTTP entry point — routes, middleware, boot.
│   ├── llm.js           Provider-agnostic dispatcher (Anthropic + OpenAI).
│   ├── anthropic-chat.js / openai-chat.js   per-provider adapters.
│   ├── agent-models.js  flagship-only model registry + per-agent overrides.
│   ├── tools/           Tools framework — registry, runtime, adapters/* (REST + MCP).
│   ├── auth.js          Founder auth: scrypt password + TOTP 2FA + CSRF + rate-limit.
│   ├── db.js            Single pg connection pool.
│   ├── storage.js       R2 / local-disk fallback.
│   ├── migrate.js       Idempotent SQL migration runner.
│   └── public/          Vendor static (Drawflow, sprite).
├── agents/              23 agents — each with SKILL.md + a Python helper.
├── supabase/migrations/ Schema migrations applied via migrate.js on boot.
├── dashboard.html       Single-page founder dashboard.
├── Dockerfile           Two-stage build (Node 20 + Python 3).
├── railway.json         Railway service config.
├── DEPLOY.md            Step-by-step deploy walkthrough.
└── .env.example         Env-var template.
```

## What this does (one paragraph)

Twenty-three named "AI employees" — Pooya, Sepehr, Daneshyar, Afshin,
and so on — each have a SKILL.md, a Python helper, an Anthropic /
OpenAI model assignment, and a permission level. The dashboard lets
the founder run any agent, review their output, queue approvals,
inject knowledge-base context, and hand off tasks between agents. The
proxy persists every run, every chat, every cost — and gates dangerous
operations (post to Instagram, send an email) behind an
inbox-style approval queue.

## Local development

You'll need Node 20+, Python 3.10+, and a local Postgres (or a
Supabase Cloud project). Then:

```bash
cp .env.example .env
# fill in DATABASE_URL, ANTHROPIC_API_KEY, SECRETS_KEY (random 32-byte hex), R2_*
cd cowork-proxy
npm install
node migrate.js          # apply migrations to your DB
node server.js
# dashboard at http://localhost:7777/dashboard
```

For the cloud path, see **[DEPLOY.md](./DEPLOY.md)**.

## Status

Live on **rxapply.com** since May 2026. Single-founder use. Daily uptime
on Railway Hobby plan. See releases / commits for the per-milestone
trail.

## License

Private. Not open-source. Founder-only product.
