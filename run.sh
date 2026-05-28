#!/bin/bash
set -e

cd "$(dirname "$0")"

# ── Python interpreter ─────────────────────────────────────────────────────
# Lock in ONE binary for the whole script and export it to the vite dev
# server so the capabilities probe (vite.config.ts → serveCapabilities)
# inspects the same site-packages we install into. Without this lock,
# `pip install demucs` could land in `python -m pip`'s site dir while the
# probe ran `python3 -c "..."` against a different interpreter — the
# infamous "I installed demucs but the UI still says Demucs profile
# required" case.
PYTHON="${PYTHON:-python}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  PYTHON="python3"
fi
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: no python / python3 on PATH" >&2
  exit 1
fi
export TIMECUES_PYTHON="$(command -v "$PYTHON")"
echo "Using Python: $TIMECUES_PYTHON  ($($PYTHON --version 2>&1))"

# ── Install policy ─────────────────────────────────────────────────────────
# Default is to pip-install every model dep so all features work out of the
# box (stems, All-In-One, the 8 experimental MIR sidecars). Heavy: ~3 GB of
# wheels on first run. Opt out with `SKIP_MODEL_INSTALL=1 ./run.sh` if you
# manage your own env or run against a venv that already has them.
SKIP_MODEL_INSTALL="${SKIP_MODEL_INSTALL:-0}"

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

if [ "$SKIP_MODEL_INSTALL" = "1" ]; then
  echo "SKIP_MODEL_INSTALL=1 — skipping torch / allin1 / experimental installs."
  echo "  (Sidecars will start, but report Deps missing for features they can't import.)"
else
  # Modern pip uses PEP-517 isolated builds — older sdists that don't
  # declare `setuptools` in build-system.requires fail with "Cannot import
  # 'setuptools.build_meta'". Pre-installing setuptools + wheel into the
  # *target* env doesn't fix isolated builds, but it does cover the few
  # packages that fall back to legacy `setup.py` paths. Cheap insurance.
  echo "Refreshing setuptools / wheel (build prerequisites)…"
  pip_install --upgrade setuptools wheel || warn "setuptools/wheel refresh failed (not fatal — most installs use isolated builds)"

  # ── Step 2: torch CPU wheels (shared by stems, allin1, span family) ──
  # CUDA wheels are gated behind a separate path — most laptops can't use
  # them anyway. If torch is already importable we skip; otherwise we pull
  # the explicit CPU index URL so we don't accidentally land the CUDA build.
  echo "Checking torch (CPU)…"
  if "$PYTHON" -c "import torch" 2>/dev/null; then
    echo "  torch OK (already installed)."
  else
    echo "  Installing torch + torchaudio (CPU wheels — ~200 MB)…"
    if pip_install torch torchaudio --index-url https://download.pytorch.org/whl/cpu; then
      echo "  torch OK."
    else
      warn "torch install failed — Stems, All-In-One, and SPAN-family detectors will show 'Deps missing'"
    fi
  fi

  # ── Step 3: All-In-One (mir-aidj) ─────────────────────────────────────
  # `natten` (in requirements-allin1.txt) ships pre-built CUDA wheels from
  # shi-labs.com — on macOS / non-CUDA Linux it errors out and would take
  # the whole `pip install -r requirements-allin1.txt` line with it. We
  # split it into pieces so allin1 itself still lands even when natten
  # can't. allin1 imports natten lazily so the import works fine without.
  echo "Checking allin1 (All-In-One model)…"
  if "$PYTHON" -c "import allin1" 2>/dev/null; then
    echo "  allin1 OK (already installed)."
  else
    echo "  Installing allin1 + madmom fork…"
    if pip_install \
        "allin1" \
        "madmom @ git+https://github.com/CPJKU/madmom.git"; then
      echo "  allin1 OK."
    else
      warn "allin1 install failed — All-In-One row will show 'requires allin1'"
    fi
    echo "  Trying natten (CUDA-only wheel; skipped on CPU-only / macOS hosts)…"
    pip_install --find-links https://shi-labs.com/natten/wheels/ natten 2>/dev/null \
      && echo "  natten OK." \
      || echo "  (natten unavailable for this host — All-In-One still runs without it.)"
  fi

  # ── Step 4: experimental MIR sidecar deps ─────────────────────────────
  # Package list lives in tools/requirements-experimental.txt (env markers
  # in that file handle Python-version gating, e.g. basic-pitch is skipped
  # on Python 3.12+ where its TF pin is unsatisfiable). One bad sdist
  # there *would* still poison the rest, but the file is curated to only
  # contain installs we expect to succeed on a clean host.
  echo "Installing experimental MIR sidecar deps…"
  try_install "experimental MIR deps" -r tools/requirements-experimental.txt

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

  if [ ${#INSTALL_WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo "─── Install summary ────────────────────────────────────────────────"
    echo "Some optional installs didn't land. The sidecars will still start;"
    echo "the corresponding UI surfaces will show 'Deps missing' until you"
    echo "resolve the issues below:"
    for w in "${INSTALL_WARNINGS[@]}"; do echo "  • $w"; done
    echo "────────────────────────────────────────────────────────────────────"
    echo ""
  fi
fi

# ── helper: kill anything on a port, start a python server, verify it's up ──
start_python_server() {
  local name="$1" script="$2" port="$3" log="$4"

  echo "Starting $name on port $port..."

  # Kill anything already holding the port
  fuser -k "${port}/tcp" 2>/dev/null || lsof -ti "tcp:${port}" | xargs kill -9 2>/dev/null || true

  nohup "$PYTHON" "$script" > "$log" 2>&1 &
  local pid=$!

  # Wait up to 5 s for the port to open
  local i=0
  while [ $i -lt 10 ]; do
    sleep 0.5
    if (echo > /dev/tcp/localhost/"$port") 2>/dev/null; then
      echo "  $name started (PID $pid) — port $port open. Logs: $log"
      return 0
    fi
    i=$((i + 1))
  done

  echo "  WARNING: $name (PID $pid) may not be listening on port $port after 5 s."
  echo "  Check logs: $log"
  tail -5 "$log" | sed 's/^/    /'
}

start_python_server "mir_eval server"  tools/python/mir_eval_server.py  8001 /tmp/mir_eval_server.log
start_python_server "MSAF server"      tools/python/msaf_server.py      8002 /tmp/msaf_server.log
start_python_server "Ruptures server"  tools/python/ruptures_server.py  8003 /tmp/ruptures_server.log
start_python_server "BPM server"       tools/python/bpm_server.py       8004 /tmp/bpm_server.log
start_python_server "Custom server"    tools/python/custom_server.py    8005 /tmp/custom_server.log
start_python_server "Stems server"     tools/python/stems_server.py     8006 /tmp/stems_server.log
start_python_server "MIR server"       tools/python/mir_server.py       8007 /tmp/mir_server.log

# ── Experimental MIR sidecars (8009-8016) ──────────────────────────────────
# Every server's heavy imports are guarded by try/except, so the process
# starts even if its model dep is missing — the server reports
# available=false through /api/<family>/health and the UI surfaces "Deps
# missing" in Settings → Experimental annotation types & models →
# Initialize models. With the default install policy above all deps land
# at startup so every row reads "Ready" on first refresh.
start_python_server "Span server"        tools/python/span_server.py        8009 /tmp/span_server.log
start_python_server "BeatNet server"     tools/python/beatnet_server.py     8010 /tmp/beatnet_server.log
start_python_server "Pitch server"       tools/python/pitch_server.py       8011 /tmp/pitch_server.log
start_python_server "Loop server"        tools/python/loop_server.py        8012 /tmp/loop_server.log
start_python_server "PANNs server"       tools/python/panns_server.py       8013 /tmp/panns_server.log
start_python_server "Cue-extras server"  tools/python/cue_extras_server.py  8014 /tmp/cue_extras_server.log
start_python_server "Percussive server"  tools/python/percussive_server.py  8015 /tmp/percussive_server.log
start_python_server "Lyrics server"      tools/python/lyrics_server.py      8016 /tmp/lyrics_server.log

# ── Vite dev server ────────────────────────────────────────────────────────
cd web-app

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

# TIMECUES_PYTHON propagates to the dev server so its /api/capabilities
# probe inspects the exact same interpreter we installed into above.
npm run dev
