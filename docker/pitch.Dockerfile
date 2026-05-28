# basic-pitch polyphonic-note transcription sidecar (CUE family).
# Listens on :8011, called by the web container as http://pitch:8011/api/pitch/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. basic-pitch ships an ONNX runtime model bundled with the pip
# package, so the image is self-contained — no separate weight download
# at runtime, works the same on amd64 + arm64 + macOS.
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

# basic-pitch pins TF lite + ONNX runtime; the [onnx] extra picks the
# CPU-only ONNX backend on all platforms (no GPU torch, no native compile).
# librosa drives the audio I/O path inside basic-pitch.predict().
RUN pip install --no-cache-dir \
        "librosa>=0.10.0" \
        "basic-pitch[onnx]"

COPY tools/python/paths.py         /app/tools/python/paths.py
COPY tools/python/pitch_server.py  /app/tools/python/pitch_server.py
COPY data-default/                 /app/data-default/

EXPOSE 8011
CMD ["python", "tools/python/pitch_server.py"]
