# MSAF sidecar — Music Structure Analysis Framework boundary detection.
# Listens on :8002, called by the web container as http://msaf:8002/api/msaf/*.
#
# MSAF (last released 2020) is unmaintained and pins old numpy/scipy. We use
# Python 3.10 + numpy<1.24 to give it a stable foundation; newer pythons or
# numpy break msaf's internal Cython extensions.
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    NUMBA_CACHE_DIR=/tmp/numba-cache

# librosa needs ffmpeg/libsndfile to decode mp3. build-essential lets MSAF
# compile its Cython bits during install on arm64 wheels that aren't published.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin numpy<1.24 (msaf imports np.int / np.float which were removed in 1.24).
# librosa 0.9.x pairs with this numpy floor; 0.10+ requires newer numpy.
RUN pip install --no-cache-dir \
        "numpy>=1.20,<1.24" \
        "scipy>=1.7,<1.11" \
        "soundfile>=0.10.0" \
        "audioread>=3.0.0" \
        "librosa>=0.9.0,<0.10.0" \
        "scikit-learn>=1.0,<1.3" \
        "Cython>=0.29" \
    && pip install --no-cache-dir "msaf>=0.1.80"

COPY tools/python/paths.py       /app/tools/python/paths.py
COPY tools/python/msaf_server.py /app/tools/python/msaf_server.py

# Read-only seed dataset so MSAF can analyse the shipped default tracks even
# when the user's data/ is empty.
COPY data-default/               /app/data-default/

EXPOSE 8002
CMD ["python", "tools/python/msaf_server.py"]
