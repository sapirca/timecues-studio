# HPSS percussive-span sidecar (SPAN family). Pure-DSP, librosa-only image.
# Listens on :8015 — http://percussive:8015/api/percussive/*.
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

RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

RUN pip install --no-cache-dir \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0"

COPY tools/python/paths.py             /app/tools/python/paths.py
COPY tools/python/percussive_server.py /app/tools/python/percussive_server.py
COPY data-default/                     /app/data-default/

EXPOSE 8015
CMD ["python", "tools/python/percussive_server.py"]
