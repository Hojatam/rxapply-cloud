# RxApply n8n image
# -----------------
# Wraps the official n8n image with one fix: pre-create the /data
# directory and chown it to the `node` user (UID 1000) BEFORE n8n
# tries to write to it.
#
# Why: Railway mounts persistent volumes as root by default. The
# stock n8nio/n8n image runs as `node`, so it gets EACCES on first
# boot when it tries to mkdir /data/.n8n. Doing the chown at image
# build time means the directory exists with the right ownership
# the moment the volume is mounted.
#
# To bump n8n: change the FROM tag below, commit, push. Railway
# rebuilds and redeploys.

FROM n8nio/n8n:1.95.0

USER root
RUN mkdir -p /data && chown -R node:node /data
USER node

# Tell n8n to use the volume mount instead of /home/node/.n8n
ENV N8N_USER_FOLDER=/data

# n8n's own ENTRYPOINT/CMD from the base image are inherited
# (tini -- /docker-entrypoint.sh ...), so we don't override them.
