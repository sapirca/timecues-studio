# LOOP-family detection sidecar — chroma-autocorrelation loop finder.
# Listens on :8012, called by the web container as http://loop:8012/api/loop/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. Pure DSP — no model weights, no GPU, no platform-specific deps;
# the librosa stack from experimental-dsp-base is everything this sidecar
# needs.
#
# Inherits Python 3.11 + librosa + numpy<2 from experimental-dsp-base;
# build that first via
# `docker compose --profile experimental-base build experimental-dsp-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-dsp-base:latest

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/loop_server.py  /app/tools/python/loop_server.py
COPY data-default/                /app/data-default/

EXPOSE 8012
CMD ["python", "tools/python/loop_server.py"]
