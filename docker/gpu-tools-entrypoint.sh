#!/usr/bin/env bash
# Single source of truth for "is gpu-tools installed?" — the capability JSON
# was baked into this image at build time. On every container start we copy it
# into the shared /app/data volume so the web container can read it via the
# /api/capabilities endpoint without needing Docker socket access.
set -e

MARKER_SRC="/app/gpu-tools-capabilities.json"
MARKER_DST="/app/data/.gpu-tools-capabilities.json"

if [ -f "$MARKER_SRC" ] && [ -d "/app/data" ]; then
  cp "$MARKER_SRC" "$MARKER_DST" 2>/dev/null || true
fi

exec "$@"
