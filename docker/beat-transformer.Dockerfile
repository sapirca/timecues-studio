# Beat Transformer CUE-family sidecar — demixed beat + downbeat tracking.
# Listens on :8018, called by the web container as
# http://beat-transformer:8018/api/beat-transformer/*.
#
# Experimental: only spins up under the `experimental-models` compose profile.
#
# Unlike every other detector here, this one reads Demucs STEMS rather than
# the mix, so it needs the data volume's stems to be populated — a song with
# no stems returns an explicit "no stems" error rather than a bad answer.
#
# Needs madmom, which the other torch sidecars don't: the model emits beat /
# downbeat ACTIVATIONS and madmom's DBNs decode them into times. That is
# upstream's own decoding, kept as published.
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base; build that first via
# `docker compose --profile experimental-base build experimental-torch-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

# Cython is a build-time prereq for the CPJKU madmom fork (same as beatnet).
RUN pip install --no-cache-dir "Cython>=0.29" \
    && pip install --no-cache-dir "git+https://github.com/CPJKU/madmom.git"

COPY tools/python/paths.py                     /app/tools/python/paths.py
COPY tools/python/server_common.py             /app/tools/python/server_common.py
COPY tools/python/beat_segments.py             /app/tools/python/beat_segments.py
COPY tools/python/vendor/                      /app/tools/python/vendor/
COPY tools/python/beat_transformer_server.py   /app/tools/python/beat_transformer_server.py

COPY data-default/                            /app/data-default/

# The 36 MB checkpoint is fetched on first use into /app/.cache, which compose
# mounts as the shared timecues-model-cache volume, so it survives rebuilds.
EXPOSE 8018
CMD ["python", "tools/python/beat_transformer_server.py"]
