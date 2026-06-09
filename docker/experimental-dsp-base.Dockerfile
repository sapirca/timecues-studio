# Shared base image for experimental MIR sidecars that do NOT need PyTorch.
# Children: loop, percussive, cue-extras, pitch — pure-DSP librosa flavors
# plus basic-pitch's ONNX runtime. See experimental-torch-base.Dockerfile
# for the broader design rationale (shared base preserves per-service
# process isolation while deduplicating the heavy install layers).
#
# Pins: numpy<2 (stays aligned with the torch base + transitive librosa
# constraints that still flag warnings on numpy 2.x).
#
# Build manually:
#   docker build -f docker/experimental-dsp-base.Dockerfile \
#     -t timecues/experimental-dsp-base:latest .
# Build via compose:
#   docker compose --profile experimental-base build experimental-dsp-base
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
