# mir_eval sidecar — boundary / segment metrics. Stateless: takes JSON in,
# returns JSON out. Listens on :8001.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0

WORKDIR /app

RUN pip install --no-cache-dir \
        "numpy>=1.24.0" \
        "scipy>=1.10.0" \
        "mir_eval>=0.7.0"

COPY tools/python/paths.py            /app/tools/python/paths.py
COPY tools/python/mir_eval_server.py  /app/tools/python/mir_eval_server.py

EXPOSE 8001
CMD ["python", "tools/python/mir_eval_server.py"]
