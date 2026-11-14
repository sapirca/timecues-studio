# Whisper-base vocal-transcription sidecar (LYRICS family).
# Listens on :8016 — http://lyrics:8016/api/lyrics/*.
#
# Whisper is the heaviest of the lean batch but still pip-only: CPU torch
# wheels (inherited from the base) + the openai-whisper package. The
# ~140 MB base checkpoint lazy-downloads into the shared
# `timecues-model-cache` named volume on first detect. No GPU; no special
# system libs beyond what the base already provides.
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base; build that first via
# `docker compose --profile experimental-base build experimental-torch-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

ENV XDG_CACHE_HOME=/app/.cache

# openai-whisper pulls in tiktoken + ffmpeg-python + numba — all CPU-friendly.
# ctc-forced-aligner pulls in transformers (already in the base via whisper
# transitively) — pinned at runtime to `facebook/wav2vec2-base-960h`
# (Apache-2.0) so the default CC-BY-NC MMS_FA model is never downloaded.
# Both detectors share this same sidecar — no separate image to keep build
# space tight.
#
# ctc-forced-aligner MUST come from git: the PyPI name was taken over by an
# unrelated package (deskpai.com) with an incompatible API, so a bare
# `pip install ctc-forced-aligner` installs the wrong package and the server
# fails at import. Keep this in sync with tools/requirements-experimental.txt.
#
# This image alone moves off the base's torch 2.1, to torch >= 2.6 (CPU
# wheels). --prepare-ivrit converts Ivrit through transformers, and current
# transformers refuses to load a model on torch < 2.6; capping transformers
# instead does not hold — current ctranslate2 then passes it a `dtype` kwarg
# only transformers 5 knows. Both failures broke this build on 2026-10-16.
# torch 2.14 + transformers 5.20 + ctranslate2 4.8 converts and loads a
# Whisper checkpoint end to end. numpy stays < 2 for the base's libraries.
RUN pip install --no-cache-dir "torch>=2.6" "torchaudio>=2.6" "numpy<2" \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple
RUN pip install --no-cache-dir "numpy<2" openai-whisper \
    "ctc-forced-aligner @ git+https://github.com/MahmoudAshraf97/ctc-forced-aligner.git" \
    "faster-whisper>=1.1,<2"

# Ivrit runs on int8 CTranslate2 weights (~1.6 GB peak, inside this
# service's 2 GB mem_limit). Converting them holds the fp32 checkpoint
# (~4.8 GB), which the running container could never afford — so it happens
# here, at build time, into the image (not the /app/.cache volume, which
# would hide it). The 3.2 GB download is deleted in the same layer.
ENV TC_IVRIT_CT2_DIR=/app/models/ivrit-ct2-int8

COPY tools/python/paths.py          /app/tools/python/paths.py
COPY tools/python/server_common.py  /app/tools/python/server_common.py
COPY tools/python/lyrics_server.py  /app/tools/python/lyrics_server.py
COPY data-default/                 /app/data-default/

RUN python tools/python/lyrics_server.py --prepare-ivrit \
 && rm -rf /app/.cache/huggingface

EXPOSE 8016
CMD ["python", "tools/python/lyrics_server.py"]
