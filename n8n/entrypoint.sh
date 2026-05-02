#!/bin/sh
# RxApply n8n entrypoint
# ----------------------
# Runs as root, fixes ownership of the Railway-mounted volume,
# then drops to the `node` user and execs n8n.
#
# Why this is needed: Railway mounts persistent volumes as root
# at runtime, AFTER the image has been built. Any chown we do
# inside the Dockerfile gets buried under the mount. So we have
# to do it here, every container start.
#
# It's idempotent and fast (chown -R on an empty/small dir is
# instant; chown on an established dir is a no-op when ownership
# already matches).

set -e

# Make sure /data exists (volume mount creates it, but be defensive).
mkdir -p /data

# Fix ownership so n8n (running as `node`) can write its config,
# database.sqlite, and binary data.
chown -R node:node /data

# Drop privileges and exec n8n. `exec` replaces the shell so n8n
# becomes PID 1's child of tini and signals (SIGTERM on redeploy)
# propagate cleanly.
exec su-exec node "$@"
