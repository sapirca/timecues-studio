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

# panns_inference reads class_labels_indices.csv at IMPORT time
# (panns_inference/config.py), so `import panns_inference` raises
# FileNotFoundError unless the AudioSet label map already exists at
# ~/panns_data/. Bake it in at build (~14 KB, 527 classes) so the import —
# and the boot-time health probe — succeed. The ~80 MB CNN14 checkpoint
# still lazy-downloads next to it on first detect.
RUN python -c "import urllib.request, os; os.makedirs('/root/panns_data', exist_ok=True); urllib.request.urlretrieve('https://raw.githubusercontent.com/qiuqiangkong/audioset_tagging_cnn/master/metadata/class_labels_indices.csv', '/root/panns_data/class_labels_indices.csv')"

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/panns_server.py /app/tools/python/panns_server.py
COPY data-default/                /app/data-default/

EXPOSE 8013
CMD ["python", "tools/python/panns_server.py"]
