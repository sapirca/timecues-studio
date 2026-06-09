# HPSS percussive-span sidecar (SPAN family). Pure-DSP, librosa-only.
# Listens on :8015 — http://percussive:8015/api/percussive/*.
#
# Inherits Python 3.11 + librosa + numpy<2 from experimental-dsp-base;
# build that first via
# `docker compose --profile experimental-base build experimental-dsp-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-dsp-base:latest

COPY tools/python/paths.py             /app/tools/python/paths.py
COPY tools/python/percussive_server.py /app/tools/python/percussive_server.py
COPY data-default/                     /app/data-default/

EXPOSE 8015
CMD ["python", "tools/python/percussive_server.py"]
