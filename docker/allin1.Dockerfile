# All-In-One (allin1) structure-analysis image — for one-off corpus batch runs.
#
# allin1 is NOT a server sidecar (no HTTP API) and is NOT part of the
# experimental-models profile or the prod deploy. It is a heavy CLI model
# (torch + madmom + an internal Demucs demix). This image exists so a corpus
# sweep can run via `docker exec ... python tools/run_allin1_lean.py`, then the
# container + image are torn down.
#
# natten is intentionally NOT installed: it has no CPU wheels and its CUDA-only
# build breaks `import allin1`. tools/python/natten_shim.py reimplements the
# four legacy natten functions in pure torch; run_allin1_lean.py applies the
# shim before importing allin1 — the same approach run.sh uses on bare metal.
#
# Inherits Python 3.11 + CPU torch 2.1.0 + librosa + numpy<2 from
# experimental-torch-base (built first in the same Cloud Build).
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-torch-base:latest

# madmom from the CPJKU community fork — upstream 0.16.1 is abandoned and won't
# build on modern Python. Cython first so madmom's C extensions compile.
RUN pip install --no-cache-dir "Cython>=0.29" \
    && pip install --no-cache-dir "madmom @ git+https://github.com/CPJKU/madmom.git"

# allin1 + its deps (demucs comes along for the internal demix). natten is
# omitted on purpose (see header); the shim covers it at runtime.
RUN pip install --no-cache-dir allin1

COPY tools/python/paths.py       /app/tools/python/paths.py
COPY tools/python/natten_shim.py /app/tools/python/natten_shim.py
COPY tools/run_allin1_lean.py    /app/tools/run_allin1_lean.py
COPY data-default/               /app/data-default/

# No server. Stay alive so the batch can be exec'd, then the container is removed.
CMD ["sleep", "infinity"]
