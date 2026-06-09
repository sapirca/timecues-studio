# PANNs AudioSet-tagging sidecar — multi-label audio classification.
# Listens on :8013, called by the web container as http://panns:8013/api/panns/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. CPU-only torch wheels (inherited from the base); the CNN14
# checkpoint (~80 MB) lazy-downloads into /app/.cache/panns_data on first
# detect. Mount the shared `timecues-model-cache` named volume to persist
# the download across restarts.
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base; build that first via
# `docker compose --profile experimental-base build experimental-torch-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

ENV PANNS_CHECKPOINT_DIR=/app/.cache/panns_data

# panns_inference bundles AudioSet labels and the CNN14 inference path;
# the checkpoint itself is fetched on first call (not at build time, so the
# image stays slim — at the cost of a 30-60 s first-detect wait).
RUN pip install --no-cache-dir panns_inference

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/panns_server.py /app/tools/python/panns_server.py
COPY data-default/                /app/data-default/

EXPOSE 8013
CMD ["python", "tools/python/panns_server.py"]
