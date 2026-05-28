# MIR feature sidecar — librosa + scipy + pyloudnorm only.
# Listens on :8007, called by the web container as http://mir:8007/api/mir/*.
#
# Deliberately pure-Python (apart from librosa's audio deps): every dep
# ships prebuilt wheels for both linux/amd64 and linux/arm64 so the image
# builds reliably on Apple Silicon, Intel/AMD, and WSL2 alike. No C++
# compile steps and no source-build fallbacks.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0

# Runtime libs librosa/soundfile need for audio I/O. All are in Debian for
# both amd64 and arm64.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libsamplerate0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
        "numpy>=1.24.0" \
        "scipy>=1.10.0" \
        "soundfile>=0.12.0" \
        "audioread>=3.0.0" \
        "librosa>=0.10.0" \
        "pyloudnorm>=0.1.1"

COPY tools/python/paths.py        /app/tools/python/paths.py
COPY tools/python/mir_server.py   /app/tools/python/mir_server.py

# Seed dataset so the server can extract features for shipped default tracks
# even when the user's data/ volume is empty.
COPY data-default/                /app/data-default/

EXPOSE 8007
CMD ["python", "tools/python/mir_server.py"]
