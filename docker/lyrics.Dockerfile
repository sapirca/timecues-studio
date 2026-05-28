# Whisper-base vocal-transcription sidecar (LYRICS family).
# Listens on :8016 — http://lyrics:8016/api/lyrics/*.
#
# Whisper is the heaviest of the lean batch but still pip-only: CPU torch
# wheels + the openai-whisper package. The ~140 MB base checkpoint lazy-
# downloads into the shared `timecues-model-cache` named volume on first
# detect. No GPU; no special system libs beyond ffmpeg.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_HOME=/app/.cache/torch \
    XDG_CACHE_HOME=/app/.cache

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

RUN pip install --no-cache-dir \
        torch==2.1.0 torchaudio==2.1.0 \
        --index-url https://download.pytorch.org/whl/cpu

# openai-whisper pulls in tiktoken + ffmpeg-python + numba — all CPU-friendly.
RUN pip install --no-cache-dir openai-whisper

COPY tools/python/paths.py         /app/tools/python/paths.py
COPY tools/python/lyrics_server.py /app/tools/python/lyrics_server.py
COPY data-default/                 /app/data-default/

EXPOSE 8016
CMD ["python", "tools/python/lyrics_server.py"]
