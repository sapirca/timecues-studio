# PANNs AudioSet-tagging sidecar — multi-label audio classification.
# Listens on :8013, called by the web container as http://panns:8013/api/panns/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. CPU-only torch wheels; the CNN14 checkpoint (~80 MB) lazy-downloads
# into /app/.cache/panns_data on first detect. Mount the shared
# `timecues-model-cache` named volume to persist the download across restarts.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_HOME=/app/.cache/torch \
    PANNS_CHECKPOINT_DIR=/app/.cache/panns_data

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Same numpy + torch pin as span / beatnet for ABI compatibility.
RUN pip install --no-cache-dir "numpy<2,>=1.24.0"
RUN pip install --no-cache-dir \
        torch==2.1.0 torchaudio==2.1.0 \
        --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0"

# panns_inference bundles AudioSet labels and the CNN14 inference path;
# the checkpoint itself is fetched on first call (not at build time, so the
# image stays slim — at the cost of a 30-60 s first-detect wait).
RUN pip install --no-cache-dir panns_inference

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/panns_server.py /app/tools/python/panns_server.py
COPY data-default/                /app/data-default/

EXPOSE 8013
CMD ["python", "tools/python/panns_server.py"]
