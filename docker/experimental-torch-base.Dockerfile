# Shared base image for experimental MIR sidecars that depend on PyTorch.
# Children: span, beatnet, panns, lyrics. Each child FROMs this image and
# adds only its unique pip line + server script + EXPOSE/CMD, so the heavy
# torch + librosa layers are built once and shared via Docker's content-
# addressed layer store (registry dedup + overlayfs dedup on the host).
#
# Pins:
#   - CPU torch 2.1.0 — keeps the image at ~1.5 GB instead of ~3 GB CUDA.
#   - numpy<2 — torch 2.1.0 was compiled against numpy 1.x and segfaults
#     on numpy 2.x.
#
# This image runs nothing. It exists only to be the FROM of the four torch
# sidecars; the compose `experimental-base` profile builds it on demand.
#
# Build manually:
#   docker build -f docker/experimental-torch-base.Dockerfile \
#     -t timecues/experimental-torch-base:latest .
# Build via compose:
#   docker compose --profile experimental-base build experimental-torch-base
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_HOME=/app/.cache/torch

# Audio I/O system libs. git + curl for child Dockerfiles that fetch model
# weights at build time (span pulls Silero-VAD via torch.hub and JDCNet via
# curl; beatnet pulls madmom from the CPJKU git fork).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
        git \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

RUN pip install --no-cache-dir \
        torch==2.1.0 torchaudio==2.1.0 \
        --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0"
