# CUE-family extras sidecar — bundles three pure-DSP detectors that share
# the same lightweight librosa-only image: librosa-key (Krumhansl-Schmuckler),
# autochord-chords (chroma-template chord recognition), and librosa-onsets.
# Listens on :8014, called by the web container as http://cue-extras:8014/api/cue-extras/*.
#
# Inherits Python 3.11 + librosa + numpy<2 from experimental-dsp-base;
# build that first via
# `docker compose --profile experimental-base build experimental-dsp-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-dsp-base:latest

# autochord is NOT installed in this image: the NNLS-Chroma Vamp plugin it
# loads is GPL, so it is an opt-in, like Essentia (NOTICE.md says how). The
# sidecar boots without it and reports autochord-chords as "Deps missing";
# librosa-key and librosa-onsets are unaffected.

COPY tools/python/paths.py              /app/tools/python/paths.py
COPY tools/python/server_common.py      /app/tools/python/server_common.py
COPY tools/python/cue_extras_server.py  /app/tools/python/cue_extras_server.py
COPY data-default/                     /app/data-default/

EXPOSE 8014
CMD ["python", "tools/python/cue_extras_server.py"]
