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
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base; build that first via
# `docker compose --profile experimental-base build experimental-torch-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

# portaudio is the only system lib not covered by the base. BeatNet imports
# pyaudio at module load time even when we only use the offline / pre-recorded
# path (the realtime mode is part of the same class constructor); pyaudio
# links against libportaudio2 / portaudio19-dev.
RUN apt-get update && apt-get install -y --no-install-recommends \
        portaudio19-dev \
    && rm -rf /var/lib/apt/lists/*

# Cython is a build-time prereq for the CPJKU madmom fork.
RUN pip install --no-cache-dir "Cython>=0.29"

# Pull madmom from the CPJKU community fork (same as bpm.Dockerfile) —
# upstream 0.16.1 is abandoned and won't build on modern numpy / Python.
RUN pip install --no-cache-dir "git+https://github.com/CPJKU/madmom.git"

# Install pyaudio FIRST so the BeatNet install doesn't have to resolve it
# transitively.
RUN pip install --no-cache-dir pyaudio

# BeatNet itself — installs a small torch checkpoint via pip.
RUN pip install --no-cache-dir BeatNet

COPY tools/python/paths.py          /app/tools/python/paths.py
COPY tools/python/beatnet_server.py /app/tools/python/beatnet_server.py

COPY data-default/                  /app/data-default/

EXPOSE 8010
CMD ["python", "tools/python/beatnet_server.py"]
