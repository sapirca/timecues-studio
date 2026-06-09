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
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base; build that first via
# `docker compose --profile experimental-base build experimental-torch-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

# h5py for the JDCNet checkpoint loader (Kum & Nam Keras .hdf5 read via h5py
# inside jdcnet_torch.py — no TensorFlow runtime needed inside the sidecar).
RUN pip install --no-cache-dir "h5py>=3.10.0"

# Pre-fetch Silero-VAD weights at build time so the first detect call doesn't
# pay a 2-5 second network round trip. The weights are ~2 MB so this barely
# touches the image size, and it removes the runtime dependency on snakers4's
# GitHub being reachable. If the build host has no network we fall back to
# lazy download — the server still boots either way.
RUN python -c "import torch; torch.hub.load('snakers4/silero-vad', 'silero_vad', force_reload=False, trust_repo=True)" \
    || echo "[span] silero-vad pre-warm skipped (no network at build time)"

# JDCNet weights from the original Kum & Nam (2019) Keras checkpoint at
# https://github.com/keums/melodyExtraction_JDC (MIT). We load them via
# h5py in jdcnet_torch.py. Bundled at build time so the model is ready on
# first detect; ~17 MB hdf5 + two 124 KB normalization stats.
RUN mkdir -p /app/weights/jdcnet \
    && curl -fSL -o "/app/weights/jdcnet/ResNet_joint_add_L(CE_G).hdf5" \
        "https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/weights/ResNet_joint_add_L(CE_G).hdf5" \
    && curl -fSL -o /app/weights/jdcnet/x_data_mean_total_31.npy \
        https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/x_data_mean_total_31.npy \
    && curl -fSL -o /app/weights/jdcnet/x_data_std_total_31.npy \
        https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/x_data_std_total_31.npy

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/jdcnet_torch.py /app/tools/python/jdcnet_torch.py
COPY tools/python/span_server.py  /app/tools/python/span_server.py

# Read-only seed dataset so the SPAN server can detect on the shipped default
# tracks even when the user's data/ is empty.
COPY data-default/                /app/data-default/

EXPOSE 8009
CMD ["python", "tools/python/span_server.py"]
