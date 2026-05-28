---
title: How to run TimeCues
description: Three ways to use TimeCues — the live demo, a local Docker stack, or self-hosted on GCP. Pick whichever matches how much control (and how little setup) you want.
---

There are three ways to get hands on the tool, in order of increasing
commitment:

## 1. Use the live demo (no setup)

The fastest path. Zero install, zero config — sign in with Google and
you get your own annotator namespace on the shared server.

🎛 **[Open the live demo →](__LIVE_DEMO_URL__)**

What you get:

- Full app, latest commit, behind HTTPS.
- A per-annotator workspace so your boundaries don't collide with anyone
  else's.
- The seed dataset (CC0 audio) so you have something to annotate
  immediately.
- Read access to other annotators' layers (comparison view) once you're
  signed in.

What you don't get:

- Local files / your own audio dataset — uploads are tier-gated. Email
  on the [contact page](/contact/) if you want upload access.
- Algorithmic detectors that need GPU (Demucs stems work; everything
  else is CPU-only on the demo).

## 2. Run locally with Docker

For when you want full control, want to push your own audio in, or want
to hack on the code. ~3 GB of images on first build; ~3 min to bring up.

```bash
git clone https://github.com/sapirca/timecues-studio.git
cd timecues-studio
cp .env.example .env
docker compose up --build      # first run; later: docker compose up
```

Then open <http://localhost:5173>. Google sign-in works on
`localhost:5173` out of the box (the upstream OAuth client allows it).

To point at your own audio collection instead of the in-repo `data/`
directory, set `DATA_DIR=/absolute/path/to/dataset` in `.env`. Uploads
through the UI land there too.

### Optional ML workloads

The five core services (web, BPM, MIR, ruptures, MSAF, custom) build
multi-arch for both `linux/amd64` and `linux/arm64` — Apple Silicon Macs
get native images, no Rosetta. The heavier ML services are opt-in:

```bash
docker compose --profile gpu up           # CUDA, NVIDIA-only, amd64-only
docker compose --profile cpu up           # multi-arch CPU, slower
docker compose --profile experimental-models up   # SPAN + BeatNet behind flags
```

The full per-platform / per-profile matrix lives in the
[user guide](/timecues/user-guide/#installation).

## 3. Self-host beyond localhost

The Docker Compose stack runs anywhere Docker runs — bare-metal Linux, a
single cloud VM, a homelab, or an internal cluster. Put an HTTPS reverse
proxy (Caddy, Traefik, nginx + certbot) in front of `web:5173`, set
`DATA_DIR` to a persistent path, and register an OAuth client whose
authorized origin matches your public hostname.

See the [installation guide](/timecues/user-guide/#installation) for the
full per-platform / per-profile matrix.

## Which should I pick?

- **Just want to see what it does?** Live demo.
- **Want to annotate your own audio without hosting anything?** Local
  Docker.
- **Want a public-URL deployment with auto-updates?** Self-host on GCP.

Switching between them is reversible — local annotations export as JSON
and import into the demo or a GCP deployment without code changes. See
[Data model](/timecues/data-model/) for the on-disk schema.
