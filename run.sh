#!/bin/bash
set -e

cd "$(dirname "$0")"

# ── CLI flags ──────────────────────────────────────────────────────────────
# --with-dj   Enable the experimental Setlist workspace (DJ-style corpus
#             ordering). v0 has no extra Python deps — it reuses the cached
#             BPM detectors — so this only auto-enables the client flag
#             (via VITE_WITH_DJ → SettingsContext default). When the bigger
#             DJ research lands (Schreiber key, chord transformer, MERT
#             embeddings), heavy installs hook in under the WITH_DJ guard
#             below.
#
# --torch     Select which PyTorch build to install: cpu (default) | gpu | none.
#               cpu  → CPU-only wheels (~200 MB, no CUDA). The safe default.
#               gpu  → CUDA wheels (pulls ~2.7 GB of nvidia/* libs; needs a GPU).
#               none → don't install torch at all (you manage it yourself, or
#                      don't need the stems / All-In-One / SPAN detectors).
#             Why this matters: `demucs` is a CORE dep and pulls torch
#             transitively. Left to pip it grabs the CUDA build by default,
#             which is huge and useless on CPU-only hosts — so we install the
#             chosen variant BEFORE the core deps (see Step 0 below).
# --with-lol  Enable the PRIVATE light-visualization integration for the
#             sibling "lol" project. Its agent reads annotations + cached
#             algorithm outputs via a read-only API at /api/lol/*. The whole
#             feature lives under archive/lol/ (export-ignored — never in the
#             OSS build) and is loaded by the dev server only when
#             VITE_WITH_LOL=1. No extra Python deps.
#
# --all       Install EVERYTHING (the full-fat profile). By default run.sh is
#             LEAN: it installs only the core deps (mir_eval / ruptures /
#             librosa / sklearn / soundfile) so basic usage — boundary
#             annotation + evaluation — works with a small, fast install and
#             no multi-GB ML wheels. The heavy families (torch, Demucs,
#             All-In-One, the experimental MIR sidecars, the Python-3.11 venv
#             for basic-pitch + autochord) are installed ONLY when --all is
#             passed. The sibling `./run_all.sh` is just `./run.sh --all`.
#             Servers for the heavy families still start in lean mode; they
#             report "Deps missing" in the UI until you re-run with --all.
WITH_DJ=0
WITH_LOL=0
FULL_INSTALL="${TIMECUES_FULL_INSTALL:-0}"   # 0 = lean (core only) | 1 = every model family
TORCH_MODE=""      # empty = pick a default from the install profile (see below)
for arg in "$@"; do
  case "$arg" in
    --all)
      FULL_INSTALL=1
      ;;
    --with-dj)
      WITH_DJ=1
      ;;
    --with-lol)
      WITH_LOL=1
      ;;
    --torch=*)
      TORCH_MODE="${arg#--torch=}"
      ;;
    --torch)
      echo "ERROR: --torch needs a value, e.g. --torch=cpu|gpu|none" >&2
      exit 1
      ;;
    --cpu)                    TORCH_MODE="cpu" ;;
    --gpu)                    TORCH_MODE="gpu" ;;
    --no-torch)               TORCH_MODE="none" ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./run.sh [options]

  (default)        LEAN install: core deps only (mir_eval / ruptures / librosa
                   / sklearn / soundfile). No torch / Demucs / All-In-One /
                   experimental sidecars. Best for basic boundary annotation +
                   evaluation with a small, fast install.
  --all            FULL install: every model family (torch, Demucs, All-In-One,
                   the experimental MIR sidecars, and the isolated per-family
                   venvs for basic-pitch / autochord / msaf). ~3 GB of wheels
                   on first run. Same as running ./run_all.sh.

  --torch=cpu      Install CPU-only PyTorch (~200 MB, no CUDA libs).
  --torch=gpu      Install CUDA PyTorch (pulls ~2.7 GB of nvidia/* wheels).
  --torch=none     Do not install PyTorch (manage it yourself / skip stems).
  --cpu|--gpu|--no-torch   Shorthands for the --torch values above.
                   Torch default: none in lean mode, cpu with --all. An explicit
                   --torch/--cpu/--gpu always wins over the profile default.
  --with-dj        Enable the experimental Setlist workspace at /setlist.
  --with-lol       Enable the private light-visualization read API at /api/lol/*.
  -h, --help       Show this help and exit.

Env:
  TIMECUES_FULL_INSTALL=1  Same as passing --all (full install profile).
  SKIP_MODEL_INSTALL=1   Skip the heavy optional families even under --all
                         (allin1, experimental MIR sidecars). Core deps + the
                         chosen torch build are still installed.
  PYTHON=/path/to/python Use a specific interpreter (e.g. a venv).
  TIMECUES_PYTHON=...    Interpreter that Vite's /api/capabilities probe should
                         inspect. Set it to your venv's python if the UI insists
                         Demucs/All-In-One are missing after a manual install;
                         the launcher sets it for you when it does the install.
  TIMECUES_KILL_PORTS=1  Skip the interactive "ports are busy, kill them?" prompt
                         and always kill + relaunch on the same ports (CI, or a
                         repeat dev loop where the ask gets tiring).
  VITE_PORT=5174         Port for the Vite dev server (default 5174). Changing it
                         moves the browser origin, and demo datasets/annotations
                         live in origin-scoped localStorage — so a different port
                         looks like your data vanished. Prefer the default.
USAGE
      exit 0
      ;;
    *)
      # Exit rather than warn: the warning scrolls past in the install output
      # and the run continues LEAN, which is indistinguishable from "all my
      # sidecars are broken". A typo should stop you, not quietly downgrade
      # what you asked for.
      echo "ERROR: unknown flag '$arg'" >&2
      # Flags are dash-separated, with no underscores. The underscore forms
      # were the spelling until 2026-09-16, so point muscle memory at the new
      # one rather than just rejecting it.
      case "$arg" in
        *_*) echo "Did you mean '${arg//_/-}'? Flags use dashes, not underscores." >&2 ;;
      esac
      echo "Run './run.sh --help' for the supported flags." >&2
      exit 1
      ;;
  esac
done
# ~/.local/bin on PATH, for every child of this script.
#
# It holds the tools we install without root — uv, and on a Mac the static
# ffmpeg. `ensure_uv` used to be the only thing that exported it, and only on
# the run that installed uv: on a host where uv was already present the export
# never happened, so the sidecars inherited a PATH with no ffmpeg. Whisper and
# ctc-forced-aligner decode by piping the file through the ffmpeg *binary*, and
# Demucs wants it too, so a machine that had ffmpeg sitting right there failed
# with a bare `FileNotFoundError: 'ffmpeg'` from inside a library. (The lyrics
# sidecar no longer needs it — see decode_mono_16k in server_common.py — but
# everything else still does.)
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# Resolve the torch default from the install profile when the user didn't pick
# one explicitly. Lean run.sh installs NO torch (stems / All-In-One / SPAN
# degrade to "Deps missing"); --all defaults to the CPU build so those work
# out of the box. An explicit --torch/--cpu/--gpu already set TORCH_MODE above
# and wins over this default.
if [ -z "$TORCH_MODE" ]; then
  if [ "$FULL_INSTALL" = "1" ]; then TORCH_MODE="cpu"; else TORCH_MODE="none"; fi
fi
case "$TORCH_MODE" in
  cpu|gpu|none) ;;
  *)
    echo "ERROR: invalid --torch value '$TORCH_MODE' (expected cpu|gpu|none)" >&2
    exit 1
    ;;
esac
if [ "$FULL_INSTALL" = "1" ]; then
  echo "Install profile: FULL (--all) — every model family will be installed."
else
  echo "Install profile: LEAN — core deps only. Re-run with --all (or ./run_all.sh) for the heavy model families."
fi
export VITE_WITH_DJ="$WITH_DJ"
if [ "$WITH_DJ" = "1" ]; then
  echo "DJ mode: Setlist workspace will be auto-enabled at /setlist."
fi
export VITE_WITH_LOL="$WITH_LOL"
if [ "$WITH_LOL" = "1" ]; then
  echo "LOL mode: light-visualization read API enabled at /api/lol/* (private, archive-only)."
fi
echo "PyTorch install mode: $TORCH_MODE"

# ── Python interpreter ─────────────────────────────────────────────────────
# Lock in ONE binary for the whole script and export it to the vite dev
# server so the capabilities probe (vite.config.ts → serveCapabilities)
# inspects the same site-packages we install into. Without this lock,
# `pip install demucs` could land in `python -m pip`'s site dir while the
# probe ran `python3 -c "..."` against a different interpreter — the
# infamous "I installed demucs but the UI still says Demucs profile
# required" case.
# If PYTHON isn't set, prefer the project venv (~/.venv-timecues) so pip
# installs don't hit the PEP 668 "externally managed" block on Homebrew Python.
if [ -z "${PYTHON:-}" ]; then
  if [ -x "$HOME/.venv-timecues/bin/python" ]; then
    PYTHON="$HOME/.venv-timecues/bin/python"
  elif command -v python >/dev/null 2>&1; then
    PYTHON="python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
  else
    echo "ERROR: no python / python3 on PATH" >&2
    exit 1
  fi
fi
if ! command -v "$PYTHON" >/dev/null 2>&1 && [ ! -x "$PYTHON" ]; then
  echo "ERROR: PYTHON='$PYTHON' not found or not executable" >&2
  exit 1
fi
export TIMECUES_PYTHON="$(command -v "$PYTHON")"
echo "Using Python: $TIMECUES_PYTHON  ($($PYTHON --version 2>&1))"

# ── Install policy ─────────────────────────────────────────────────────────
# LEAN by default: install only the core deps (Step 1 below) so basic usage
# works with a small, fast install. The heavy model families (stems,
# All-In-One, the 8 experimental MIR sidecars) are pip-installed ONLY under
# --all / TIMECUES_FULL_INSTALL=1 (the full profile) — ~3 GB of wheels on
# first run. SKIP_MODEL_INSTALL=1 force-skips them even under --all (e.g. when
# you manage your own env or a venv that already has them).
SKIP_MODEL_INSTALL="${SKIP_MODEL_INSTALL:-0}"

# Effective switch for the heavy install block below: install the model
# families only when the full profile is on AND the user hasn't force-skipped.
INSTALL_MODELS=1
if [ "$FULL_INSTALL" != "1" ] || [ "$SKIP_MODEL_INSTALL" = "1" ]; then
  INSTALL_MODELS=0
fi

# Track which optional families succeeded so the summary at the end is
# honest about what shipped vs what fell back to "Deps missing".
INSTALL_WARNINGS=()
warn() { INSTALL_WARNINGS+=("$1"); echo "  ⚠  $1"; }

pip_install() {
  # Always use the locked Python's pip so the install lands in the same
  # site-packages the probe inspects. --upgrade-strategy only-if-needed
  # avoids accidentally bumping numpy/scipy when a feature wheel asks for
  # a looser range. We deliberately do NOT `set -e` around this — caller
  # checks the exit status so one failing feature doesn't kill all the
  # others. Build-isolation pulls clean setuptools per package, which
  # avoids the "Cannot import 'setuptools.build_meta'" failure mode some
  # older sdists hit.
  "$PYTHON" -m pip install --quiet --upgrade-strategy only-if-needed "$@"
}

try_install() {
  # Best-effort install: prints a warning + records it on failure, never
  # propagates the failure. The caller can keep going to the next step.
  local label="$1"; shift
  if pip_install "$@"; then
    echo "  $label OK."
  else
    warn "$label install failed — that family will show 'Deps missing' in the UI"
  fi
}

# ── Isolated per-family sidecar venvs ──────────────────────────────────────
# Three sidecars pin dependency sets that CANNOT coexist with the main
# interpreter, and Docker solves this by giving each its own image:
#
#   basic-pitch  tensorflow<2.15.1  — no wheels for Python 3.12+
#   autochord    keras<3 (tf<2.16)  — same wall, plus a vamp C extension
#   msaf         numpy<1.24         — imports np.int/np.float, deleted in 1.24,
#                                     while core requirements.txt needs >=1.24
#
# On bare metal we mirror that one-image-per-family split with one uv venv per
# family under .cache/. This is what lets `./run.sh --all` reach the same
# "everything Ready" state the compose stack has, with no containers.
#
# Two rules learned the hard way, both encoded below:
#
#  1. NEVER install a family as one atomic `uv pip install`. `vamp`'s sdist
#     calls numpy at build time without declaring it, so the whole transaction
#     died with "No module named numpy" and took basic-pitch down with it.
#     Each family installs in two stages: build prerequisites first, then the
#     real payload with --no-build-isolation so it can see them.
#  2. NEVER decide a venv is usable from the installer's exit code. Probe the
#     imports. A venv left healthy by an earlier run must be reused even when
#     this run skipped or partly failed its install — treating a failed
#     reinstall as "family unavailable" is exactly what silently launched these
#     sidecars on the wrong interpreter for months.
ensure_uv() {
  # uv (Astral) manages the per-family venvs and downloads its own prebuilt
  # CPython when the host lacks the version a family needs. Static binary at
  # ~/.local/bin/uv, ~30 MB, no system deps.
  if command -v uv >/dev/null 2>&1; then return 0; fi
  echo "  Installing uv (~30 MB static binary, no system deps)…"
  if curl -fLsSf https://astral.sh/uv/install.sh | sh >/tmp/uv_install.log 2>&1; then
    # The installer doesn't always touch the current shell's PATH.
    export PATH="$HOME/.local/bin:$PATH"
    command -v uv >/dev/null 2>&1 && { echo "  uv installed."; return 0; }
  fi
  warn "uv install failed — see /tmp/uv_install.log. Sidecars needing an isolated venv will report 'Deps missing'."
  return 1
}

sidecar_venv_probe() {
  # sidecar_venv_probe <venv_dir> <module,…>
  # Echoes the venv's python path iff every module imports. Silent + non-zero
  # otherwise. This is the ONLY thing that decides a family is usable.
  local dir="$1" mods="$2" py="$1/bin/python"
  [ -x "$py" ] || return 1
  "$py" -c "import ${mods}" >/dev/null 2>&1 || return 1
  echo "$py"
}

ensure_sidecar_venv() {
  # ensure_sidecar_venv <label> <venv_dir> <py_version> <probe_modules> \
  #                     --stage1 <pkgs…> --stage2 <pkgs…>
  # Echoes the venv python path on success, nothing on failure. Idempotent:
  # an already-healthy venv short-circuits without touching the network.
  local label="$1" dir="$2" pyver="$3" mods="$4"; shift 4
  local stage1=() stage2=() cur=""
  for a in "$@"; do
    case "$a" in
      --stage1) cur="1"; continue ;;
      --stage2) cur="2"; continue ;;
    esac
    if [ "$cur" = "1" ]; then stage1+=("$a"); else stage2+=("$a"); fi
  done

  local found
  if found=$(sidecar_venv_probe "$dir" "$mods"); then
    echo "$found"; return 0
  fi

  ensure_uv || return 1

  if [ ! -x "$dir/bin/python" ]; then
    echo "  Creating $dir (uv may download Python $pyver, ~50 MB)…" >&2
    if ! uv venv --python "$pyver" --seed "$dir" >"/tmp/uv_venv_${label}.log" 2>&1; then
      warn "$label: venv create failed — see /tmp/uv_venv_${label}.log"
      return 1
    fi
  fi

  # Stage 1 — build prerequisites (numpy for vamp's undeclared build dep,
  # setuptools<81 because librosa 0.9.x and autochord import pkg_resources,
  # which setuptools 81 deleted; uv seeds 84+).
  echo "  $label: installing build prerequisites…" >&2
  if ! uv pip install --python "$dir/bin/python" "${stage1[@]}" \
        >"/tmp/uv_install_${label}.log" 2>&1; then
    warn "$label: prerequisite install failed — see /tmp/uv_install_${label}.log"
    return 1
  fi

  # Stage 2 — the payload, with build isolation OFF so sdists that forgot to
  # declare numpy/Cython can see stage 1.
  echo "  $label: installing packages (one-time; uv caches for reruns)…" >&2
  if ! uv pip install --python "$dir/bin/python" --no-build-isolation "${stage2[@]}" \
        >>"/tmp/uv_install_${label}.log" 2>&1; then
    warn "$label: package install failed — see /tmp/uv_install_${label}.log"
    return 1
  fi

  if found=$(sidecar_venv_probe "$dir" "$mods"); then
    echo "$found"; return 0
  fi
  warn "$label: installed but imports still fail — see /tmp/uv_install_${label}.log"
  return 1
}

# ── Step 0: PyTorch (installed BEFORE core deps, on purpose) ────────────────
# `demucs` lives in tools/python/requirements.txt (a CORE dep) and pulls torch
# transitively. If we let the core `pip install` resolve it, pip grabs the
# DEFAULT wheels — the CUDA build, ~2.7 GB of nvidia/* libs that CPU-only hosts
# can't use and that have repeatedly filled small disks. So we install the
# variant chosen via --torch FIRST; demucs then sees torch already satisfied
# and won't drag in CUDA. This runs regardless of SKIP_MODEL_INSTALL because
# the core install (and demucs) needs torch either way.
install_torch() {
  case "$TORCH_MODE" in
    gpu)
      echo "  Installing torch + torchaudio (CUDA wheels — large: ~2.7 GB of nvidia/* libs)…"
      pip_install torch torchaudio
      ;;
    cpu)
      echo "  Installing torch + torchaudio (CPU wheels — ~200 MB, no CUDA)…"
      pip_install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
      ;;
  esac
}
if [ "$TORCH_MODE" = "none" ]; then
  echo "Skipping torch install (--torch=none). demucs/stems will use whatever"
  echo "  torch is already importable, or report 'Deps missing' if none is."
else
  echo "Checking torch ($TORCH_MODE)…"
  if "$PYTHON" -c "import torch" 2>/dev/null; then
    echo "  torch OK (already installed)."
  elif install_torch; then
    echo "  torch OK."
  else
    warn "torch ($TORCH_MODE) install failed — Stems, All-In-One, and SPAN-family detectors will show 'Deps missing'"
  fi
fi

# ── Step 1: core sidecar deps (always installed; errors here ARE fatal) ────
echo "Checking core Python dependencies..."
if "$PYTHON" -c "import mir_eval, ruptures, librosa, sklearn, soundfile" 2>/dev/null; then
  echo "  Core deps OK (already installed)."
else
  echo "  Installing core deps from tools/python/requirements.txt …"
  if ! pip_install -r tools/python/requirements.txt; then
    echo "ERROR: core dep install failed — the script cannot continue without these." >&2
    exit 1
  fi
  echo "  Core deps OK."
fi

if [ "$INSTALL_MODELS" = "0" ]; then
  if [ "$FULL_INSTALL" != "1" ]; then
    echo "Lean profile — skipping allin1 / experimental / torch installs."
    echo "  Run ./run_all.sh (or ./run.sh --all) to install every model family."
  else
    echo "SKIP_MODEL_INSTALL=1 — skipping allin1 / experimental installs."
  fi
  echo "  (torch was already handled in Step 0 above; core deps always install.)"
  echo "  (Sidecars will start, but report Deps missing for features they can't import.)"
else
  # Modern pip uses PEP-517 isolated builds — older sdists that don't
  # declare `setuptools` in build-system.requires fail with "Cannot import
  # 'setuptools.build_meta'". Pre-installing setuptools + wheel into the
  # *target* env doesn't fix isolated builds, but it does cover the few
  # packages that fall back to legacy `setup.py` paths. Cheap insurance.
  #
  # Pin setuptools<81 because version 81 DROPPED `pkg_resources` from the
  # distribution. autochord, vamp, and a few other older deps in the
  # experimental MIR set still `import pkg_resources` at module load, so
  # bumping to 81+ here cascades into `ModuleNotFoundError: pkg_resources`
  # everywhere. The pin costs nothing — 80.x ships everything 81 did
  # except the removal of the (still-deprecated) pkg_resources module.
  echo "Refreshing setuptools (<81 to keep pkg_resources) / wheel…"
  pip_install --upgrade 'setuptools<81' wheel || warn "setuptools/wheel refresh failed (not fatal — most installs use isolated builds)"

  # (torch is already handled in Step 0 above, before the core deps, so the
  # --torch=cpu|gpu|none choice is honored and demucs can't sneak in CUDA.)

  # ── Step 3: All-In-One (mir-aidj) ─────────────────────────────────────
  # `allin1`, `madmom` (git+), and `natten` (CUDA-only) install separately
  # so a failure in one doesn't kill the others. Previous attempt bundled
  # `allin1` + `madmom` into one pip call — when the madmom git clone was
  # slow/blocked, allin1 also didn't land and the All-In-One row stayed
  # grayed out with "requires `allin1`". Now each pip call has its own
  # try_install so the failure mode is per-package, not all-or-nothing.
  # ── All-In-One install (allin1 + madmom fork) ─────────────────────────
  # `allin1`, `madmom` (git+) install separately so a failure in one
  # doesn't kill the other. natten is intentionally NOT installed —
  # natten has no CPU wheels and its CUDA-only build would either fail
  # to install or pin a version that breaks `import allin1`. Instead,
  # tools/python/natten_shim.py reimplements the four legacy natten
  # functions in pure PyTorch, and both run_allin1.py (runtime) and the
  # vite capabilities probe (UI gating) apply it before `import allin1`.
  # Net result: allin1 imports + runs on bare-metal CPU hosts without
  # touching natten at all.
  echo "Checking allin1 (All-In-One model)…"
  if "$PYTHON" -c "import sys, os; sys.path.insert(0, 'tools/python'); from natten_shim import apply_natten_shim; apply_natten_shim(); import allin1" 2>/dev/null; then
    echo "  allin1 already importable (via natten_shim) — skipping install."
  else
    echo "  Installing allin1…"
    try_install "allin1" "allin1"
    echo "  Installing madmom fork (git+https://github.com/CPJKU/madmom.git)…"
    try_install "madmom" "madmom @ git+https://github.com/CPJKU/madmom.git"
  fi

  # ── Step 4: experimental MIR sidecar deps ─────────────────────────────
  # Install each package independently so one failure (e.g. basic-pitch
  # on Python 3.12+ where its TF pin is unsatisfiable, or a transient
  # network blip on openai-whisper) doesn't poison the rest of the
  # family. Previous attempt used `pip install -r requirements-
  # experimental.txt` which is atomic — one bad sdist there left every
  # detector showing "Deps missing" in Initialize Models. Now we read
  # the requirements file but install each non-comment line one-by-one.
  # JDCNet weights — the SPAN sidecar's pure-PyTorch port reads the
  # original keums/melodyExtraction_JDC Keras checkpoint via h5py. Docker
  # bakes them into /app/weights/jdcnet/ at build time; bare-metal needs
  # the same files under <repo>/.cache/jdcnet/. span_server.py looks
  # there first when /app/weights/jdcnet/ doesn't exist (the bare-metal
  # case). Without these three files JDCNet reports available=false even
  # though h5py + torch are installed.
  echo "Fetching JDCNet weights (~17 MB)…"
  mkdir -p .cache/jdcnet
  fetch_jdcnet_ok=1
  # Upstream layout is NOT flat: the checkpoint lives under weights/, but the
  # two normalization arrays sit at the repo ROOT. Map each file to its real
  # path so we don't 404 the .npy files (which a blanket weights/ prefix does).
  jdcnet_src() {
    case "$1" in
      *.hdf5) echo "weights/$1" ;;   # ResNet_joint_add_L(CE_G).hdf5 → weights/
      *)      echo "$1" ;;           # x_data_*_total_31.npy → repo root
    esac
  }
  for f in \
      "ResNet_joint_add_L(CE_G).hdf5" \
      "x_data_mean_total_31.npy" \
      "x_data_std_total_31.npy"; do
    if [ ! -s ".cache/jdcnet/$f" ]; then
      url="https://raw.githubusercontent.com/keums/melodyExtraction_JDC/master/$(jdcnet_src "$f")"
      if curl -fSL -o ".cache/jdcnet/$f" "$url" 2>/dev/null; then
        echo "  ✓ $f"
      else
        echo "  ✗ $f failed to fetch from $url"
        fetch_jdcnet_ok=0
      fi
    else
      echo "  ✓ $f (already cached)"
    fi
  done
  if [ "$fetch_jdcnet_ok" = "0" ]; then
    warn "JDCNet weights incomplete — JDCNet voicing in SPAN family will report available=false until .cache/jdcnet/ has all three files."
  fi

  echo "Installing experimental MIR sidecar deps (one package at a time)…"
  # Skip comments, blank lines, and -r/-f directives. Each remaining line
  # is a single pip install target (possibly with env-marker, e.g.
  # `basic-pitch ; python_version < "3.12"`).
  while IFS= read -r line; do
    # Strip trailing comments + whitespace; skip empty + directive lines.
    pkg=$(echo "$line" | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case "$pkg" in
      ""|-r*|-f*|--*) continue ;;
    esac
    # Use the spec verbatim as the label so the Install summary entry is
    # self-describing (e.g. `dtai-locomotif install failed`).
    label="${pkg%% *}"   # first whitespace-delimited token
    try_install "$label" "$pkg"
  done < tools/requirements-experimental.txt

  # autochord is split out because it pulls a C extension that needs the
  # system `vamp-plugin-sdk` lib. We make a best-effort attempt to apt-
  # install that lib first (silent skip on non-Debian / no-sudo hosts),
  # then install autochord from its own requirements file.
  if command -v apt-get >/dev/null 2>&1 && ! dpkg -s vamp-plugin-sdk >/dev/null 2>&1; then
    echo "  Trying to apt-install vamp-plugin-sdk (autochord prereq)…"
    sudo -n apt-get install -y -q vamp-plugin-sdk 2>/dev/null \
      && echo "  vamp-plugin-sdk OK." \
      || echo "  (vamp-plugin-sdk apt install skipped — no sudo or no apt; autochord may fail.)"
  fi
  # --no-build-isolation lets vamp's old sdist see numpy from the main env
  # (see comment in tools/requirements-autochord.txt for the gory details).
  try_install "autochord" --no-build-isolation -r tools/requirements-autochord.txt
  # autochord (and vamp) call `pkg_resources` at import time. setuptools
  # 81+ DROPPED pkg_resources entirely, and the run.sh's earlier
  # "setuptools/wheel refresh" step lands setuptools 82+ on Python 3.12+
  # hosts — so autochord's import then fails with
  # `ModuleNotFoundError: pkg_resources`. We pin setuptools<81 here as
  # a runtime constraint just for autochord's codepath. Pip's downgrade
  # logic will install an older wheel even if a newer one is already
  # present.
  if "$PYTHON" -c "import autochord" 2>/dev/null; then
    : # autochord imports cleanly — nothing to fix
  elif "$PYTHON" -c "import vamp" 2>/dev/null && ! "$PYTHON" -c "import pkg_resources" 2>/dev/null; then
    echo "  autochord can't import pkg_resources — downgrading setuptools to <81 (last release that still ships it)…"
    pip_install 'setuptools<81' && echo "  setuptools<81 OK." || warn "setuptools<81 install failed — autochord will keep raising ModuleNotFoundError: pkg_resources"
  fi

  # ── Step 4a: sidecars that need their own interpreter ─────────────────
  # basic-pitch pins tensorflow<2.15.1 and autochord's bundled BiLSTM-CRF
  # model is only loadable by keras<3 (i.e. tensorflow<2.16). Neither
  # TF<2.16 NOR TF<2.15 has wheels for Python 3.12+, so bare-metal hosts
  # on modern Python literally CAN'T install them in the main interpreter.
  # tensorflow~=2.14.x satisfies BOTH constraints, so one 3.11 venv serves
  # both sidecars. On a host already running 3.11 or older the main
  # interpreter can take them (the env marker in requirements-experimental
  # allows it), and the probe below simply finds them there.
  VENV_PY311_CUE_PY=""
  py_minor=$("$PYTHON" -c "import sys; print(sys.version_info[1])")
  if [ "$py_minor" -ge 12 ]; then
    echo ""
    echo "Python 3.${py_minor} detected — basic-pitch + autochord need Python 3.11."
    VENV_PY311_CUE_PY=$(ensure_sidecar_venv "py311-cue" ".cache/py311-cue" "3.11" \
      "basic_pitch, autochord" \
      --stage1 "numpy" "setuptools<81" "wheel" "Cython" \
      --stage2 "setuptools<81" "tensorflow~=2.14.0" "librosa>=0.10.0" \
               "soundfile>=0.12.0" "audioread>=3.0.0" "basic-pitch[onnx]" "autochord")
    [ -n "$VENV_PY311_CUE_PY" ] && echo "  basic-pitch + autochord ready on $VENV_PY311_CUE_PY"
    export VENV_PY311_CUE_PY
  fi

  # ── Step 4a-2: MSAF — always its own venv, on every host ──────────────
  # MSAF (last released 2020) imports np.int / np.float, removed in numpy
  # 1.24, while tools/python/requirements.txt needs numpy>=1.24. So unlike
  # the two above this is NOT a "modern Python" problem that older hosts
  # escape — the conflict is with our OWN core pins, so msaf can never live
  # in the main interpreter on ANY host. Prod solves it the same way, with a
  # standalone container (docker/msaf.Dockerfile); these pins mirror that
  # image exactly so bare metal and Docker run identical versions.
  VENV_MSAF_PY=$(ensure_sidecar_venv "msaf" ".cache/msaf-venv" "3.10" \
    "msaf" \
    --stage1 "numpy>=1.20,<1.24" "setuptools<81" "wheel" "Cython>=0.29" \
    --stage2 "scipy>=1.7,<1.11" "soundfile>=0.10.0" "audioread>=3.0.0" \
             "librosa>=0.9.0,<0.10.0" "scikit-learn>=1.0,<1.3" "msaf>=0.1.80")
  [ -n "$VENV_MSAF_PY" ] && echo "  MSAF ready on $VENV_MSAF_PY"
  export VENV_MSAF_PY

  # ── Step 4b: DJ-specific deps (only with --with-dj) ───────────────────
  # Reserved slot. The Setlist v0 needs nothing extra — it reads cached BPM
  # via the existing bpm_server. Heavier scorers (Schreiber key CNN,
  # Park chord transformer, MERT embeddings for vibe-matching) will plug in
  # here as they land. Keeping the guard now so the future install lines
  # don't change the public CLI surface.
  if [ "$WITH_DJ" = "1" ]; then
    echo "Installing DJ-specific deps… (none yet for Setlist v0 — slot reserved)"
  fi

  # ── Step 5: prewarm heavy imports ─────────────────────────────────────
  # Cold-importing torch / allin1 / demucs takes 10-30 s the first time
  # the interpreter pays the JIT cost. The vite capabilities probe has a
  # 90 s ceiling (was 45 s before); if it fires before any other process
  # has warmed the cache it may still flirt with the bound. We warm here
  # (fast: 1-2 s on a warm cache, 20-30 s cold) so the probe — and the
  # first per-song run — start from a hot bytecode cache.
  echo "Prewarming model imports (one-time cost; subsequent probes are instant)…"
  "$PYTHON" -c "import torch, demucs, allin1" 2>/dev/null \
    && echo "  Prewarm OK." \
    || echo "  Prewarm skipped (one or more modules missing — sidecars degrade gracefully)."

  # ── Step 6: import probe — print a Ready/Missing table for every model
  # the UI surfaces. This runs AFTER the try_install pass so the user can
  # see exactly which sidecars will work and which will say "Deps missing"
  # without having to open the Initialize Models panel. The probe runs in
  # the locked Python so the answers match what the vite capabilities
  # endpoint and the sidecars themselves will see at request time.
  echo ""
  echo "─── Model import probe ────────────────────────────────────────────"
  "$PYTHON" << 'PY'
# Each row is (label, ui_section, import statement, expected_skip_if).
# `expected_skip_if` returns True when this row is *deliberately* skipped
# on the current host — we print it under "Skipped (by design)" rather
# than "Missing", so the user can tell genuine breakage from an
# intentional gate.
import importlib, sys, os
PY_MINOR = sys.version_info[1]

# Apply the natten compatibility shim before testing allin1. Without it,
# `import allin1` fails when natten isn't installed (CPU-only hosts) OR
# when natten ≥ 0.17 stripped the legacy API. The shim makes allin1
# importable AND functional — run_allin1.py uses the same shim at run
# time, so this probe's "Ready" verdict matches the actual run path.
sys.path.insert(0, os.path.join(os.getcwd(), 'tools', 'python'))
try:
    from natten_shim import apply_natten_shim
    apply_natten_shim()
except Exception:
    pass

# basic-pitch + autochord live in a separate Python 3.11 venv when the
# host interpreter is 3.12+ (their TF pins block bare-metal install on
# 3.12). The probe checks importability INSIDE that venv via a subprocess
# rather than `importlib.import_module` in this main-interpreter session.
VENV_PY   = os.environ.get("VENV_PY311_CUE_PY", "")
VENV_MSAF = os.environ.get("VENV_MSAF_PY", "")

def _check_in_venv(module: str, venv_py: str) -> tuple[bool, str]:
    """Return (ok, note). False+note means import failed; note is the
    exception message or "venv not available"."""
    import subprocess
    VENV_PY = venv_py
    if not VENV_PY or not os.path.exists(VENV_PY):
        return (False, "venv not configured")
    code = (
        "import importlib, sys\n"
        f"try:\n  importlib.import_module({module!r}); print('OK')\n"
        "except Exception as e:\n  print(f'{type(e).__name__}: {e}'); sys.exit(1)\n"
    )
    try:
        r = subprocess.run([VENV_PY, "-c", code], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            return (True, "Ready (venv)")
        return (False, (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr) else f"exit {r.returncode}")
    except Exception as e:
        return (False, f"subprocess failed: {e}")

ROWS = [
    ("torch",              "All-In-One / SPAN / stems",   "torch",             lambda: False),
    ("demucs",             "Stems",                       "demucs",            lambda: False),
    ("allin1",             "All-In-One",                  "allin1",            lambda: False),
    ("silero-vad (torch.hub at first use)", "SPAN",       None,                lambda: False),
    # JDCNet needs h5py (importable) + the .hdf5 + 2 .npy weight files
    # on disk. The Docker SPAN image bakes them at /app/weights/jdcnet/;
    # bare-metal run.sh fetches them into .cache/jdcnet/. We treat the
    # weight-files-missing case as a normal Missing row so the user knows
    # to retry the fetch — h5py alone is misleading "Ready".
    ("JDCNet (h5py + .hdf5 weights)", "SPAN",              "h5py",              lambda: False),
    ("panns_inference",    "SPAN (PANNs CNN14)",          "panns_inference",   lambda: False),
    ("BeatNet",            "CUE (beats/downbeats/meter)", "BeatNet",           lambda: False),
    # basic-pitch + autochord live in the .cache/py311-cue/ venv when
    # PY_MINOR >= 12. The probe checks the venv via subprocess so the
    # table reflects the actual sidecar runtime, not the host.
    ("basic_pitch",        "CUE (note onsets)",           "basic_pitch",       lambda: False),
    ("autochord",          "CUE extras",                  "autochord",         lambda: False),
    ("openai-whisper",     "LYRICS (Whisper-base)",       "whisper",           lambda: False),
    ("ctc-forced-aligner", "LYRICS (forced aligner)",     "ctc_forced_aligner", lambda: False),
    ("dtai-locomotif",     "PATTERN (LoCoMotif)",         "locomotif.locomotif", lambda: False),
    # msaf always lives in .cache/msaf-venv/ — its numpy<1.24 pin conflicts
    # with core requirements.txt on EVERY host, not just modern ones.
    ("msaf",               "Boundaries (sf/foote/cnmf/olda)", "msaf",          lambda: False),
]
# Which rows an isolated venv serves, and which one. Everything else stays on
# the host interpreter. `always` marks a family whose pins conflict with our
# own core requirements, so it is venv-served on every host regardless of the
# host Python version.
VENV_SERVED = {
    "basic_pitch": (VENV_PY,   ".cache/py311-cue/",  False),
    "autochord":   (VENV_PY,   ".cache/py311-cue/",  False),
    "msaf":        (VENV_MSAF, ".cache/msaf-venv/",  True),
}
ok, miss, skipped = [], [], []
for label, section, mod, expected_skip in ROWS:
    if mod is None:
        ok.append((label, section, "(lazy)")); continue
    # Route pin-conflicted packages through their own venv.
    if mod in VENV_SERVED:
        venv_py, venv_dir, always = VENV_SERVED[mod]
        if always or PY_MINOR >= 12:
            if venv_py and os.path.exists(venv_py):
                success, note = _check_in_venv(mod, venv_py)
                if success:
                    ok.append((label, section, note))
                else:
                    miss.append((label, section, note))
            else:
                miss.append((label, section, f"no {venv_dir} venv — re-run ./run.sh --all to build it"))
            continue
    try:
        importlib.import_module(mod)
        # Special-case JDCNet: h5py importable isn't enough; the weight
        # files must exist on disk too. Probe the same paths
        # span_server._JDCNET_OK does so the table matches what the
        # sidecar reports at /api/span/algorithms.
        if "JDCNet" in label:
            from pathlib import Path
            docker_dir = Path("/app/weights/jdcnet")
            local_dir  = Path(".cache/jdcnet")
            weights_dir = docker_dir if docker_dir.exists() else local_dir
            need = ["ResNet_joint_add_L(CE_G).hdf5", "x_data_mean_total_31.npy", "x_data_std_total_31.npy"]
            present = [f for f in need if (weights_dir / f).exists()]
            if len(present) < len(need):
                missing_files = [f for f in need if f not in present]
                miss.append((label, section, f"weight files missing: {', '.join(missing_files)} (expected under {weights_dir}/)"))
                continue
        ok.append((label, section, "Ready"))
    except Exception as e:
        if expected_skip():
            skipped.append((label, section, f"intentionally skipped on Python 3.{PY_MINOR}"))
        else:
            miss.append((label, section, f"{type(e).__name__}: {e}"))

if ok:
    print("  Ready:")
    for label, section, note in ok:
        print(f"    ✓ {label:35s} {section:30s} {note}")
if skipped:
    print("  Skipped (by design — not a failure):")
    for label, section, note in skipped:
        print(f"    – {label:35s} {section:30s} {note}")
if miss:
    print("  Missing (will show 'Deps missing' in the UI):")
    for label, section, note in miss:
        print(f"    ✗ {label:35s} {section:30s} {note}")
print(f"\n  Summary: {len(ok)} Ready, {len(skipped)} Skipped, {len(miss)} Missing")
PY
  echo "──────────────────────────────────────────────────────────────────"

  if [ ${#INSTALL_WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo "─── Install summary ────────────────────────────────────────────────"
    echo "Some optional installs didn't land. The sidecars will still start;"
    echo "the corresponding UI surfaces will show 'Deps missing' until you"
    echo "resolve the issues below. The simplest path is usually to re-run"
    echo "the matching pip line by hand and watch the actual error:"
    for w in "${INSTALL_WARNINGS[@]}"; do echo "  • $w"; done
    echo "────────────────────────────────────────────────────────────────────"
    echo ""
  fi
fi

# ── Reuse sidecar venvs built by an earlier --all run ──────────────────────
# The install steps above only run under --all. A LEAN rerun must still find
# the venvs a previous full run left behind, otherwise msaf / basic-pitch /
# autochord would launch on the main interpreter and report "Deps missing"
# even though they are installed and one flag built them correctly. The probe
# is a couple of imports, so this costs nothing on the lean path.
if [ -z "${VENV_PY311_CUE_PY:-}" ]; then
  VENV_PY311_CUE_PY=$(sidecar_venv_probe ".cache/py311-cue" "basic_pitch, autochord" || true)
  export VENV_PY311_CUE_PY
fi
if [ -z "${VENV_MSAF_PY:-}" ]; then
  VENV_MSAF_PY=$(sidecar_venv_probe ".cache/msaf-venv" "msaf" || true)
  export VENV_MSAF_PY
fi

# ── Seed algorithm cache from data-default ─────────────────────────────────
# Ship pre-computed BPM / MIR / MSAF / ruptures / allin1 results for the
# default demo songs so a fresh clone shows everything instantly without
# waiting on heavy first-run inference. cp -rn never clobbers a file the
# user already produced in data/algorithm-outputs/.
if [ -d data-default/algorithm-outputs ]; then
  mkdir -p data/algorithm-outputs
  cp -rn data-default/algorithm-outputs/. data/algorithm-outputs/ 2>/dev/null || true
fi

# ── helper: kill anything on a port, start a python server, verify it's up ──
# Fifth optional arg `py_override` lets caller force a different Python
# binary — used for the .cache/py311-cue/ venv that runs basic-pitch +
# autochord on Python 3.11 while the rest of the stack uses the host
# interpreter on 3.12+.
# ── Output styling ─────────────────────────────────────────────────────────
# Colors only when stdout is a real terminal (so piped/CI logs stay clean).
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_ERR=''; C_WARN=''; C_DIM=''; C_BOLD=''; C_OFF=''
fi

# Tallies for the end-of-launch summary.
SERVER_TOTAL=0
SERVER_FAILURES=()

start_python_server() {
  local name="$1" script="$2" port="$3" log="$4"
  local py_bin="${5:-$PYTHON}"
  local label="${name% server}"   # "MSAF server" -> "MSAF" (header says "servers")
  SERVER_TOTAL=$((SERVER_TOTAL + 1))

  # Kill anything already holding the port (race-guard; the pre-flight check
  # already freed it on the same-ports path).
  free_port "$port"

  nohup "$py_bin" "$script" > "$log" 2>&1 &
  local pid=$!

  # Wait up to 5 s for the port to accept a connection.
  local i=0
  while [ $i -lt 10 ]; do
    sleep 0.5
    if (echo > /dev/tcp/localhost/"$port") 2>/dev/null; then
      printf '  %s✓%s  %-12s %s:%-4s%s  pid %s\n' \
        "$C_OK" "$C_OFF" "$label" "$C_DIM" "$port" "$C_OFF" "$pid"
      return 0
    fi
    i=$((i + 1))
  done

  printf '  %s✗%s  %-12s %s:%-4s%s  %sfailed to start within 5s — logs: %s%s\n' \
    "$C_ERR" "$C_OFF" "$label" "$C_DIM" "$port" "$C_OFF" "$C_ERR" "$log" "$C_OFF"
  SERVER_FAILURES+=("$label (:$port) — last lines of $log:")
  while IFS= read -r ln; do SERVER_FAILURES+=("      $ln"); done < <(tail -3 "$log" 2>/dev/null)
}

# ── Pre-flight: are any ports we need already in use? ──────────────────────
# Every Python sidecar's start_python_server kills whatever holds its port,
# and Vite runs with --strictPort (it crashes rather than hopping). Neither
# is what you want when a previous ./run.sh (or the Docker stack) is still
# up: don't silently kill someone else's process, and don't quietly relaunch
# on a different port. Ask once, up front — kill-and-relaunch on the SAME
# ports, or abort. Set TIMECUES_KILL_PORTS=1 to skip the prompt (CI / repeat
# dev loops); leave it unset for the interactive ask.
VITE_PORT="${VITE_PORT:-5174}"
REQUIRED_PORTS="8001 8002 8003 8004 8005 8006 8008 8009 8010 8011 8013 8014 8015 8016 8017 $VITE_PORT"

port_listeners() {
  # Space-separated PIDs LISTENing on the given TCP port (empty if free).
  # lsof covers macOS + most Linux; ss is the modern-Linux fallback where
  # lsof isn't installed. (Windows/Git-Bash has neither — ports read as
  # free and the server bind fails loudly if one is actually taken.)
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${1}" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' '
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnpH "sport = :${1}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' '
  fi
}

free_port() {
  # Kill whatever is LISTENing on the given TCP port. Prefer lsof (works on
  # macOS + Linux); fall back to fuser only where lsof is absent. NOTE: BSD
  # (macOS) fuser has no -k flag and prints its usage to *stdout*, so it's
  # both useless and noisy here — hence lsof first, fuser fully silenced.
  local p="$1" pids
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:${p}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null || true
    fi
  else
    fuser -k "${p}/tcp" >/dev/null 2>&1 || true
  fi
  return 0
}

busy_ports=""
busy_report=""
for p in $REQUIRED_PORTS; do
  pids="$(port_listeners "$p")"
  if [ -n "$pids" ]; then
    busy_ports="$busy_ports $p"
    busy_report="${busy_report}    port ${p}: PID(s) ${pids}
"
  fi
done

if [ -n "$busy_ports" ]; then
  echo
  echo "${C_WARN}⚠  Some ports ./run.sh needs are already in use${C_OFF}"
  echo "${C_DIM}   (most likely a previous ./run.sh is still running):${C_OFF}"
  printf '%s' "$busy_report"
  echo
  if [ -n "${TIMECUES_KILL_PORTS:-}" ]; then
    echo "${C_DIM}TIMECUES_KILL_PORTS set — killing those process(es) and relaunching on the same ports.${C_OFF}"
    port_action="kill"
  elif [ -r /dev/tty ]; then
    printf "${C_BOLD}Kill them and relaunch on the same ports?${C_OFF} [${C_BOLD}k${C_OFF} = kill & relaunch / ${C_BOLD}a${C_OFF} = abort] "
    read -r reply </dev/tty || reply=""
    case "$reply" in
      k|K|kill|y|Y|yes) port_action="kill" ;;
      *)                port_action="abort" ;;
    esac
  else
    echo "${C_ERR}Non-interactive shell and TIMECUES_KILL_PORTS is unset — aborting.${C_OFF}"
    echo "Re-run with TIMECUES_KILL_PORTS=1 to kill and relaunch automatically."
    exit 1
  fi

  if [ "$port_action" = "kill" ]; then
    for p in $busy_ports; do
      free_port "$p"
    done
    echo "${C_OK}✓  Freed ports:${busy_ports}${C_OFF} — continuing on the same ports."
  else
    echo "${C_ERR}Aborted${C_OFF} — left the existing services running. Free the ports (or stop the other ./run.sh) and try again."
    exit 1
  fi
fi

echo
echo "${C_BOLD}─── Starting model servers ─────────────────────────────────────────${C_OFF}"
echo "${C_DIM}    (each starts even if its model dep is missing — the UI then shows${C_OFF}"
echo "${C_DIM}     'Deps missing' for that family; ✗ below means the process itself${C_OFF}"
echo "${C_DIM}     didn't come up, see its log)${C_OFF}"
start_python_server "mir_eval server"  tools/python/mir_eval_server.py  8001 /tmp/mir_eval_server.log
start_python_server "MSAF server"      tools/python/msaf_server.py      8002 /tmp/msaf_server.log  "${VENV_MSAF_PY:-$PYTHON}"
start_python_server "DSP server"       tools/python/dsp_server.py       8003 /tmp/dsp_server.log
start_python_server "BPM server"       tools/python/bpm_server.py       8004 /tmp/bpm_server.log
start_python_server "Custom server"    tools/python/custom_server.py    8005 /tmp/custom_server.log
start_python_server "Stems server"     tools/python/stems_server.py     8006 /tmp/stems_server.log

# ── Experimental MIR sidecars (8008-8017) ──────────────────────────────────
# Every server's heavy imports are guarded by try/except, so the process
# starts even if its model dep is missing — the server reports
# available=false through /api/<family>/health and the UI surfaces "Deps
# missing" in Settings → Experimental annotation types & models →
# Initialize models. With the default install policy above all deps land
# at startup so every row reads "Ready" on first refresh.
start_python_server "Beat This! server"  tools/python/beat_this_server.py   8008 /tmp/beat_this_server.log
start_python_server "Span server"        tools/python/span_server.py        8009 /tmp/span_server.log
start_python_server "BeatNet server"     tools/python/beatnet_server.py     8010 /tmp/beatnet_server.log
start_python_server "Beat Transf. server" tools/python/beat_transformer_server.py 8018 /tmp/beat_transformer_server.log
# Pitch + Cue-extras run from the uv-managed Python 3.11 venv when the
# host interpreter is 3.12+ (where basic-pitch + autochord won't install
# because their TF pins have no 3.12 wheels). VENV_PY311_CUE_PY points
# at .cache/py311-cue/bin/python after Step 4a above sets it up; empty
# string means "use the main interpreter". start_python_server's 5th
# arg accepts that override.
start_python_server "Pitch server"       tools/python/pitch_server.py       8011 /tmp/pitch_server.log       "${VENV_PY311_CUE_PY:-$PYTHON}"
start_python_server "PANNs server"       tools/python/panns_server.py       8013 /tmp/panns_server.log
start_python_server "Cue-extras server"  tools/python/cue_extras_server.py  8014 /tmp/cue_extras_server.log  "${VENV_PY311_CUE_PY:-$PYTHON}"
start_python_server "Percussive server"  tools/python/percussive_server.py  8015 /tmp/percussive_server.log
start_python_server "Lyrics server"      tools/python/lyrics_server.py      8016 /tmp/lyrics_server.log
start_python_server "Pattern server"     tools/python/pattern_server.py     8017 /tmp/pattern_server.log

# ── Model-server launch summary ────────────────────────────────────────────
echo
if [ ${#SERVER_FAILURES[@]} -eq 0 ]; then
  echo "${C_OK}✓  All ${SERVER_TOTAL} model servers are up.${C_OFF}"
else
  ok=$((SERVER_TOTAL - $( printf '%s\n' "${SERVER_FAILURES[@]}" | grep -c ' — last lines of ' )))
  echo "${C_WARN}⚠  ${ok}/${SERVER_TOTAL} model servers up — the rest failed to start:${C_OFF}"
  printf '   %s\n' "${SERVER_FAILURES[@]}"
  echo "${C_DIM}   The app still runs; detectors from a failed server are unavailable.${C_OFF}"
fi

# ── Vite dev server ────────────────────────────────────────────────────────
cd web-app

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

# Dev Vite port. Defaults to 5174 (NOT Vite's usual 5173) on purpose: a
# local Docker stack publishes 5173, so the dev server would collide with
# it. 5174 keeps `./run.sh` and the container side by side. Override with
# VITE_PORT=... if 5174 is also taken. --strictPort makes Vite fail loudly
# instead of silently hopping to the next free port, so the URL is stable.
VITE_PORT="${VITE_PORT:-5174}"
echo
echo "${C_BOLD}─── Starting the app ───────────────────────────────────────────────${C_OFF}"
echo "  Open ${C_BOLD}http://localhost:${VITE_PORT}/${C_OFF}  ${C_DIM}(5173 is left free for the Docker stack)${C_OFF}"
echo "  ${C_DIM}Ctrl-C here stops the dev server; the model servers keep running in the background.${C_OFF}"

# TIMECUES_PYTHON propagates to the dev server so its /api/capabilities
# probe inspects the exact same interpreter we installed into above.
npm run dev -- --port "$VITE_PORT" --strictPort
