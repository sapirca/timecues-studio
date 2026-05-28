# Custom-detector sidecar — runs user-authored .py detectors dropped into
# tools/python/custom/. Listens on :8005, called by the web container as
# http://custom:8005/api/custom-scripts/* and /api/custom-annotations/*.
#
# Persistence model:
#   /app/tools/python/custom/      — writable; user uploads land here. In prod
#                                    this is a bind mount onto persistent disk
#                                    so detectors survive container replacement.
#   /app/tools/python/custom-seed/ — read-only; baked-in seed scripts
#                                    (example_energy, playground, template).
#                                    The entrypoint copies any missing seeds
#                                    into the mount on container start, so a
#                                    fresh deploy with an empty volume still
#                                    shows the starter detectors.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0

# librosa needs ffmpeg/libsndfile to decode mp3.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Same audio stack ruptures uses. Detectors can import anything from these.
RUN pip install --no-cache-dir \
        "numpy>=1.24.0" \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0" \
        "scikit-learn>=1.3.0"

# Server modules + shared package consumed by custom_runner / custom_api.
COPY tools/python/paths.py          /app/tools/python/paths.py
COPY tools/python/custom_server.py  /app/tools/python/custom_server.py
COPY tools/python/custom_loader.py  /app/tools/python/custom_loader.py
COPY tools/python/custom_runner.py  /app/tools/python/custom_runner.py
COPY tools/python/custom_api.py     /app/tools/python/custom_api.py
COPY tools/python/shared/           /app/tools/python/shared/

# Seed detectors: baked at a sibling path so a runtime bind mount on
# tools/python/custom/ doesn't hide them. The entrypoint promotes any
# missing files into the live dir on start.
COPY tools/python/custom/           /app/tools/python/custom-seed/

# Read-only CC0 default dataset so detectors can run against the shipped
# tracks even when the user's data/ is empty.
COPY data-default/                  /app/data-default/

# Entrypoint: ensure the live custom/ dir exists, seed any missing starter
# scripts (without clobbering user uploads), then start the server.
RUN printf '%s\n' \
        '#!/bin/sh' \
        'set -e' \
        'mkdir -p /app/tools/python/custom' \
        'for f in /app/tools/python/custom-seed/*.py; do' \
        '  [ -e "$f" ] || continue' \
        '  base=$(basename "$f")' \
        '  if [ ! -e "/app/tools/python/custom/$base" ]; then' \
        '    cp "$f" "/app/tools/python/custom/$base"' \
        '  fi' \
        'done' \
        'exec python tools/python/custom_server.py' \
        > /usr/local/bin/custom-entrypoint.sh \
    && chmod +x /usr/local/bin/custom-entrypoint.sh

EXPOSE 8005
CMD ["/usr/local/bin/custom-entrypoint.sh"]
