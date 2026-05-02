# RxApply n8n image
# -----------------
# Wraps the official n8n image and fixes Railway's volume-mount
# permission issue at RUNTIME (not build time — the volume mount
# overlays /data after the image is built, so a build-time chown
# does nothing).
#
# Flow:
#   1. Container starts as root
#   2. entrypoint.sh chowns the freshly-mounted /data to node:node
#   3. su-exec drops privileges to node and execs n8n
#
# To bump n8n: change the FROM tag, commit, push.

FROM n8nio/n8n:1.95.0

USER root

# su-exec is the lightweight Alpine equivalent of gosu — lets us
# drop from root to node without a full su shell.
RUN apk add --no-cache su-exec

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV N8N_USER_FOLDER=/data

# Stay as root so entrypoint can chown; entrypoint drops to node
# before exec'ing n8n.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["n8n", "start"]
