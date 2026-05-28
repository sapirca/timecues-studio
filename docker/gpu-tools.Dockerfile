# syntax=docker/dockerfile:1.7
#
# allin1 (beat/downbeat/structure model from mir-aidj) + Demucs (source
# separation) tooling. Wraps the CLI scripts under tools/ as a one-shot
# runner; the same image also serves as the always-on `stems` daemon.
#
# Base image and torch variant are picked from (TARGETARCH, FLAVOR):
#
#   • amd64 + FLAVOR=cuda (default on amd64)
#       → pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime + CUDA torch
#       (fast on NVIDIA; ~30-60 s/song for allin1)
#   • amd64 + FLAVOR=cpu
#       → python:3.11-slim + CPU torch wheels
#       (GPU-less amd64; used for prod stems on the n2-standard VM)
#   • arm64 (FLAVOR forced to cpu — no CUDA on arm64)
#       → python:3.11-slim + CPU torch wheels
#       (Apple Silicon / Ampere; ~3-5 min/song for allin1)
#
# To force CPU on an amd64 host without an NVIDIA GPU, pass:
#   --build-arg FLAVOR=cpu
# (Or set FLAVOR=cpu in your shell env — Compose forwards build args.)
#
# Output (identical for both flavors):
#   • allin1 writes JSON to /app/data/algorithm-outputs/analysis/<slug>/allin1.json
#   • Demucs writes stems to /app/data/stems/<slug>/*.wav

# Global ARGs — declared BEFORE any FROM so they can substitute into FROM
# lines below. TARGETARCH is buildx's built-in (auto-set from --platform);
# FLAVOR is ours, optional, default empty (→ "default" via :-default).
# Stage-local ARGs inside a build stage can't be referenced from FROM
# substitutions — this was the bug in the first attempt at this fix.
ARG TARGETARCH=amd64
ARG FLAVOR=

# Two real base stages. Buildx only fetches the one selected as `final`.
FROM pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime AS base-cuda
FROM python:3.11-slim                              AS base-cpu

# Pre-FROM ARG substitution can't do conditionals, so we enumerate all
# (TARGETARCH, FLAVOR) combinations as picker stages. The arch-default
# (FLAVOR=default) maps to: amd64 → CUDA, arm64 → CPU.
# `arm64-cuda` falls back to CPU rather than failing, so an accidental
# `--build-arg FLAVOR=cuda` on an arm64 host still produces a working image.
FROM base-cuda AS pick-amd64-default
FROM base-cuda AS pick-amd64-cuda
FROM base-cpu  AS pick-amd64-cpu
FROM base-cpu  AS pick-arm64-default
FROM base-cpu  AS pick-arm64-cuda
FROM base-cpu  AS pick-arm64-cpu

FROM pick-${TARGETARCH}-${FLAVOR:-default} AS final

# Re-declare ARGs inside the build stage so RUN steps see them.
ARG TARGETARCH
ARG FLAVOR
RUN if [ -z "${FLAVOR:-}" ]; then \
        FLAVOR=$([ "$TARGETARCH" = "amd64" ] && echo cuda || echo cpu); \
    fi; \
    echo "$FLAVOR" > /etc/torch_flavor

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_HOME=/app/.cache/torch \
    # Single-thread BLAS to avoid torch/OpenBLAS OpenMP-runtime deadlock that
    # hangs Demucs inference on arm64 (Apple Silicon / Ampere).
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

# ffmpeg/libsndfile for audio decode; git so we can pull the CPJKU madmom
# fork (active maintenance, fixes numpy 2.x + modern Python issues that
# the abandoned upstream madmom has); build-essential because madmom + a
# few transitive deps still ship C extensions that compile on install
# (the CUDA base image already has gcc, but python:3.11-slim does not).
#
# DEBIAN_FRONTEND=noninteractive is inlined (not ENV) so it doesn't persist
# into the runtime image. Without it, ffmpeg's transitive tzdata dependency
# prompts for a geographic-area choice on stdin and hangs the build forever
# (cost us a 90-min Cloud Build timeout before the cause was found).
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        git \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin numpy<2 for both flavors. Torch 2.1.0 (used in both the CUDA base
# image and the CPU pip install below) was compiled against the NumPy 1.x
# C API and segfaults / fails to load with numpy 2.x ("module compiled
# using NumPy 1.x cannot be run in NumPy 2.4"). Pinning early prevents
# transitive deps (librosa, demucs) from auto-upgrading to numpy 2.
RUN pip install --no-cache-dir "numpy<2,>=1.24.0"

# CPU variant: the python:3.11-slim base ships no torch — pull the CPU wheels
# from PyTorch's CPU index. CUDA variant: the base image already has torch.
RUN if [ "$(cat /etc/torch_flavor)" = "cpu" ]; then \
        pip install torch==2.1.0 torchaudio==2.1.0 \
            --index-url https://download.pytorch.org/whl/cpu; \
    fi

# natten — CUDA-only. The wheel links against CUDA libs so it won't import on
# a CPU host; we skip it on cpu builds and let run_allin1.py's pure-PyTorch
# natten shim handle the missing kernels at runtime.
RUN if [ "$(cat /etc/torch_flavor)" = "cuda" ]; then \
        pip install natten==0.17.1+torch210cu121 \
            -f https://shi-labs.com/natten/wheels/; \
    fi

# allin1 + demucs + the CPJKU madmom fork. librosa/soundfile/audioread give
# us identical audio I/O to the CPU sidecars so paths line up.
RUN pip install \
        "git+https://github.com/CPJKU/madmom.git" \
        allin1 \
        demucs \
        librosa \
        soundfile \
        audioread

COPY tools/ /app/tools/
COPY data-default/ /app/data-default/

# Capability marker — written only if the heavy ML imports actually work,
# so the marker's presence implies the tools run. Demucs imports the same
# way on both flavors. allin1 imports cleanly only when natten is present
# AND has the expected functions; on the CPU path we skip the standalone
# check (run_allin1.py's compat shim only kicks in when invoked).
RUN flavor=$(cat /etc/torch_flavor) \
 && python -c "import demucs" \
 && if [ "$flavor" = "cuda" ]; then python -c "import allin1"; fi \
 && printf '{"allin1": true, "demucs": true, "variant": "%s"}\n' "$flavor" \
    > /app/gpu-tools-capabilities.json

COPY docker/gpu-tools-entrypoint.sh /usr/local/bin/gpu-tools-entrypoint.sh
RUN chmod +x /usr/local/bin/gpu-tools-entrypoint.sh

# Stems HTTP daemon (tools/python/stems_server.py) binds here when this image
# is run as the `stems` service in docker-compose. One-shot runs (the
# `gpu-tools`/`cpu-tools` profile pattern) don't bind it but it's harmless.
EXPOSE 8006

# Entrypoint publishes the marker, then exec's the user's command.
# Drops into bash by default; the intended pattern is
# `docker compose --profile gpu run --rm gpu-tools <python ...>`.
# The `stems` service in docker-compose.yml overrides CMD to
# `python tools/python/stems_server.py` to launch the daemon.
ENTRYPOINT ["/usr/local/bin/gpu-tools-entrypoint.sh"]
CMD ["bash"]
