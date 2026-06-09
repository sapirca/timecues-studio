# PATTERN-family detection sidecar — LoCoMotif motif discovery.
# Listens on :8017, called by the web container as http://pattern:8017/api/pattern/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. Pure DSP — no model weights — but pulls in numba + matplotlib via
# the dtai-locomotif dep, so first call after server boot pays a one-time
# ~15 s numba-JIT warm-up (the Initialize-Models settings panel triggers it
# explicitly so the user can pay that cost before clicking Run on a song).
#
# Inherits Python 3.11 + librosa + numpy<2 from experimental-dsp-base;
# build that first via
# `docker compose --profile experimental-base build experimental-dsp-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-dsp-base:latest

# dtai-locomotif (MIT, KU Leuven) — DTW-warped variable-length motif discovery.
# Brings numba + matplotlib (matplotlib only for the package's optional viz
# helpers, not used by the server; tolerated since it's already on most ML
# Python installs).
RUN pip install --no-cache-dir dtai-locomotif

COPY tools/python/paths.py           /app/tools/python/paths.py
COPY tools/python/pattern_server.py  /app/tools/python/pattern_server.py
COPY data-default/                   /app/data-default/

EXPOSE 8017
CMD ["python", "tools/python/pattern_server.py"]
