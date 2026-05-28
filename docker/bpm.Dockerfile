# BPM detection sidecar — librosa + madmom, plus optional Vamp plugins.
# Listens on :8004, called by the web container as http://bpm:8004/api/bpm/*.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0

# Audio I/O system libs + Vamp host (the QM tempo-tracker .so isn't in
# Debian; users can drop a plugin into /usr/lib/vamp at runtime). `git` is
# needed because we pull madmom from its maintained community fork.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
        git \
        vamp-plugin-sdk \
        vamp-examples \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# librosa stack first. madmom comes from the CPJKU community fork rather than
# PyPI: upstream madmom 0.16.1 (2018) is abandoned and won't build on modern
# numpy / Python; the fork has the same API and works on amd64 + arm64 alike,
# which is what lets the bpm service participate in multi-arch builds.
RUN pip install --no-cache-dir \
        "numpy>=1.24.0" \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0" \
        "Cython>=0.29" \
    && pip install --no-cache-dir \
        "git+https://github.com/CPJKU/madmom.git"

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/bpm_server.py   /app/tools/python/bpm_server.py

# Read-only seed dataset (CC0 audio + song-info). Lets the BPM server detect
# tempo for the shipped default tracks even when the user's data/ is empty.
COPY data-default/                /app/data-default/

EXPOSE 8004
CMD ["python", "tools/python/bpm_server.py"]
