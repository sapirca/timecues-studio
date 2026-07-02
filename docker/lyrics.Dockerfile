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
RUN pip install --no-cache-dir openai-whisper \
    "ctc-forced-aligner @ git+https://github.com/MahmoudAshraf97/ctc-forced-aligner.git"

COPY tools/python/paths.py         /app/tools/python/paths.py
COPY tools/python/lyrics_server.py /app/tools/python/lyrics_server.py
COPY data-default/                 /app/data-default/

EXPOSE 8016
CMD ["python", "tools/python/lyrics_server.py"]
