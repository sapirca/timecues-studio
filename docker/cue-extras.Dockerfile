# CUE-family extras sidecar — bundles three pure-DSP detectors that share
# the same lightweight librosa-only image: librosa-key (Krumhansl-Schmuckler),
# autochord-chords (chroma-template chord recognition), and librosa-onsets.
# Listens on :8014, called by the web container as http://cue-extras:8014/api/cue-extras/*.
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

# autochord pip package — pure-Python chord recognition (chroma templates +
# Viterbi smoothing). No neural net, no separate weight download.
RUN pip install --no-cache-dir autochord

COPY tools/python/paths.py             /app/tools/python/paths.py
COPY tools/python/cue_extras_server.py /app/tools/python/cue_extras_server.py
COPY data-default/                     /app/data-default/

EXPOSE 8014
CMD ["python", "tools/python/cue_extras_server.py"]
