#!/usr/bin/env python3
"""Batch-run the curated-output generators across the corpus.

The five curated end-products (see tools/python/generators/) are produced
here in one place, the way run_demucs_songs.py / run_allin1_batch.py drive
their respective pipelines.

Usage
-----
  # one family, one song
  python tools/run_generators.py --family phrases --slug pantheon

  # one family, whole corpus
  python tools/run_generators.py --family phrases

  # every family that can run for a song (skips families whose inputs
  # aren't on disk yet, reporting them rather than failing)
  python tools/run_generators.py --slug pantheon --all

  # everything, whole corpus
  python tools/run_generators.py --all

Families: phrases, instruments, cues, drum-pattern, lyrics.

Each family consumes different upstream caches/models:
  phrases       allin1.json                       (cheap, no model)
  instruments   Demucs stems + PANNs + Silero-VAD (heavy; needs --all stack)
  cues          energy/tension + drop/buildup     (audio; librosa)
  drum-pattern  drums stem + LoCoMotif pattern     (stems + numba)
  lyrics        vocals stem + Whisper + aligner    (heavy; needs --all stack)

A family whose generator module isn't implemented yet, or whose inputs are
missing, is reported as 'skipped' — the run never aborts mid-corpus.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path

# tools/python is where the generators package + paths live.
_PY_DIR = Path(__file__).resolve().parent / "python"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from generators.common import FAMILY_KINDS, write_envelope  # noqa: E402
from paths import list_song_slugs  # noqa: E402

# Map family → "generators.<module>" providing a generate(slug) -> envelope.
# Modules not yet implemented simply fail to import and are reported as skipped.
_FAMILY_MODULE = {
    "phrases": "generators.phrases",
    "instruments": "generators.instruments",
    "cues": "generators.cues",
    "drum-pattern": "generators.drum_pattern",
    "lyrics": "generators.lyrics",
}


def _run_one(family: str, slug: str) -> str:
    """Run `family` for `slug`. Returns a one-line status string."""
    mod_name = _FAMILY_MODULE[family]
    try:
        mod = importlib.import_module(mod_name)
    except Exception as exc:
        return f"  {family:<13} {slug:<20} SKIPPED (module not ready: {exc})"

    try:
        env = mod.generate(slug)
    except Exception as exc:  # a generator bug must not kill the whole corpus
        return f"  {family:<13} {slug:<20} ERROR ({type(exc).__name__}: {exc})"

    if env.get("fatal"):
        msg = env["fatal"].get("message", "")
        return f"  {family:<13} {slug:<20} SKIPPED ({msg.splitlines()[0] if msg else 'no inputs'})"

    write_envelope(env)
    st = env["stats"]
    return f"  {family:<13} {slug:<20} ok  accepted={st['accepted']} rejected={st['rejected']}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--family", choices=sorted(FAMILY_KINDS), help="single family to run")
    ap.add_argument("--slug", help="single song slug (default: whole corpus)")
    ap.add_argument("--all", action="store_true", help="run every family (ignores --family)")
    args = ap.parse_args()

    if not args.all and not args.family:
        ap.error("pass --family <name> or --all")

    families = sorted(FAMILY_KINDS) if args.all else [args.family]
    slugs = [args.slug] if args.slug else list_song_slugs()
    if not slugs:
        print("no songs found under data/songs or data-default/songs", file=sys.stderr)
        return 1

    print(f"families={families}  songs={len(slugs)}")
    for slug in slugs:
        for family in families:
            print(_run_one(family, slug))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
