# =====================================================================
# cowork-proxy · cloud-deploy image
# ---------------------------------------------------------------------
# Two stages so the runtime image stays small. Includes Python 3 because
# Daneshyar's KB extract.py + agent helper scripts are still subprocess-
# spawned (we kept Python helpers; we dropped the `claude` CLI).
#
# Used by Railway's auto-detected build path. railway.json (sibling)
# pins this Dockerfile and sets the start command.
# =====================================================================

# ── Stage 1 · install deps (npm + pip) ───────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# OS deps for python wheels (some KB extractors compile native bindings)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node deps first so this layer caches when only Python deps change.
COPY cowork-proxy/package.json cowork-proxy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error

# Python deps for the agents (KB extract.py uses pypdf, python-docx, …)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY agents/ /tmp/agents/
RUN find /tmp/agents -name 'requirements.txt' -print0 \
    | xargs -0 -r -I {} pip install --no-cache-dir -r {} || true

# ── Stage 2 · runtime ─────────────────────────────────────────────────
FROM node:20-bookworm-slim

# Same Python runtime as builder — keeps native libs (libpq, libssl)
# available for psql clients and pgcrypto. Pinned to slim base.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONIOENCODING=utf-8

# Copy installed deps from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /opt/venv /opt/venv

# App source — we copy the whole tree because cowork-proxy/ reaches
# into ../agents/ at runtime to spawn helpers and read SKILL.md, and
# serves ../dashboard.html at /dashboard.
COPY cowork-proxy/     ./cowork-proxy/
COPY agents/           ./agents/
COPY supabase/         ./supabase/
COPY dashboard.html    ./
COPY architecture.html ./

# Non-root user. Railway runs containers as root by default but we
# don't need that, so drop privileges.
RUN useradd --create-home --shell /bin/bash rxapply \
    && chown -R rxapply:rxapply /app
USER rxapply

WORKDIR /app/cowork-proxy

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||7777)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
