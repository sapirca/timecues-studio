#!/usr/bin/env python3
"""
analyze_bpm.py
Computes BPM and beat times for every track in manifest.json using librosa,
then writes data/algorithm-outputs/analysis/{id}/bpm.json.

Usage:
    python scripts/analyze_bpm.py [--force]

Options:
    --force    Recompute even if bpm.json already exists
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import librosa
    import numpy as np
except ImportError:
    print("librosa and numpy are required: pip install librosa numpy")
    sys.exit(1)

# Paths (relative to script location)
SCRIPT_DIR  = Path(__file__).parent
ROOT        = SCRIPT_DIR.parent
REPO_ROOT   = ROOT.parent

sys.path.insert(0, str(REPO_ROOT / "tools" / "python"))
from paths import SONGS_DIR, ANALYSIS_DIR  # noqa: E402

MANIFEST    = ANALYSIS_DIR / "manifest.json"


def find_audio(filename: str) -> Path | None:
    """Locate audio file in songs/<slug>/ or the local public/ folders."""
    for d in [ROOT / "public" / "audio", ROOT / "public"]:
        p = d / filename
        if p.exists():
            return p
    if SONGS_DIR.exists():
        for slug_dir in SONGS_DIR.iterdir():
            if slug_dir.is_dir():
                p = slug_dir / filename
                if p.exists():
                    return p
    return None


def analyze(audio_path: Path) -> dict:
    """Load audio with librosa and return BPM + beat times."""
    print(f"  Loading {audio_path.name} …", end=" ", flush=True)
    # Load at 22050 Hz mono, no res-resampling needed for librosa beat tracker
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    duration = len(y) / sr
    print(f"({duration:.1f}s)", end=" ", flush=True)

    # Beat tracking
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times_raw = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    # librosa may return tempo as 1-element array
    bpm = float(np.atleast_1d(tempo)[0])

    # Round beat times to 3 decimal places to keep JSON small
    beat_times = [round(float(t), 3) for t in beat_times_raw]

    print(f"→ {bpm:.1f} BPM, {len(beat_times)} beats")
    return {
        "algorithm": "librosa",
        "bpm": round(bpm, 2),
        "beatInterval": round(60.0 / bpm, 6) if bpm > 0 else 0,
        "beatTimes": beat_times,
        "duration": round(duration, 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Overwrite existing bpm.json")
    args = parser.parse_args()

    if not MANIFEST.exists():
        print(f"Manifest not found: {MANIFEST}")
        sys.exit(1)

    tracks = json.loads(MANIFEST.read_text())
    print(f"Found {len(tracks)} tracks in manifest.json\n")

    ok = skipped = errors = 0

    for track in tracks:
        tid  = track["id"]
        file = track["file"]
        out_dir = ANALYSIS_DIR / tid
        out_path = out_dir / "bpm.json"

        if not args.force and out_path.exists():
            print(f"[skip] {tid} (bpm.json exists, use --force to overwrite)")
            skipped += 1
            continue

        audio = find_audio(file)
        if not audio:
            print(f"[miss] {tid} — audio not found: {file}")
            errors += 1
            continue

        try:
            print(f"[work] {tid}")
            result = analyze(audio)
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(result, indent=2))
            print(f"  → written: {out_path.relative_to(ROOT)}")
            ok += 1
        except Exception as e:
            print(f"  ERROR: {e}")
            errors += 1

    print(f"\nDone — {ok} written, {skipped} skipped, {errors} errors")


if __name__ == "__main__":
    main()
