# Daily Postgres backup → R2

Single-shot backup runner. Deployed as a **Railway cron service**:
the container starts on schedule, runs `backup.js` once, exits.

## What it does

1. `pg_dump --format=custom` against `DATABASE_URL` (use the Supabase
   pooler URL, port 6543).
2. AES-256-GCM encrypt with `BACKUP_ENCRYPTION_KEY` (optional).
3. PUT to R2 under `backups/YYYY-MM-DD/db.dump[.enc]`.
4. List + delete any backups older than `RETENTION_DAYS` (default 30).

## Railway setup

1. **New service** in the same Railway project as cowork-proxy.
2. **Source**: GitHub repo `rxapply-cloud`, **Root Directory**: `backup`.
3. **Builder**: Dockerfile (auto-detected via `railway.json`).
4. **Cron schedule**: defined in `railway.json` as `0 7 * * *` (07:00 UTC daily ≈ 03:00 ET).
5. **No public networking, no volume, no healthcheck** — it's a job, not a server.

## Env vars (required)

```
DATABASE_URL=postgres://postgres:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=<r2 access key>
R2_SECRET_ACCESS_KEY=<r2 secret>
R2_BUCKET=rxapply-prod
```

## Env vars (optional)

```
BACKUP_ENCRYPTION_KEY=<64 hex chars / 32 bytes>     # Strongly recommended
BACKUP_PREFIX=backups                                # Default: "backups"
RETENTION_DAYS=30                                    # Default: 30
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Save this key somewhere outside R2 and outside the repo.** If you lose
it, every encrypted backup is unreadable. A password manager entry is fine.

## Manual run / test

You can trigger an immediate run from Railway → backup service →
**Deployments** → the latest deploy → **Redeploy** button. Watch the
log; it should finish in <60 s for a small DB.

## Restore procedure

If you need to restore (heaven forbid):

```bash
# 1. Download the latest backup from R2
aws s3 cp s3://rxapply-prod/backups/2026-05-02/db.dump.enc ./db.dump.enc \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com

# 2. Decrypt (if encrypted)
node -e "
  const fs = require('fs'), crypto = require('crypto');
  const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
  const buf = fs.readFileSync('db.dump.enc');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  fs.writeFileSync('db.dump', Buffer.concat([d.update(ct), d.final()]));
"

# 3. Restore (point DATABASE_URL at a fresh, EMPTY database first)
pg_restore --no-owner --no-acl --clean --if-exists \
  --dbname=$DATABASE_URL db.dump
```

## Cost

- Railway cron service: ~$0 (only runs ~1 minute/day on Hobby plan).
- R2 storage: ~$0.015/GB/month. A 100 MB DB × 30 backups = 3 GB ≈ $0.05/mo.
- R2 egress: $0 (Cloudflare R2 has no egress fees).

## Bumping postgresql-client version

When Supabase upgrades the Postgres major version, edit the
`apk add postgresql15-client` line in `Dockerfile` to match (e.g.
`postgresql16-client`). The Alpine package list is at
https://pkgs.alpinelinux.org/packages.
