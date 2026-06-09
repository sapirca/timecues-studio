#!/bin/bash
# run_all.sh — full-fat launcher.
#
# Installs EVERY model family (torch, Demucs, All-In-One, the experimental MIR
# sidecars, and the Python-3.11 venv for basic-pitch + autochord) so every
# feature in the UI works out of the box. Heavy: ~3 GB of wheels on first run.
#
# For lightweight / basic usage — boundary annotation + evaluation with the
# core detectors — use ./run.sh instead; it installs only the core deps.
#
# This is a thin wrapper: it just turns on the full-install profile and hands
# off to run.sh, so server startup and the Vite dev server have a SINGLE source
# of truth. Any flags you pass are forwarded (e.g. ./run_all.sh --gpu --with_dj).
set -e
cd "$(dirname "$0")"
exec ./run.sh --all "$@"
