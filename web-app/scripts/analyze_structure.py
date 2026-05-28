#!/usr/bin/env python3
"""
Offline Song Structure Analyzer
================================
Runs 4 MSAF boundary-detection algorithms on every audio file under songs/<slug>/,
then classifies each segment into an EDM section type (intro / buildup / drop /
breakdown / outro / verse) using librosa energy heuristics.

Outputs:
    data/algorithm-outputs/analysis/<audio-slug>/<algorithm>.json   ← one file per algo per track
    data/algorithm-outputs/analysis/manifest.json                   ← catalog of all audio files

Usage:
  python scripts/analyze_structure.py              # process all files
  python scripts/analyze_structure.py --file path/to/audio.mp3  # single file
  python scripts/analyze_structure.py --algo sf    # only one algorithm
"""

import argparse
import json
import os
import re
import sys
import time
import warnings

import librosa
import numpy as np

warnings.filterwarnings("ignore")

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
APP_DIR     = os.path.dirname(SCRIPT_DIR)
REPO_ROOT   = os.path.dirname(APP_DIR)

sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "python"))
from paths import SONGS_DIR as _SONGS_DIR, ANALYSIS_DIR as _ANALYSIS_DIR  # noqa: E402

SONGS_DIR    = str(_SONGS_DIR)
ANALYSIS_DIR = str(_ANALYSIS_DIR)

ALGORITHMS = {
    "sf":    {"name": "Structural Features (SF)",                 "feature": "mfcc"},
    "foote": {"name": "Foote Self-Similarity",                    "feature": "mfcc"},
    "cnmf":  {"name": "CNMF (Non-negative Matrix Factorization)", "feature": "mfcc"},
    "olda":  {"name": "OLDA (Optimal Linear Discriminant)",       "feature": "mfcc"},
}

SUPPORTED_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}

# ── Slug helper ───────────────────────────────────────────────────────────────

def slugify(name: str) -> str:
    name = os.path.splitext(name)[0]
    name = name.lower()
    name = re.sub(r"[^a-z0-9]+", "-", name)
    name = name.strip("-")
    return name

# ── EDM section classifier ────────────────────────────────────────────────────

def classify_sections(audio_path: str, boundaries: np.ndarray) -> list[dict]:
    """
    Given boundary timestamps (seconds), load audio with librosa and compute
    per-segment RMS energy + spectral centroid.  Then label each segment using
    position + energy heuristics that work well for EDM / electronic music.

    Returns a list of section dicts:
      { time, endTime, label, type, energy, centroid }
    """
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    boundaries = np.clip(boundaries, 0, duration)
    boundaries = np.sort(np.unique(boundaries))

    # Compute per-segment features
    seg_energies = []
    seg_centroids = []
    for i in range(len(boundaries) - 1):
        t0 = boundaries[i]
        t1 = boundaries[i + 1]
        s0 = int(t0 * sr)
        s1 = int(t1 * sr)
        seg = y[s0:s1]
        if len(seg) < 512:
            seg_energies.append(0.0)
            seg_centroids.append(0.0)
            continue
        rms = float(np.sqrt(np.mean(seg ** 2)))
        centroid = float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=sr)))
        seg_energies.append(rms)
        seg_centroids.append(centroid)

    n = len(seg_energies)
    if n == 0:
        return []

    # Normalise to 0-1
    e_arr  = np.array(seg_energies)
    c_arr  = np.array(seg_centroids)
    e_max  = e_arr.max() or 1.0
    c_max  = c_arr.max() or 1.0
    e_norm = e_arr / e_max
    c_norm = c_arr / c_max

    # Label logic
    labels = ["verse"] * n

    # 1. Find high-energy segments (drops: energy > 0.65)
    is_drop = e_norm > 0.65
    for i in range(n):
        if is_drop[i]:
            labels[i] = "drop"

    # 2. Buildups: segment just before a drop with rising energy
    for i in range(1, n):
        if labels[i] == "drop" and labels[i - 1] != "drop":
            dur = boundaries[i] - boundaries[i - 1]
            if dur >= 4:   # buildup ≥ 4s
                labels[i - 1] = "buildup"

    # 3. Breakdowns: low-energy (< 0.35) segments not immediately before a drop
    #    (they CAN follow a drop — e.g. a quiet section after a climax)
    for i in range(n):
        if e_norm[i] < 0.35 and labels[i] == "verse":
            before_drop = (i < n - 1 and labels[i + 1] == "drop")
            if not before_drop:
                labels[i] = "breakdown"

    # 4. Intro: leading low-energy segments before first drop
    first_drop_idx = next((i for i, l in enumerate(labels) if l == "drop"), n)
    for i in range(first_drop_idx):
        if labels[i] in ("verse", "breakdown") and e_norm[i] < 0.55:
            labels[i] = "intro"

    # 5. Outro: trailing low-energy segments after last drop
    last_drop_idx = next((i for i in range(n - 1, -1, -1) if labels[i] == "drop"), -1)
    if last_drop_idx >= 0:
        for i in range(last_drop_idx + 1, n):
            if labels[i] in ("verse", "breakdown") and e_norm[i] < 0.55:
                labels[i] = "outro"

    # Build section list
    sections = []
    for i in range(n):
        t  = float(boundaries[i])
        t1 = float(boundaries[i + 1])
        label_type = labels[i]
        sections.append({
            "time":     round(t,  3),
            "endTime":  round(t1, 3),
            "type":     label_type,
            "label":    label_type.capitalize(),
            "energy":   round(float(e_norm[i]),  3),
            "centroid": round(float(c_norm[i]),  3),
        })
    return sections

# ── Run one algorithm on one file ─────────────────────────────────────────────

def analyze_file(audio_path: str, algo_id: str) -> dict:
    import msaf
    import os, tempfile
    msaf.config.features_tmp_file = os.path.join(tempfile.gettempdir(), ".features_msaf_tmp.json")

    t0 = time.time()
    boundaries, raw_labels = msaf.process(
        audio_path,
        boundaries_id=algo_id,
        feature=ALGORITHMS[algo_id]["feature"],
    )
    elapsed = time.time() - t0

    # Always start from 0
    if len(boundaries) == 0 or boundaries[0] != 0:
        boundaries = np.concatenate([[0.0], boundaries])

    sections = classify_sections(audio_path, boundaries)

    return {
        "algorithm":  algo_id,
        "algoName":   ALGORITHMS[algo_id]["name"],
        "audioFile":  os.path.basename(audio_path),
        "duration":   sections[-1]["endTime"] if sections else 0,
        "sections":   sections,
        "rawBoundaries": [round(float(b), 3) for b in boundaries],
        "computedAt": int(time.time()),
        "elapsedSec": round(elapsed, 2),
    }

# ── Process one audio file (all algorithms) ───────────────────────────────────

def process_audio(audio_path: str, algos: list[str], force: bool = False):
    slug   = slugify(os.path.basename(audio_path))
    outdir = os.path.join(ANALYSIS_DIR, slug)
    os.makedirs(outdir, exist_ok=True)

    results = {}
    for algo in algos:
        out_path = os.path.join(outdir, f"{algo}.json")
        if not force and os.path.exists(out_path):
            print(f"  [{algo}] cached — skipping")
            with open(out_path) as f:
                results[algo] = json.load(f)
            continue

        print(f"  [{algo}] running {ALGORITHMS[algo]['name']}…", end="", flush=True)
        try:
            data = analyze_file(audio_path, algo)
            with open(out_path, "w") as f:
                json.dump(data, f, indent=2)
            print(f" done ({data['elapsedSec']}s, {len(data['sections'])} sections)")
            results[algo] = data
        except Exception as e:
            print(f" ERROR: {e}")

    return slug, results

# ── Build / update manifest ───────────────────────────────────────────────────

def build_manifest(audio_dir: str, processed: dict[str, str]) -> list[dict]:
    """
    Returns list of {id, name, url, slug} entries for all audio files
    found in audio_dir, sorted by name.
    """
    entries = []
    for fname in sorted(os.listdir(audio_dir)):
        ext = os.path.splitext(fname)[1].lower()
        if ext not in SUPPORTED_EXTS:
            continue
        slug = slugify(fname)
        display = os.path.splitext(fname)[0]
        # Try to parse "Artist - Title" format
        parts = display.split(" - ", 1)
        if len(parts) == 2:
            name = f"{parts[0].strip()} — {parts[1].strip()}"
        else:
            name = display
        entries.append({
            "id":   slug,
            "name": name,
            "file": fname,
            "url":  f"/audio/{fname}",
            "hasAnalysis": slug in processed,
        })
    return entries

# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Offline MSAF song structure analyzer")
    parser.add_argument("--file",  help="Process a single audio file (path)")
    parser.add_argument("--algo",  choices=list(ALGORITHMS.keys()),
                        help="Run only one algorithm (default: all)")
    parser.add_argument("--force", action="store_true",
                        help="Re-run even if cached results exist")
    args = parser.parse_args()

    algos = [args.algo] if args.algo else list(ALGORITHMS.keys())
    os.makedirs(ANALYSIS_DIR, exist_ok=True)

    if args.file:
        files = [os.path.abspath(args.file)]
    else:
        # Walk songs/<slug>/ — each slug folder may contain one audio file.
        files = []
        if os.path.isdir(SONGS_DIR):
            for slug in sorted(os.listdir(SONGS_DIR)):
                slug_dir = os.path.join(SONGS_DIR, slug)
                if not os.path.isdir(slug_dir):
                    continue
                for f in sorted(os.listdir(slug_dir)):
                    if os.path.splitext(f)[1].lower() in SUPPORTED_EXTS:
                        files.append(os.path.join(slug_dir, f))

    if not files:
        print(f"No audio files found in {SONGS_DIR}")
        sys.exit(1)

    print(f"Processing {len(files)} file(s) with algorithms: {', '.join(algos)}\n")

    processed_slugs: dict[str, str] = {}
    for audio_path in files:
        fname = os.path.basename(audio_path)
        print(f"► {fname}")
        slug, _ = process_audio(audio_path, algos, force=args.force)
        processed_slugs[slug] = fname
        print()

    # Update manifest
    manifest_path = os.path.join(ANALYSIS_DIR, "manifest.json")

    # Merge with existing manifest slugs
    existing_slugs: dict[str, str] = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            try:
                existing = json.load(f)
                for e in existing:
                    if e.get("hasAnalysis"):
                        existing_slugs[e["id"]] = e["file"]
            except Exception:
                pass
    merged_slugs = {**existing_slugs, **processed_slugs}

    manifest = build_manifest(SONGS_DIR, merged_slugs)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Manifest written → {manifest_path}  ({len(manifest)} entries)")

if __name__ == "__main__":
    main()
