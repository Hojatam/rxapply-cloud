# RxApply backup runner
# ---------------------
# Daily pg_dump → gzip → AES-256-GCM encrypt → R2 upload → 30-day prune.
#
# Designed to run as a Railway cron service. Container starts, runs
# backup.js once, exits 0 (or non-zero on failure). Railway re-runs
# it on the configured schedule.
#
# Image is intentionally tiny: node-alpine + postgres-client only.
#
# To bump Postgres client version: change the FROM tag below. Stay
# at or above the server's major version (Supabase Cloud is currently
# Postgres 15).

FROM node:20-alpine

# postgresql-client provides pg_dump. Pin to a major that matches
# (or exceeds) the Supabase Postgres major.
RUN apk add --no-cache postgresql15-client

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY backup.js ./

# No long-running process — Railway cron invokes this each tick.
CMD ["node", "backup.js"]
