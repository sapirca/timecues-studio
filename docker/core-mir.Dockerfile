# Unified core MIR sidecar — runs four backend servers in one container.
#
#   bpm        :8004   librosa + madmom-fork (CPJKU community)
#   mir        :8007   librosa + scipy + pyloudnorm + MIRtoolbox-parity custom
#   ruptures   :8003   librosa + ruptures change-point detection
#   custom     :8005   user-uploaded Python detector sandbox (rlimit child fork)
#
# All four shared an identical Python 3.11 + numpy>=1.24 + librosa>=0.10
# floor, so each was redundantly installing the same ~600 MB of wheels.
# Merging cuts registry storage and pull bytes to one copy and replaces
# four `docker compose pull / up` cycles with one. msaf stays standalone
# because its pins are incompatible (Python 3.10, numpy<1.24, librosa<0.10);
# mir-eval stays standalone because it has no librosa / ffmpeg deps to
# gain from sharing the base; web is Node.
#
# Supervision: supervisord (pip-installed, ~3 MB) runs each server as its
# own child process so they restart independently. The trade-off relative
# to four separate containers is that a container-level OOM or crash takes
# all four down at once. The dependency-conflict argument that originally
# drove the per-service split (madmom vs MSAF vs essentia pinning
# incompatible numpy/scipy ranges) doesn't apply within this union of
# pins — madmom, librosa, ruptures, sklearn, pyloudnorm all sit on the
# same numpy>=1.24 / scipy>=1.10 floor.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    NUMBA_CACHE_DIR=/tmp/numba-cache

# Audio I/O system libs + Vamp host (the QM tempo-tracker .so isn't in
# Debian; users can drop a plugin into /usr/lib/vamp at runtime). git is
# needed because we pull madmom from its maintained community fork.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
        build-essential \
        git \
        vamp-plugin-sdk \
        vamp-examples \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Shared librosa + scipy floor (the common substrate all four servers use).
RUN pip install --no-cache-dir \
        "numpy>=1.24.0" \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0"

# bpm extras: Cython is a build-time prereq; CPJKU community fork replaces
# upstream madmom 0.16.1 which is abandoned and won't build on modern
# numpy / Python.
RUN pip install --no-cache-dir "Cython>=0.29" \
    && pip install --no-cache-dir "git+https://github.com/CPJKU/madmom.git"

# mir extras: pyloudnorm for EBU R128 / BS.1770 integrated LUFS (pure
# Python, multiarch).
RUN pip install --no-cache-dir "pyloudnorm>=0.1.1"

# ruptures + custom share these: ruptures change-point library and
# scikit-learn (used by both the ruptures server and the custom sandbox
# for clustering / nearest-neighbor helpers).
RUN pip install --no-cache-dir \
        "ruptures>=1.1.7" \
        "scikit-learn>=1.3.0"

# Supervisor (pip, not apt — smaller and self-contained).
RUN pip install --no-cache-dir supervisor

# Shared package + per-server scripts.
COPY tools/python/paths.py            /app/tools/python/paths.py
COPY tools/python/bpm_server.py       /app/tools/python/bpm_server.py
COPY tools/python/mir_server.py       /app/tools/python/mir_server.py
COPY tools/python/ruptures_server.py  /app/tools/python/ruptures_server.py
COPY tools/python/custom_server.py    /app/tools/python/custom_server.py
COPY tools/python/custom_loader.py    /app/tools/python/custom_loader.py
COPY tools/python/custom_runner.py    /app/tools/python/custom_runner.py
COPY tools/python/custom_api.py       /app/tools/python/custom_api.py
COPY tools/python/shared/             /app/tools/python/shared/

# Seed detectors at a sibling path so a runtime bind mount on
# tools/python/custom/ doesn't hide them. The entrypoint promotes any
# missing files into the live dir on start (idempotent — never clobbers
# user uploads).
COPY tools/python/custom/             /app/tools/python/custom-seed/

# Read-only CC0 default dataset so every server can detect on the shipped
# default tracks even when the user's data/ is empty.
COPY data-default/                    /app/data-default/

# Supervisor config + entrypoint.
COPY docker/core-mir.supervisord.conf /app/supervisord.conf
COPY docker/core-mir-entrypoint.sh    /usr/local/bin/core-mir-entrypoint.sh
RUN chmod +x /usr/local/bin/core-mir-entrypoint.sh

EXPOSE 8003 8004 8005 8007
CMD ["/usr/local/bin/core-mir-entrypoint.sh"]
