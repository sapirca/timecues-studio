# BeatNet CUE-family sidecar — beats + downbeats + meter inference.
# Listens on :8010, called by the web container as http://beatnet:8010/api/beatnet/*.
#
# Experimental: this service only spins up under the `experimental-models`
# docker compose profile. See the `experimentalCueExtras` user setting for
# the UI gating, and deep_research/integration_plan.md for the family policy.
#
# Why a separate sidecar (rather than extending bpm_server :8004): BeatNet
# pulls in its own torch model + a particular madmom build, and a failure in
# its install path shouldn't take the existing librosa / madmom detectors
# on :8004 down with it.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_HOME=/app/.cache/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
        git \
        portaudio19-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin numpy<2 (same reason as span.Dockerfile / bpm.Dockerfile — torch 2.1
# vs numpy 2.x ABI break).
RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

RUN pip install --no-cache-dir \
        torch==2.1.0 torchaudio==2.1.0 \
        --index-url https://download.pytorch.org/whl/cpu

# librosa + soundfile for audio I/O; Cython is a build-time prereq for
# madmom (BeatNet depends on madmom for the DBN tracking processor).
RUN pip install --no-cache-dir \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0" \
        "Cython>=0.29"

# Pull madmom from the CPJKU community fork (same as bpm.Dockerfile) —
# upstream 0.16.1 is abandoned and won't build on modern numpy / Python.
RUN pip install --no-cache-dir "git+https://github.com/CPJKU/madmom.git"

# BeatNet imports pyaudio at module load time even when we only use the
# offline / pre-recorded path (the realtime mode is part of the same class
# constructor). portaudio19-dev above provides the system lib pyaudio links
# against. Install pyaudio FIRST so the BeatNet install doesn't have to
# resolve it transitively.
RUN pip install --no-cache-dir pyaudio

# BeatNet itself — installs a small torch checkpoint via pip.
RUN pip install --no-cache-dir BeatNet

COPY tools/python/paths.py          /app/tools/python/paths.py
COPY tools/python/beatnet_server.py /app/tools/python/beatnet_server.py

COPY data-default/                  /app/data-default/

EXPOSE 8010
CMD ["python", "tools/python/beatnet_server.py"]
