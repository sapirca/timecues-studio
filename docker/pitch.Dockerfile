# basic-pitch polyphonic-note transcription sidecar (CUE family).
# Listens on :8011, called by the web container as http://pitch:8011/api/pitch/*.
#
# Experimental: only spins up under the `experimental-models` docker compose
# profile. basic-pitch ships an ONNX runtime model bundled with the pip
# package, so the image is self-contained — no separate weight download
# at runtime, works the same on amd64 + arm64 + macOS.
#
# Inherits Python 3.11 + librosa + numpy<2 from experimental-dsp-base;
# build that first via
# `docker compose --profile experimental-base build experimental-dsp-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-dsp-base:latest

# basic-pitch pins TF lite + ONNX runtime; the [onnx] extra picks the
# CPU-only ONNX backend on all platforms (no GPU torch, no native compile).
# librosa drives the audio I/O path inside basic-pitch.predict().
RUN pip install --no-cache-dir "basic-pitch[onnx]"

COPY tools/python/paths.py         /app/tools/python/paths.py
COPY tools/python/pitch_server.py  /app/tools/python/pitch_server.py
COPY data-default/                 /app/data-default/

EXPOSE 8011
CMD ["python", "tools/python/pitch_server.py"]
