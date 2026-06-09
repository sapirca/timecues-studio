#!/bin/sh
# Entrypoint for the core-mir merged container.
#
# Seeds user-detector starter scripts (lifted from the original
# custom.Dockerfile), then hands off to supervisord which runs the four
# backend servers (bpm/mir/ruptures/custom) as supervised child processes.
# See docker/core-mir.supervisord.conf for the program definitions.
set -e

# Idempotent: never clobber an existing user upload, but populate any
# missing seed file so a fresh container on an empty bind mount still
# ships the starter detectors.
mkdir -p /app/tools/python/custom
for f in /app/tools/python/custom-seed/*.py; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if [ ! -e "/app/tools/python/custom/$base" ]; then
    cp "$f" "/app/tools/python/custom/$base"
  fi
done

exec supervisord -c /app/supervisord.conf
