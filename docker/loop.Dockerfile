# LOOP-family detection sidecar — chroma-autocorrelation loop finder.
# Listens on :8012, called by the web container as http://loop:8012/api/loop/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. Pure DSP — no model weights, no GPU, no platform-specific deps.
# Image stays slim (~600 MB) because we don't pull torch.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin numpy<2 to stay aligned with the other sidecars (some transitive deps
# of librosa still trip on numpy 2.x).
RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

RUN pip install --no-cache-dir \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0"

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/loop_server.py  /app/tools/python/loop_server.py
COPY data-default/                /app/data-default/

EXPOSE 8012
CMD ["python", "tools/python/loop_server.py"]
