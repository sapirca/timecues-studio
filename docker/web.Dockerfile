# React + Vite frontend (also hosts the file-system-backed /api/* plugins).
# Listens on :5173. Acts as the only host-facing port. Reaches the python
# sidecars (bpm/mir-eval/ruptures) over the docker-compose network using
# service names (configured via env in vite.config.ts).
#
# Two on-disk data trees:
#   /app/data         — bind-mounted from host at runtime; contains the user's
#                       audio, annotations, and algorithm caches. NOT baked
#                       into the image (.dockerignored).
#   /app/data-default — read-only seeds shipped inside the image; contains the
#                       CC0 audio + song-info that the app falls back to when
#                       the user's data/ doesn't have a slug.
#
# Bind mounts at runtime (declared in docker-compose.yml):
#   ./web-app   -> /app/web-app    (source; live-reload during dev)
#   ./data      -> /app/data       (user dataset + annotations)
#
# An anonymous volume on /app/web-app/node_modules preserves the image's
# Linux-built deps even when the host's web-app/ overlays it.
FROM node:20-slim

ENV NODE_ENV=development \
    CHOKIDAR_USEPOLLING=true \
    CI=true

WORKDIR /app/web-app

# Install deps in their own layer so changes to source don't bust the cache.
COPY web-app/package.json web-app/package-lock.json ./
RUN npm ci

# Bake the source so `docker run` works even without the bind mount.
# Compose mounts ./web-app over this path for hot reload — node_modules is
# protected by an anonymous volume declared in docker-compose.yml.
COPY web-app/ ./

# Ship the read-only default dataset (CC0 audio + song-info). Lives at
# /app/data-default and is not overlaid by any bind mount, so the web app's
# fallback resolver can always find these slugs even on a fresh install with
# an empty user-mounted data/.
COPY data-default/ /app/data-default/

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
