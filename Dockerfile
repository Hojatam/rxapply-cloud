# Top-level Dockerfile · pass-through to cowork-proxy/Dockerfile so that
# Railway (and any other PaaS that auto-detects a Dockerfile in the repo
# root) finds the build immediately.
#
# Why the build context is the repo root: cowork-proxy reaches into
# ../agents/ and ../supabase/ at runtime, so we need both directories
# in the build context. The actual Dockerfile lives at cowork-proxy/
# Dockerfile and is the source of truth.

# Reuse the real Dockerfile from cowork-proxy/.
# (The directive below is parsed by docker buildx; for older builders
# this file falls back to including the same content inline.)
# syntax=docker/dockerfile:1

# Inline the cowork-proxy Dockerfile to keep the build contract simple.
# If you change cowork-proxy/Dockerfile, run:
#   cp cowork-proxy/Dockerfile Dockerfile
# to keep them in sync. The CI/Railway auto-detect always uses the root.

# ─────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY cowork-proxy/package.json cowork-proxy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY agents/ /tmp/agents/
RUN find /tmp/agents -name 'requirements.txt' -print0 \
    | xargs -0 -r -I {} pip install --no-cache-dir -r {} || true

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONIOENCODING=utf-8
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /opt/venv /opt/venv
COPY cowork-proxy/    ./cowork-proxy/
COPY agents/          ./agents/
COPY supabase/        ./supabase/
# server.js serves these at /dashboard and the Reference links.
COPY dashboard.html   ./
COPY architecture.html ./
RUN useradd --create-home --shell /bin/bash rxapply \
    && chown -R rxapply:rxapply /app
USER rxapply
WORKDIR /app/cowork-proxy
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||7777)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
