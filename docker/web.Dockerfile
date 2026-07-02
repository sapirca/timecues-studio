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

# Client-visible env baked into the bundle at build time. With `vite build`
# (this image) — unlike the dev server — `import.meta.env.VITE_*` is frozen at
# build time, so these must arrive as build args, not runtime env. A deploy
# pipeline should pass VITE_COMMIT_SHA as a build arg. The default client ID is
# the public OAuth ID (security is enforced via the OAuth app's Authorized
# JavaScript origins, not by hiding it), so a vanilla build still has working
# Google sign-in.
ARG VITE_COMMIT_SHA=""
ARG VITE_GOOGLE_CLIENT_ID=92459674081-9lq6nitf72ptj0sg8sn05vp3g8nus4ph.apps.googleusercontent.com
ENV VITE_COMMIT_SHA=$VITE_COMMIT_SHA \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

WORKDIR /app/web-app

# Install deps in their own layer so changes to source don't bust the cache.
# devDependencies are kept (NODE_ENV is not set to production): `vite` is a
# devDependency and is required at runtime to run `vite preview`.
COPY web-app/package.json web-app/package-lock.json ./
RUN npm ci

# Bake the source, then build the production bundle. The container serves this
# prebuilt bundle via `vite preview` (static files, no HMR / no file-watching /
# no module-graph retention) so the long-running prod web process has bounded,
# stable memory — this is the root-cause fix for the host-wide OOM. Local dev
# overrides CMD back to `npm run dev` in docker-compose.yml for hot reload.
#
# `vite build` (transpile-only via esbuild/Rollup), NOT `npm run build` — the
# latter runs `tsc -b` first, and type-checking is a separate CI concern that
# must not gate the production image. The dev server this replaces never
# type-checked either, so the emitted bundle is semantically identical; we just
# pre-bundle and serve it statically instead of holding a live module graph.
COPY web-app/ ./
RUN npx vite build

# Make node_modules writable by any UID the container may run as. `npm ci`
# above created it owned by root, and it survives into dev via the anonymous
# volume on /app/web-app/node_modules. At startup vite writes its config-loader
# temp file (node_modules/.vite-temp) and dep-optimize cache (node_modules/.vite);
# under a non-root HOST_UID (the Linux data-ownership mode) those writes failed
# with EACCES. Drop any stale root-owned scratch dirs and make the node_modules
# top dir writable so the running user can (re)create them.
RUN rm -rf node_modules/.vite node_modules/.vite-temp \
    && chmod a+w node_modules

# Ship the read-only default dataset (CC0 audio + song-info). Lives at
# /app/data-default and is not overlaid by any bind mount, so the web app's
# fallback resolver can always find these slugs even on a fresh install with
# an empty user-mounted data/.
COPY data-default/ /app/data-default/

EXPOSE 5173
# Production: serve the built bundle. Stays on :5173 so caddy's
# `reverse_proxy web:5173` is unchanged.
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
