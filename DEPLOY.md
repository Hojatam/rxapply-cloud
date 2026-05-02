# Deploy guide · rxapply.com on Railway

This is the live-deploy walkthrough. Follow it once at launch; revisit
when env vars rotate or a major version ships. Each section ends with a
**verify** check so you know it landed.

```
┌─────────────────────── Cloudflare ───────────────────────┐
│  rxapply.com  →  Railway hostname (CNAME)                │
│  media.rxapply.com  →  R2 bucket (custom domain, free)   │
└──────────────────────────┬───────────────────────────────┘
                           ▼
                    Railway · cowork-proxy
                  ┌─────────────────────────┐
                  │  Docker build from repo │
                  │  Healthcheck: /health   │
                  │  Auto-restart           │
                  └──┬───────────────────┬──┘
                     │                   │
            ┌────────▼─────────┐  ┌──────▼──────┐
            │ Supabase Cloud   │  │ Cloudflare  │
            │ Postgres pooler  │  │ R2 (S3 api) │
            │ port 6543        │  │ private     │
            └──────────────────┘  └─────────────┘
```

---

## 0 · Prerequisites checklist

You should already have:

- [x] Cloudflare account with `rxapply.com` registered there
- [x] Railway account
- [x] GitHub account + private repo at `github.com/Hojatam/rxapply-cloud`
- [x] Supabase Cloud account (free tier)
- [x] Anthropic API key with billing enabled

If anything's missing, sign up first, then come back.

---

## 1 · Supabase Cloud · create the production project

This holds your live Postgres database. ~3 minutes.

1. Go to **app.supabase.com** → **New project**.
2. Name: `rxapply-prod` · Region: pick whichever's closest to you (CA-Central or US-East are good Toronto-adjacent options).
3. Set a strong DB password — copy it to a password manager.
4. Wait for the project to provision (60–90 s).
5. Go to **Project Settings → Database → Connection pooling**:
   - Mode: **Transaction**
   - Copy the **Connection string** (URI)
   - It looks like: `postgresql://postgres.<project>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`
   - **This** is your `DATABASE_URL`. Do **not** use the direct connection — Railway containers need the pooler.

**Verify**: from a terminal you can run `psql "$DATABASE_URL"` and see a `postgres=>` prompt.

> Tell me when this is done so I can verify the URL shape together. Don't paste the full string in chat — only the part *after* `pooler.supabase.com:6543/` (which should be `postgres`).

---

## 2 · Cloudflare R2 · create the bucket + API token

This holds avatars / drafts / renders. Survives Railway redeploys. ~3 minutes.

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**.
   - Name: `rxapply-prod`
   - Location: **Automatic**
2. Open the bucket → **Settings** → note your **Account ID** (the long hex at top of the R2 page also works).
3. **R2 → Manage R2 API Tokens** → **Create API token**.
   - Permissions: **Object Read & Write**
   - Scope: **Apply to specific buckets only** → `rxapply-prod`
   - TTL: **Forever** (rotate manually when you want)
   - Click **Create**.
4. Copy these four values into a notes file (private):
   - `R2_ACCOUNT_ID`        (from step 2)
   - `R2_ACCESS_KEY_ID`     (shown once)
   - `R2_SECRET_ACCESS_KEY` (shown once)
   - `R2_BUCKET=rxapply-prod`
5. **Optional: custom domain.** Bucket → **Settings** → **Public access** → **Custom Domains** → Connect Domain → `media.rxapply.com`.
   This makes your dashboard fetch images directly from `https://media.rxapply.com/<key>` instead of routing through the proxy. If you skip it, the proxy serves images via `/storage/<key>` — works fine, just slower.
   - If you set this, also set `R2_PUBLIC_URL=https://media.rxapply.com` in Railway env vars.

**Verify**: I'll add an internal `/setup/api/test-r2` endpoint that pings R2 from the proxy when M13 boots.

---

## 3 · Railway · connect GitHub + create the service

~5 minutes.

1. railway.app → your project (the empty one you created earlier) → **+ New** → **GitHub Repo** → pick `rxapply-cloud`.
2. Railway will detect the `Dockerfile` at the repo root. Confirm the build settings:
   - **Builder**: Dockerfile
   - **Dockerfile Path**: `Dockerfile` (root)
   - **Watch Paths**: leave default
3. Wait for the first build (~6–8 minutes for fresh dependencies). It will fail to **start** because env vars aren't set yet — that's expected.

**Verify**: Railway shows the build succeeded but the container is in a "crashed" loop. Go to the next step.

---

## 4 · Railway · set environment variables

~5 minutes. **All values here are secrets — set them in the Railway dashboard, never paste them into git.**

In Railway → your service → **Variables** tab → **Raw Editor** → paste this template, fill in your values, save:

```
# Required
NODE_ENV=production
PORT=7777

DATABASE_URL=<paste Supabase pooler URL>
ANTHROPIC_API_KEY=<paste sk-ant-... key>

# 32-byte hex — generate ONCE with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# DO NOT REGENERATE LATER — every connected tool's secrets become unreadable.
SECRETS_KEY=<paste 64-char hex>

R2_ACCOUNT_ID=<from step 2>
R2_ACCESS_KEY_ID=<from step 2>
R2_SECRET_ACCESS_KEY=<from step 2>
R2_BUCKET=rxapply-prod

# Optional but recommended
R2_PUBLIC_URL=https://media.rxapply.com    # if you connected the custom domain
PROXY_PUBLIC_URL=https://rxapply.com       # set after step 6 (DNS)
```

After saving, Railway redeploys automatically (~2 min).

**Verify**:
- Railway logs show: `cowork-proxy listening on :7777`
- Logs show: `[migrate] applied N` (where N = total migrations)
- Logs show: `tools registry: synced N tools to Postgres`
- Click Railway's auto-generated URL (e.g. `cowork-proxy-production.up.railway.app`) and you should see `/setup` redirect

---

## 5 · Walk the wizard on the Railway URL

~5 minutes. Open the Railway URL, finish the wizard end-to-end:

1. Step 1 (Welcome): all checks should be green
2. Step 2: pick a strong founder password
3. Step 3: enable 2FA — print the recovery codes somewhere safe
4. Step 4: paste your Anthropic key, click Test, expect green
5. Step 5: Database should show "17+ migrations applied"
6. Step 6: brand profile (or skip)
7. Step 7: upload `team.jpg` from your local rxapply-test (or skip)
8. Step 8: paste Tavily key (free tier is fine to start) (or skip)
9. Step 9: hit **Open dashboard**

**Verify**: dashboard loads at the Railway URL with your normal panels. Login persists across reload.

---

## 6 · Cloudflare · point rxapply.com at Railway

~10 minutes including DNS propagation.

1. Railway → your service → **Settings → Networking → Public Networking → Custom Domain** → enter `rxapply.com`.
2. Railway shows you a CNAME target like `xyz123.up.railway.app`. Copy it.
3. Cloudflare DNS for rxapply.com:
   - Add `CNAME @` → `xyz123.up.railway.app` → **Proxy: OFF** (gray cloud)
   - Add `CNAME www` → `rxapply.com` → **Proxy: OFF**

   > **Why proxy OFF?** Railway issues its own TLS certificate. Cloudflare's orange-cloud proxy intercepts traffic, blocks Iranian IPs aggressively (which would lock out future dental-candidate users from Iran), and sometimes confuses the cert handshake. Direct CNAME → Railway → Railway's TLS is the path of least surprise.

4. Wait 1–10 minutes for DNS to propagate (`dig rxapply.com` from a terminal should show your Railway hostname).
5. Once propagated, Railway auto-provisions the TLS certificate (Let's Encrypt). The Custom Domain page goes from "Pending" → "Active".
6. Update Railway env var: `PROXY_PUBLIC_URL=https://rxapply.com`. Save → auto-redeploy.

**Verify**:
- `https://rxapply.com` loads with a valid TLS cert (no browser warning)
- The dashboard works the same as it did at the Railway URL
- `/health` returns `{"ok":true,"mode":"cowork","llmTransport":"anthropic-api-direct"…}`

---

## 7 · Final smoke test

End-to-end check that everything actually works in production. ~5 minutes.

1. Sign in to https://rxapply.com with your founder password + 2FA
2. Go to Tools → Tavily → set its perm for **daneshyar = auto**
3. Go to Knowledge → ask Daneshyar: "What's the latest deadline for the NDEB exam in Canada?" (or similar)
4. Daneshyar should respond with a Tavily-grounded answer
5. Check the Logs panel — the run should appear with cost > $0
6. Check the Inbox for any handoffs

If all six pass: **rxapply.com is live**. Celebrate.

---

## Post-launch

### Backups
- Supabase Cloud free tier: nightly snapshot, 7-day retention. **Upgrade to Pro ($25/mo) before you have real customer data.**
- R2: enable Object Lifecycle → keep deleted versions 30 days
- Weekly: from your local machine, run `pg_dump "$DATABASE_URL" > backups/$(date +%Y-%m-%d).sql` and stash in OneDrive

### Monitoring
- Railway shows CPU/memory/restart graphs out of the box
- Add Better Stack (free tier) for uptime pings against `https://rxapply.com/health`

### Rotating secrets
- `ANTHROPIC_API_KEY` — generate a new key in console, paste into Railway env, redeploy. Old key invalidates after 24h.
- `SECRETS_KEY` — **never rotate.** All tool credentials encrypted with this become unreadable. If you must, decrypt them all to plain JSON first, regenerate the key, re-encrypt.
- DB password — rotate quarterly. Update DATABASE_URL.

### Common issues

| Symptom | Likely fix |
|---|---|
| `/health` 502 in Railway | Check NODE_ENV=production is set; check DATABASE_URL pooler URL is correct |
| Wizard stuck on "Database not reachable" | DATABASE_URL is the direct connection (port 5432), not the pooler (6543). Switch. |
| Avatars / images load slow | Skipped step 5 R2 custom domain — set R2_PUBLIC_URL=https://media.rxapply.com |
| 429 on every login attempt | Express's trust-proxy not honoring Railway's IP. Check `app.set('trust proxy', 1)` is in production block. |
| Cookie not setting on rxapply.com | NODE_ENV != production. Cookies need Secure flag for cross-site context. |
| Anthropic API "401 Unauthorized" | Key revoked or you pasted the test key instead of the prod key |

---

Last updated: 2026-05-01 · M13
