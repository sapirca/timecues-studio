# Beat This! CUE-family sidecar — beats + downbeats + fitted grid segments.
# Listens on :8008, called by the web container as
# http://beat-this:8008/api/beat-this/*.
#
# Experimental: this service only spins up under the `experimental-models`
# docker compose profile. See the `experimentalCueExtras` user setting for
# the UI gating.
#
# Why a separate sidecar from beatnet (:8010), given both are beat trackers:
# they answer different questions and have disjoint install paths. BeatNet is
# the ONLINE (causal, streaming) tracker and drags in madmom + portaudio +
# pyaudio to be one; Beat This! is offline-only, runs its own transformer
# post-processing instead of a DBN, and therefore needs none of that. Folding
# them together would mean this image inherits BeatNet's portaudio build for
# code it never calls.
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base; build that first via
# `docker compose --profile experimental-base build experimental-torch-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

# beat-this pulls einops / soxr / rotary-embedding-torch; torch itself comes
# from the base image and is deliberately NOT re-resolved here (a bare
# `pip install beat-this` would happily pull the CUDA build over the CPU one
# and triple the image size).
RUN pip install --no-cache-dir --no-deps beat-this \
    && pip install --no-cache-dir \
        einops \
        soxr \
        rotary-embedding-torch \
        tqdm

COPY tools/python/paths.py               /app/tools/python/paths.py
COPY tools/python/server_common.py       /app/tools/python/server_common.py
COPY tools/python/beat_segments.py       /app/tools/python/beat_segments.py
COPY tools/python/beat_this_server.py    /app/tools/python/beat_this_server.py

COPY data-default/                      /app/data-default/

# The checkpoint lands in TORCH_HOME (/app/.cache/torch), which compose mounts
# as the shared timecues-model-cache volume — so it survives a rebuild and is
# fetched once across every torch sidecar.
EXPOSE 8008
CMD ["python", "tools/python/beat_this_server.py"]
