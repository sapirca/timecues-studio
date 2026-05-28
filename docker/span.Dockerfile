# SPAN-family detection sidecar — voicing / instrument-activity intervals.
# Listens on :8009, called by the web container as http://span:8009/api/span/*.
#
# Experimental: this service only spins up under the `experimental-models`
# docker compose profile so production builds opt out completely. See the
# `experimentalSpanFamily` user setting for the UI gating, and
# deep_research/integration_plan.md for the family policy.
#
# Bundles:
#   - Silero-VAD via torch.hub (~2 MB, MIT, downloaded on first detect)
#   - JDCNet voicing (skeleton — weights wiring still pending repo verification)
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_HOME=/app/.cache/torch

# ffmpeg/libsndfile for librosa-backed audio decode; git so torch.hub can
# pull the silero-vad repo on first use.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
        git \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin numpy<2 — torch 2.1.0 was compiled against numpy 1.x and segfaults
# under numpy 2.x. Mirror the gpu-tools.Dockerfile pin so the two stay aligned.
RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

# CPU-only torch wheels keep the image slim (~600 MB vs ~3 GB for the CUDA
# base). Silero-VAD is CPU-friendly; if we later need GPU we can introduce
# a span-gpu variant the same way gpu-tools/cpu-tools fork from one Dockerfile.
RUN pip install --no-cache-dir \
        torch==2.1.0 torchaudio==2.1.0 \
        --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0" \
        "h5py>=3.10.0"

# Pre-fetch Silero-VAD weights at build time so the first detect call doesn't
# pay a 2-5 second network round trip. The weights are ~2 MB so this barely
# touches the image size, and it removes the runtime dependency on snakers4's
# GitHub being reachable. If the build host has no network we fall back to
# lazy download — the server still boots either way.
RUN python -c "import torch; torch.hub.load('snakers4/silero-vad', 'silero_vad', force_reload=False, trust_repo=True)" \
    || echo "[span] silero-vad pre-warm skipped (no network at build time)"

# JDCNet weights from the original Kum & Nam (2019) Keras checkpoint at
# https://github.com/keums/melodyExtraction_JDC (MIT). We load them via
# h5py in jdcnet_torch.py — no TensorFlow runtime needed inside the sidecar.
# Bundled at build time so the model is ready on first detect; ~17 MB hdf5
# + two 124 KB normalization stats.
RUN mkdir -p /app/weights/jdcnet \
    && curl -fSL -o "/app/weights/jdcnet/ResNet_joint_add_L(CE_G).hdf5" \
        "https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/weights/ResNet_joint_add_L(CE_G).hdf5" \
    && curl -fSL -o /app/weights/jdcnet/x_data_mean_total_31.npy \
        https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/x_data_mean_total_31.npy \
    && curl -fSL -o /app/weights/jdcnet/x_data_std_total_31.npy \
        https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/x_data_std_total_31.npy

COPY tools/python/paths.py       /app/tools/python/paths.py
COPY tools/python/jdcnet_torch.py /app/tools/python/jdcnet_torch.py
COPY tools/python/span_server.py /app/tools/python/span_server.py

# Read-only seed dataset so the SPAN server can detect on the shipped default
# tracks even when the user's data/ is empty.
COPY data-default/               /app/data-default/

EXPOSE 8009
CMD ["python", "tools/python/span_server.py"]
