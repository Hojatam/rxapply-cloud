# n8n service

Self-hosted n8n for RxApply, deployed as a separate Railway service
alongside `cowork-proxy`.

## Files

- `Dockerfile` — wraps `n8nio/n8n:<version>` and fixes the Railway
  volume permission issue (see comments inside).
- `workflows/` — exported workflow JSONs. Imported via UI or API,
  NOT baked into the image (see `.dockerignore`).
- `credentials.json` — exported credential stubs. Same: imported at
  runtime, never in the image.

## Railway service settings

- **Source**: GitHub repo `rxapply-cloud`
- **Root Directory**: `n8n`
- **Builder**: Dockerfile (auto-detected)
- **Volume**: mount at `/data` (matches `N8N_USER_FOLDER` in Dockerfile)
- **Public Domain**: `n8n.rxapply.com`

## Required env vars

```
N8N_ENCRYPTION_KEY        # 64-char hex, NEVER rotate after first boot
N8N_HOST                  # n8n.rxapply.com
N8N_PROTOCOL              # https
WEBHOOK_URL               # https://n8n.rxapply.com/
N8N_PORT                  # 5678
GENERIC_TIMEZONE          # America/Toronto
TZ                        # America/Toronto
```

`N8N_USER_FOLDER` is set in the Dockerfile so you don't need it as
an env var, but setting it explicitly in Railway doesn't hurt.

## Bumping n8n

1. Edit `FROM n8nio/n8n:X.Y.Z` in `Dockerfile`
2. Commit + push
3. Railway auto-rebuilds

Check the [n8n releases page](https://github.com/n8n-io/n8n/releases)
before bumping major versions — credentials stored under one
encryption key version are not portable.

## Wiring into cowork-proxy

After n8n is live and you've created the owner account:

1. n8n UI → Settings → API → create Personal API Key
2. Add to cowork-proxy Railway env vars:
   ```
   N8N_URL=https://n8n.rxapply.com
   N8N_API_KEY=<the key>
   ```
3. cowork-proxy's Health Monitor will start probing it (once the
   probe is added to `services.js`).
