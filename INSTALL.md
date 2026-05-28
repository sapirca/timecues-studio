# Installation

TimeCues Studio is a Docker Compose stack: a React + Vite web app plus a handful
of Python analysis sidecars. This document covers every supported install path,
from "click a link and try it" to "self-host on the public internet."

If you only want to *use* the app, read [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
once the stack is up. This file is about getting the stack up.

## Pick a path

| If you want to… | Go to |
|---|---|
| Try it without installing anything | [Demo mode (no install)](#demo-mode-no-install) |
| Run the full stack on your laptop (no stem separation) | [Docker on localhost](#docker-on-localhost) |
| Add stem separation — slow but works anywhere | [Demucs CPU](#demucs-profiles-stems-daemon--allin1-batch) |
| Add stem separation — fast, needs NVIDIA GPU | [Demucs GPU](#demucs-profiles-stems-daemon--allin1-batch) |
| Edit code with hot reload | [Local development (no Docker)](#local-development-no-docker) |
| Self-host beyond localhost | [Self-hosting beyond localhost](#self-hosting-beyond-localhost) |
| Use experimental detectors (BeatNet, Silero-VAD, Whisper, …) | [Experimental-models profile](#experimental-models-profile) |

## Run modes at a glance

Every install path is one of these. The two opt-in dimensions are
**Demucs** (stems + All-In-One) and **Experimental models** (the Phase-1+
MIR detectors). Both are off by default for local docker, both are on by
default for `run.sh` and the hosted instance — that keeps first-time
`docker compose up` lean while local dev and prod stay capability-complete.

| Mode | Command | Core | Demucs | Experimental | Disk (first build) | Best for |
|---|---|:---:|:---:|:---:|---|---|
| Demo (hosted) | — (browser) | ✔ | ✔ | ✔ | 0 | Quick tour, no install |
| Docker — minimal | `docker compose up --build` | ✔ | ✘ | ✘ | ~1 GB | First evaluation; smallest footprint |
| Docker — Demucs CPU | `docker compose --profile demucs-cpu up --build` | ✔ | ✔ (slow) | ✘ | ~2 GB | Stems on any host, no GPU needed |
| Docker — Demucs GPU | `docker compose --profile demucs-gpu up --build` | ✔ | ✔ (fast) | ✘ | ~4 GB | Stemming a corpus on NVIDIA + Linux/WSL2 |
| Docker — Experimental | `docker compose --profile experimental-models up --build` | ✔ | ✘ | ✔ | ~7 GB | Try the new MIR detectors without stems |
| Docker — full | `docker compose --profile demucs-cpu --profile experimental-models up --build` | ✔ | ✔ | ✔ | ~8 GB | Matches the hosted instance locally |
| Local dev (`./run.sh`) | `./run.sh` | ✔ | ✔ (CPU, optional pip) | ✔ (optional pip) | tiny (uses host Python) | Hot-reload editing; stems + experimental servers degrade gracefully if their pip deps are absent |
| Self-hosted (prod) | see [Self-hosting](#self-hosting-beyond-localhost) | ✔ | ✔ | ✔ | ~8 GB | Public-facing deployment with Caddy + TLS; matches the hosted instance |

**Notes:**
- Profiles are **additive** — combine `--profile demucs-cpu` and
  `--profile experimental-models` on the same `up` line to bring both up.
  Order doesn't matter.
- Each experimental detector is *also* gated by a per-family user-settings
  flag inside the app (**Settings → Experimental annotation types &
  models**). So a sidecar can be running without its UI surface being
  visible. Flip the flag to surface the family's detectors in the inspector
  sidebar and the all-songs eval tables. The flag and the sidecar are linked:
  a family's toggle is **disabled** (with an install hint) until its sidecar is
  reachable, and the inspector surface **auto-hides** if the sidecar isn't
  running — even when the flag was previously left on. So you never see a
  detector you can't actually run.
- Switching modes later is just `docker compose down` + a new `up` line —
  your audio / annotations / caches under `data/` persist across all
  profiles.
- **Local dev (`./run.sh`) uses your host Python**, so any feature that
  needs a heavy pip dep (Demucs, BeatNet, Whisper, etc.) requires you to
  `pip install` it once. Quickest path:
  `pip install -r tools/python/requirements.txt`. Without those packages
  the corresponding sidecars still start but mark themselves
  `available=false`, and the UI surface reads "Deps missing" instead of
  "Server off". The CPU build of Demucs works fine for local stemming —
  no NVIDIA hardware required for the `./run.sh` path; it's just slower
  than the GPU compose profile.

## Prerequisites

| Path | Required |
|---|---|
| Demo mode | Web browser |
| Docker on localhost | Docker Desktop (Mac/Win) **or** Docker Engine + Compose v2 (Linux); 4 GB RAM, 8 GB disk |
| Local development | Node 20+, Python 3.10+, `ffmpeg`, plus everything above |
| Self-hosting | A Docker host + an HTTPS reverse proxy of your choice |

All install paths assume `git` is available.

## Demo mode (no install)

Visit the hosted instance and click **Enter Demo** on the landing page. You
get a read-only tour of the app against a small set of pre-loaded tracks —
no sign-in, no data persistence, no install.

> The hosted URL is published on the [project page](#project-page--archive).
> The demo is a courtesy of the maintainers; it is **not** required for
> reproducing the paper's results.

## Docker on localhost

The recommended path for evaluators. Brings up the full stack — web app plus
five Python analysis services — on `http://localhost:5173`.

```bash
git clone https://github.com/<owner>/timecues-studio.git
cd timecues-studio
cp .env.example .env             # default values are fine for localhost
docker compose up --build        # first run; subsequent: `docker compose up`
# open http://localhost:5173
```

First build downloads ~2 GB of Python wheels and Node packages. Expect 5–15
minutes depending on connection. Subsequent starts are seconds.

### What gets started

| Service | Port | Purpose |
|---|---|---|
| `web` | 5173 | React + Vite dev server (also proxies `/api/*` to the sidecars) |
| `mir-eval` | 8001 | `mir_eval` precision/recall/F-measure scoring |
| `ruptures` | 8003 | Change-point detection family |
| `bpm` | 8004 | librosa + CPJKU-madmom-fork BPM detectors |
| `mir` | 8005 | MIR features (librosa + optional Essentia — see [NOTICE.md](NOTICE.md)) |

Stem separation (Demucs) and the heavy All-In-One batch runner are **not**
started by the default `docker compose up`. The UI hides the **▶ Stem this
song** button and disables the All-In-One algorithm when no Demucs profile
is active — everything else works. To turn stems on, restart compose with
either `--profile demucs-cpu` (works on every host, slow) or
`--profile demucs-gpu` (needs an NVIDIA GPU, fast). Full breakdown in
[Demucs profiles](#demucs-profiles-stems-daemon--allin1-batch) below.

### Customizing the data directory

By default, uploads + annotations + algorithm caches live in `./data/`. To
point at a directory elsewhere on disk, edit `.env`:

```bash
DATA_DIR=/Users/you/timecues-data
```

The directory is created on first run if missing. Persists across
`docker compose down` and `docker compose up`. Removed only by
`docker compose down -v` (which also drops named volumes).

### Linux: file ownership

On Linux, files written by the containers will be owned by `root` unless you
set the host UID/GID in `.env`:

```bash
HOST_UID=1000   # output of `id -u`
HOST_GID=1000   # output of `id -g`
```

Mac and Windows users can leave these unset — Docker Desktop handles it.

### Stopping the stack

```bash
docker compose down              # stops + removes containers; keeps data
docker compose down -v           # also removes the data volume — destructive
```

## Local development (no Docker)

Use this if you're editing TypeScript or Python and want hot reload. The
web app needs to be running on `:5173` so OAuth works against the pre-registered
client; the Python sidecars can run on the host or in containers — mix and
match as you like.

```bash
# 1. System deps
brew install ffmpeg node@20              # macOS
sudo apt install ffmpeg libsndfile1 nodejs npm   # Ubuntu

# 2. Launch everything — `./run.sh` installs every model dep on first run.
./run.sh
```

That's it for the happy path. `./run.sh` auto-installs `requirements.txt` +
torch (CPU) + `requirements-allin1.txt` + `requirements-experimental.txt`
into your active Python on first launch, then starts all 15 sidecars
(ports 8001–8007 and 8009–8016) before handing off to vite. Subsequent runs
skip the install steps via fast `python -c "import …"` probes.

### Opting out of the auto-install

If you manage your own Python env (a strict venv, a corporate base image,
a Conda recipe), set `SKIP_MODEL_INSTALL=1` to short-circuit the install
steps:

```bash
SKIP_MODEL_INSTALL=1 ./run.sh
```

Sidecars still start; the ones whose deps aren't importable just report
`available=false` through their `/health` endpoint and the UI surfaces
**Deps missing** in **Settings → Experimental annotation types & models →
Initialize models**. Same shape as before, just no automatic remediation.

### Per-feature install recipes (manual install path)

If you want to cherry-pick what's installed instead of letting `./run.sh`
pull everything, paste only the lines you need into your env:

```bash
# Core sidecars (covers demucs + mir_eval + ruptures + librosa + sklearn)
pip install -r tools/python/requirements.txt

# Stems daemon + All-In-One — adds torch CPU + mir-aidj allin1 + madmom fork
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r tools/requirements-allin1.txt

# All 8 experimental MIR sidecars in one shot — needs torch from above
pip install -r tools/requirements-experimental.txt

# autochord lives in its own requirements file — it pulls the `vamp` C
# extension which links against the `vamp-plugin-sdk` system lib. Install
# the system lib first (`sudo apt-get install -y vamp-plugin-sdk` on
# Debian/Ubuntu, `brew install vamp-plugin-sdk` on macOS), then:
pip install --no-build-isolation -r tools/requirements-autochord.txt

# Cherry-pick a single experimental family
pip install BeatNet                                       # CUE beats / downbeats
pip install basic-pitch                                   # CUE polyphonic notes (needs Python < 3.12)
pip install panns_inference                               # SPAN AudioSet tagging
pip install --no-build-isolation autochord                # CUE chord recognition (needs vamp-plugin-sdk system lib)
pip install openai-whisper                                # LYRICS transcription
# Silero-VAD has no pip dep — torch.hub fetches it on first run.
# JDCNet has no pip dep — pure-PyTorch port, weights pulled at first run.
# Loop / cue-extras / percussive only need librosa (already covered).
```

After installing, restart `./run.sh` (or just the affected server) and the
Initialize-models panel will flip from "Deps missing" → "Not loaded" →
"Ready" on the next refresh.

### Launching sidecars manually (without run.sh)

```bash
cd web-app && npm install && npm run dev          # web :5173
python tools/python/mir_eval_server.py            # :8001
python tools/python/msaf_server.py                # :8002
python tools/python/ruptures_server.py            # :8003
python tools/python/bpm_server.py                 # :8004
python tools/python/custom_server.py              # :8005
python tools/python/stems_server.py               # :8006
python tools/python/mir_server.py                 # :8007
# Experimental sidecars — each boots even without its model dep installed
# and reports available=false through the Initialize-models panel.
python tools/python/span_server.py                # :8009  SPAN family
python tools/python/beatnet_server.py             # :8010  BeatNet (CUE)
python tools/python/pitch_server.py               # :8011  basic-pitch (CUE)
python tools/python/loop_server.py                # :8012  LOOP family
python tools/python/panns_server.py               # :8013  PANNs (SPAN)
python tools/python/cue_extras_server.py          # :8014  key / chord / onsets
python tools/python/percussive_server.py          # :8015  HPSS (SPAN)
python tools/python/lyrics_server.py              # :8016  Whisper (LYRICS)
```

> **Match the vite probe's Python.** Vite's `/api/capabilities` runs a
> Python probe to detect whether `demucs` / `allin1` / torch are
> importable. By default it uses `python3` on PATH — which can differ
> from the `python` your `pip install` lands in (e.g. inside a venv).
> If the UI insists Demucs is missing after `pip install`, set the
> `TIMECUES_PYTHON` env var to the absolute path of the interpreter you
> installed into, then restart vite:
> ```bash
> export TIMECUES_PYTHON=$(which python)   # or the venv's python
> ./run.sh
> ```
> `./run.sh` sets this automatically when it does the install itself.

### What `run.sh` actually does

[run.sh](run.sh) is a one-shot launcher that:

1. Picks one Python interpreter (`$PYTHON`, defaulting to `python`, then
   `python3`) and exports its absolute path as `TIMECUES_PYTHON` so vite's
   capabilities probe inspects the same site-packages.
2. Unless `SKIP_MODEL_INSTALL=1` is set, runs four `python -c "import …"`
   probes and pip-installs whatever's missing: core requirements, torch
   CPU wheels, the allin1 + madmom fork, and the experimental MIR deps.
3. Prewarms heavy imports (`torch`, `demucs`, `allin1`) so the capabilities
   probe doesn't pay the cold-import cost the first time the UI loads.
4. Kills any process squatting on ports 8001–8007 and 8009–8016, then
   `nohup`-starts every sidecar in the background with the locked-in
   Python binary.
5. Hands off to `npm run dev` in `web-app/`.

If a model dep is unavailable (e.g. `SKIP_MODEL_INSTALL=1` plus a clean
env), the sidecar still boots — its imports are guarded by try/except, so
`/api/<family>/health` reports `available=false` and the UI surfaces
**Deps missing** in **Settings → Experimental annotation types & models →
Initialize models** rather than "Server off".

Vite proxies `/api/*` to the sidecar ports listed above — see
[web-app/vite.config.ts](web-app/vite.config.ts). If a sidecar is not running,
the corresponding feature in the UI will surface an error toast but the rest
of the app keeps working.

## Self-hosting beyond localhost

The Docker Compose stack runs anywhere Docker runs — bare-metal Linux, a
single cloud VM, a homelab, or an internal cluster. The standard pattern is:

1. Pick a host with Docker + Compose v2 installed.
2. Clone this repo on the host.
3. Set `DATA_DIR` to a persistent path (a mounted disk, not the OS root).
4. Put an HTTPS reverse proxy in front (Caddy, Traefik, nginx + certbot).
   Point it at `web:5173` inside the compose network.
5. Set `VITE_GOOGLE_CLIENT_ID` in `.env` to an OAuth client whose authorized
   origin matches your public hostname (see [Sign-in](#sign-in-google-oauth)).
6. `docker compose up -d`.

## Demucs profiles (stems daemon + allin1 batch)

**Demucs** is the source-separation model behind the "▶ Stem this song" button
and the **All-In-One** structure algorithm — both depend on isolated stems
(vocals / drums / bass / other). Because it's heavy (~1 GB CPU image, ~3 GB
CUDA image) and most evaluators don't need it on first launch, it's **opt-in**
locally: `docker compose up` does NOT start it. Turn it on with a compose
**profile**. You have three choices — pick at most one per host:

### The three install options

| Mode | Command | What it gives you | What it costs |
|------|---------|-------------------|---------------|
| **No Demucs** (default) | `docker compose up --build` | Editor + 5 analysis sidecars. Manual / Eye / Auto-guess annotation, MSAF, Ruptures, BPM, MIR features, custom detectors all work. | Smallest install (~1 GB total). **▶ Stem this song** hidden, **All-In-One** disabled. |
| **Demucs CPU** | `docker compose --profile demucs-cpu up --build` | Adds the stems daemon + All-In-One. Vocals / Drums / Bass / Other source picker, ▶ Stem this song button, All-In-One algorithm row all enabled. | ~1 GB extra image. Stemming a 3-min song takes ~3–5 min. Works on Mac, Apple Silicon, Linux, Windows. |
| **Demucs GPU** | `docker compose --profile demucs-gpu up --build` | Same UI features as CPU mode. | ~3 GB extra image. ~30–60 s per song. Requires NVIDIA GPU + drivers + NVIDIA Container Toolkit; Linux / WSL2 only. |

### What each option actually means for you

**No Demucs (the default)**
- Smallest, fastest install: just the editor + the 5 lightweight analysis sidecars.
- In the UI: the **▶ Stem this song** button is **hidden** in Dataset Prep,
  the **Vocals / Drums / Bass / Other** entries in the Source picker show a
  "no stems cached" placeholder, and the **All-In-One** checkbox in Algorithm
  Inspect is **disabled** with a "Demucs profile needed" tooltip.
- Everything else — Manual / Eye / Auto-guess annotation, MSAF, Ruptures,
  BPM, MIR features, custom detectors, scoring — works normally.
- Switch on later by adding `--profile demucs-cpu` (or `-gpu`) to your
  `docker compose up` line. No data migration needed.

**Demucs CPU (`--profile demucs-cpu`)**
- Adds a `stems-cpu` container (built from `docker/gpu-tools.Dockerfile`
  with `FLAVOR=cpu`) that exposes the HTTP stems daemon on port 8006.
- Runs everywhere Docker runs — macOS Intel + Apple Silicon, Windows,
  Linux amd64 + arm64. No CUDA driver required.
- **Speed:** a 3–4 min song takes ~3–5 minutes to stem; All-In-One takes
  about the same. Fine for one-off use, slow for batch.
- Image is ~1 GB. Stem WAVs (~16–60 MB per song) land under
  `data/stems/<slug>/`.
- In the UI: **▶ Stem this song** appears in Dataset Prep, the Source
  picker's Vocals / Drums / Bass / Other entries activate once stems
  finish, and All-In-One is enabled.

**Demucs GPU (`--profile demucs-gpu`)**
- Adds a `stems-gpu` container built against the CUDA 12.1 PyTorch base.
  Pinned to `linux/amd64` (the CUDA base image is amd64-only).
- **Requires:** NVIDIA GPU with current drivers + the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
  installed on the host. Linux or Windows-WSL2 only — macOS has no CUDA.
- **Speed:** ~30–60 s per song for stems, similar for All-In-One. Use this
  if you're stemming a whole corpus.
- Image is ~3 GB (CUDA wheels).
- UI behaviour is identical to CPU mode — the Stem button just finishes
  much faster.

> Both Demucs modes advertise the same network alias (`stems`) inside the
> compose network, so the web container always reaches the active flavor
> via `STEMS_HOST=stems` — no config change needed when you switch.

### Batch runs (allin1 / Demucs CLI)

The same image powers the one-shot batch runners. Use `compose run` to
override the daemon's default command:

```bash
docker compose --profile demucs-cpu run --rm stems-cpu \
  python tools/run_allin1.py /app/data/songs
docker compose --profile demucs-gpu run --rm stems-gpu \
  python tools/run_demucs_songs.py /app/data/songs
```

`compose run` spins up a fresh container for the one-shot, leaving your
running stems daemon untouched.

### Switching modes later

Your audio + annotations + caches all live under `data/` regardless of
which profile is active, so switching is just a compose restart:

```bash
docker compose down
docker compose --profile demucs-gpu up -d           # was --profile demucs-cpu
```

Stems already on disk are reused; only newly requested ones use the new
flavor.

## Experimental-models profile

The Phase-1+ MIR detectors live behind a dedicated docker compose profile so
a plain `docker compose up` keeps your local stack lean. **They never come
up by default** — you have to opt in explicitly by passing the profile:

```bash
docker compose --profile experimental-models up --build
```

Combine with other profiles freely (order is irrelevant):

```bash
docker compose --profile demucs-cpu --profile experimental-models up --build
```

Once enabled, eight extra sidecars start alongside the core stack:

| Service | Port | What it runs |
|---|---|---|
| `span`       | 8009 | `tools/python/span_server.py` — Silero-VAD + JDCNet voicing |
| `beatnet`    | 8010 | `tools/python/beatnet_server.py` — BeatNet beats / downbeats / meter |
| `pitch`      | 8011 | `tools/python/pitch_server.py` — basic-pitch (Spotify polyphonic notes) |
| `loop`       | 8012 | `tools/python/loop_server.py` — chroma-autocorrelation loop finder |
| `panns`      | 8013 | `tools/python/panns_server.py` — PANNs CNN14 AudioSet-527 tagging |
| `cue-extras` | 8014 | `tools/python/cue_extras_server.py` — librosa key / autochord / librosa onsets |
| `percussive` | 8015 | `tools/python/percussive_server.py` — HPSS percussive spans |
| `lyrics`     | 8016 | `tools/python/lyrics_server.py` — Whisper-base vocal transcription |

Disk cost on first build: ~6 GB total (torch wheels dominate). Heavy
weights (PANNs ~80 MB, Whisper-base ~140 MB) lazy-download on first use
into the shared `timecues-model-cache` named volume so subsequent
container restarts skip the download.

Each detector is also gated client-side by a **per-family user-settings
flag**. So even with the profile running, the UI surfaces stay hidden
until you opt in via **Settings → Experimental annotation types & models**:

- `experimentalSpanFamily` — Silero-VAD, JDCNet, PANNs, HPSS percussive
- `experimentalCueExtras` — BeatNet, basic-pitch, librosa key, autochord, librosa onsets
- `experimentalLoopFamily` — chroma-autocorrelation
- `experimentalLyricsFamily` — Whisper-base

Without the profile, the corresponding `/api/<family>/*` calls return 503
and the UI shows **Server off** in the Initialize-models panel — no broken
state, just dimmed buttons. Flip the profile on, restart compose, and the
panel auto-detects the live sidecars on its next refresh.

See [docs/EXPERIMENTAL_USER_GUIDE.md](docs/EXPERIMENTAL_USER_GUIDE.md) for
the full per-detector reference (licences, weight sizes, output schemas).

## Sign-in (Google OAuth)

`docker-compose.yml` ships a working `VITE_GOOGLE_CLIENT_ID` for the upstream
demo project, so Google Sign-In works out of the box on `http://localhost:5173`.

If you want to point sign-in at your own OAuth client (required when serving
the app on a custom domain other than localhost):

1. Create an OAuth 2.0 client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Add your origin (e.g. `http://localhost:5173` or `https://your-domain.com`)
   to **Authorized JavaScript origins**.
3. Set `VITE_GOOGLE_CLIENT_ID` in `.env`.

Without a valid client ID *and* a registered origin, Google rejects the
sign-in iframe and you'll see a `400 redirect_uri_mismatch` in the console.

## Troubleshooting

### Ports already in use

`5173`, `8001`, `8003`, `8004`, `8005`, `8006` (plus `8009`, `8010` if
experimental) need to be free on the host. If something else is squatting:

```bash
lsof -iTCP:5173 -sTCP:LISTEN     # find the offender
# Either kill it, or override the port in docker-compose.yml
```

### First build is slow / fails on `pip install`

Common causes:
- Behind a corporate proxy → set `HTTP_PROXY` / `HTTPS_PROXY` in `.env`.
- Wheel mirror flakiness → re-run `docker compose build --no-cache <service>`.

### `permission denied` writing to `data/`

Linux only. Set `HOST_UID` / `HOST_GID` in `.env` as documented under
[Linux: file ownership](#linux-file-ownership), then `docker compose down`
and `docker compose up --build`.

### TLS cert provisioning fails (self-hosting)

If you're putting Caddy / Let's Encrypt in front, the most common cause is
DNS not yet propagated, or an A record that doesn't resolve to the host
running the container. `dig +short your-domain.com` should match the host's
public IP before requesting a cert.

### Container exits immediately with no logs

`docker compose logs <service>` shows the last 100 lines. If you see
`exited with code 137`, you're out of memory — bump Docker Desktop's RAM
limit to 6+ GB.

## Project page & archive

The canonical project page, source archive, and license are at:

- **Source repo:** *(filled in at submission time)*
- **Source archive (ZIP):** *(filled in at submission time)*
- **License:** [MIT](LICENSE) — see [NOTICE.md](NOTICE.md) for third-party
  acknowledgments and weight-license caveats.

## Further reading

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — every workspace, panel, button,
  file format, and REST endpoint.
- [docs/EXPERIMENTAL_USER_GUIDE.md](docs/EXPERIMENTAL_USER_GUIDE.md) —
  opt-in feature flags and the experimental detector families.
- [DATA.md](DATA.md) — on-disk layout for annotations and algorithm caches.
- [NOTICE.md](NOTICE.md) — third-party licenses and model-weight provenance.
