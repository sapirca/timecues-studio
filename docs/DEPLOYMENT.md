# Deploying TimeCues

This guide is for putting TimeCues on the open internet — a shared URL your
team (or the public) can reach, instead of `localhost` on your own machine. If
you only want to run it on your own computer, you don't need any of this; see
[How to run](USER_GUIDE.md#installation) instead.

The short version: TimeCues is a standard Docker Compose application, so
"deploying" it means running that same stack on a server that has a public
address, with two things added on top — **HTTPS** (so browsers and Google
sign-in trust it) and a **persistent disk** (so your songs and annotations
survive a restart). Any host that runs Docker will do: a cloud VM, a rented
box, a machine in your office, or a homelab.

## What you'll end up with

- The TimeCues web app reachable at a real `https://…` address.
- Google sign-in working, so each person gets their own annotator namespace.
- All audio, annotations, and caches stored on a disk that you can back up.

## Before you start

You need three things:

1. **A host that runs Docker** with Docker Compose v2. 2 vCPUs and ~4 GB of
   RAM are enough for the core app; add more RAM if you'll run the heavy
   Demucs/All-In-One models (see *Optional heavy models* below).
2. **A domain name** (or any hostname) that points at the host's public IP.
   HTTPS certificates and Google sign-in are tied to a hostname, so a bare IP
   address won't do.
3. **A Google OAuth client ID** whose authorized origin matches that
   hostname. The app ships with a demo client that only trusts `localhost`,
   so for any other address you register your own — it's free, and the steps
   are in the [user guide's sign-in section](USER_GUIDE.md#sign-in--identity).

## Step by step (any cloud VM)

The walkthrough below uses a single cloud virtual machine, which is the
simplest production setup. The commands are the same on Google Cloud, AWS,
Azure, DigitalOcean, or a box under your desk — only the "create a VM" step
differs per provider.

1. **Create the VM and open ports 80 and 443.** Pick a Linux image (Debian or
   Ubuntu is fine). In the firewall, allow inbound HTTP (80) and HTTPS (443)
   from anywhere; everything else stays closed.

2. **Point your domain at the VM.** Create a DNS `A` record for your hostname
   (e.g. `timecues.example.com`) pointing at the VM's public IP address. DNS
   can take a few minutes to propagate.

3. **Install Docker on the VM.** Follow Docker's official install guide for
   your Linux distribution, then confirm `docker compose version` works.

4. **Clone the repo and configure it.**

   ```bash
   git clone https://github.com/sapirca/timecues-studio.git
   cd timecues-studio
   cp .env.example .env
   ```

   Edit `.env` and set two values (see *Configuration* below for the full
   list):

   - `DATA_DIR` — an absolute path on a **persistent** disk, e.g.
     `/var/lib/timecues/data`. This is where every song and annotation lives,
     so it must not be a throwaway location.
   - `VITE_GOOGLE_CLIENT_ID` — your own OAuth client ID from the step above.

5. **Start the stack.**

   ```bash
   docker compose up -d --build
   ```

   This builds the images on first run (a few minutes) and starts the web app
   plus its analysis services. The web app listens on port 5173 *inside* the
   Docker network — you don't expose that to the world directly; the reverse
   proxy in the next step does.

6. **Put HTTPS in front with a reverse proxy.** A reverse proxy terminates
   HTTPS on ports 80/443 and forwards requests to the app on 5173. The
   easiest option is [Caddy](https://caddyserver.com/), which obtains and
   renews a free Let's Encrypt certificate automatically — a two-line config
   is all it takes:

   ```caddy
   timecues.example.com {
       reverse_proxy localhost:5173
   }
   ```

   Run Caddy on the host (or as another container), and it will provision the
   certificate the first time someone visits your hostname over HTTPS.
   Traefik or nginx + certbot work just as well if you already use them.

7. **Open your hostname and claim the workspace.** Visit
   `https://timecues.example.com`, click **Start a new dataset**, and sign in
   with Google. The first person to sign in becomes the admin and can then
   invite the rest of the team from the Team page. Your deployment is live.

## Configuration

Everything is set in `.env` (copied from `.env.example`). The defaults boot a
working install; for a public deployment you normally only touch the first
two:

| Variable | What it's for |
|---|---|
| `DATA_DIR` | Absolute host path where audio, annotations, and caches persist. Point it at a mounted disk you back up — not the repo folder or the OS root. |
| `VITE_GOOGLE_CLIENT_ID` | Your Google OAuth client ID. Required on any hostname other than `localhost`; remember to add your hostname to the client's *Authorized JavaScript origins* or Google rejects the sign-in popup. |
| `HOST_UID` / `HOST_GID` | **Linux hosts only.** Set these to your user's `id -u` / `id -g` so files written into `DATA_DIR` aren't owned by root. |

The full per-platform, per-profile reference — including local development
without Docker, Apple Silicon notes, and every flag — lives in
[INSTALL.md](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md).

## Optional heavy models

The base stack covers manual/eye/auto-guess annotation, MSAF, ruptures, BPM
detection, and custom detectors — enough for most teams. Two heavier
capabilities are opt-in, because they need much more disk and RAM:

- **Stem separation + All-In-One** (Demucs) — add `--profile demucs-cpu`
  (works anywhere) or `--profile demucs-gpu` (needs an NVIDIA GPU, much
  faster) to your `docker compose up` line.
- **Experimental MIR detectors** — add `--profile experimental-models`.

Profiles are additive, so a deployment matching the public hosted instance is:

```bash
docker compose --profile demucs-cpu --profile experimental-models up -d --build
```

Switching profiles later is just `docker compose down` followed by a new `up`
line — your data under `DATA_DIR` is untouched. The detailed trade-offs
(image sizes, speeds, host requirements) are in
[INSTALL.md](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md#demucs-profiles-stems-daemon--allin1-batch).

## Updating a running deployment

To pull in new code:

```bash
git pull
docker compose up -d --build
```

The rebuild reuses cached layers, so updates are usually quick, and your
`DATA_DIR` is never touched. If you want this to happen automatically on every
push, wire a small CI job (GitHub Actions, Google Cloud Build, or a webhook)
that SSHes to the host and runs those two commands — that's exactly how the
public hosted instance redeploys itself.

## Backing up

Everything that matters lives in one place: the `DATA_DIR` you configured.
Snapshotting or copying that directory captures the entire corpus — songs,
annotations, annotator profiles, and the corpus config — because the rest of
the app is stateless code you can rebuild from the repo at any time. The
regenerable algorithm caches inside it can be safely dropped to save space;
which files are precious versus rebuildable is spelled out in the
[Data model](../DATA.md#source-of-truth-vs-regenerable).

## Troubleshooting

- **Google sign-in popup is rejected / closes immediately.** Your hostname
  isn't on the OAuth client's *Authorized JavaScript origins* list, or
  `VITE_GOOGLE_CLIENT_ID` still points at the demo client. Fix both and
  rebuild.
- **Certificate won't provision.** The hostname's DNS `A` record must resolve
  to this host, and ports 80 **and** 443 must be open to the internet —
  Let's Encrypt validates over both.
- **Files in `DATA_DIR` are owned by root (Linux).** Set `HOST_UID` /
  `HOST_GID` in `.env` and recreate the containers.

More fixes — slow first build, ports already in use, containers exiting
silently — are in
[INSTALL.md → Troubleshooting](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md#troubleshooting).
