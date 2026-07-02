#!/usr/bin/env python3
"""
Analyze music structure using all-in-one (mir-aidj/all-in-one).

Usage:
    # Single file — prints BPM and segments:
    python tools/run_allin1.py path/to/song.mp3

    # Save cached JSON for the web app (Feature Inspector):
    python tools/run_allin1.py path/to/song.mp3 --save

    # Optionally also launch the allin1 visualization window:
    python tools/run_allin1.py path/to/song.mp3 --visualize

Requirements:
    pip install allin1
    pip install --no-build-isolation madmom  (from git+https://github.com/CPJKU/madmom.git for Python 3.12)
    # natten: follow https://github.com/SHI-Labs/NATTEN for your platform + torch version
    ffmpeg  (for MP3 support)

Notes:
    allin1 requires natten ≤ 0.15.x due to API changes. On Python 3.12 with newer
    natten (0.20+), this script applies a compatibility shim automatically.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stem_paths import WEB_APP_STEMS_DIR, write_manifest
sys.path.insert(0, str(Path(__file__).parent / "python"))
from paths import ANALYSIS_DIR, DATA_DIR, DEFAULT_DATA_DIR  # noqa: E402


# ─── natten compatibility shim (for natten >= 0.17) ──────────────────────────
# allin1 1.1.x imports natten1dav / natten1dqkrpb / natten2dav / natten2dqkrpb
# from natten.functional, which were removed in natten 0.17+. The shared
# shim in tools/python/natten_shim.py re-implements them in pure PyTorch
# so allin1 keeps working AND the vite capabilities probe can verify
# allin1 is importable on CPU-only hosts where natten itself never lands.

from natten_shim import apply_natten_shim  # noqa: E402 — sys.path was set above

_shimmed = apply_natten_shim()

import allin1  # noqa: E402 — must come after the shim


# ─── madmom beat-threshold patch + user-grid prior ───────────────────────────
# madmom's DBNDownBeatTrackingProcessor sometimes returns 0 beats on CPU, so we
# retry with progressively lower thresholds until beats are found.
#
# We ALSO feed the user's chosen grid straight into the tracker: allin1 builds
# its own (real, onset-aligned) beat/downbeat grid, but constrained to the
# user's time signature (`beats_per_bar`) and a tempo window around the user's
# BPM (`min_bpm`/`max_bpm`). This keeps allin1's grid in the user's ballpark
# WITHOUT any post-hoc octave/ratio surgery — the DBN simply tracks at the
# requested metrical level, fixing both octave doubling (pantheon 214→~107) and
# non-octave mismatches (phonk 92→~123) at the source. `_GRID_CONSTRAINTS` is set
# by analyze_file() before allin1.analyze() runs; empty → madmom's defaults.

_GRID_CONSTRAINTS: dict = {}


def _apply_madmom_patch():
    try:
        import allin1.postprocessing.metrical as _met
        from madmom.features.downbeats import DBNDownBeatTrackingProcessor
        import torch
        import numpy as np

        def _patched(logits, cfg):
            raw_beat      = torch.sigmoid(logits.logits_beat[0])
            raw_downbeat  = torch.sigmoid(logits.logits_downbeat[0])
            no_beat       = 1. - raw_beat
            no_downbeat   = 1. - raw_downbeat
            no            = (no_beat + no_downbeat) / 2.
            xbeat         = torch.maximum(torch.tensor(1e-8), raw_beat - raw_downbeat)
            combined      = torch.stack([xbeat, raw_downbeat, no], dim=-1)
            combined      = combined / combined.sum(dim=-1, keepdim=True)
            combined      = combined.cpu().numpy()

            bpb   = _GRID_CONSTRAINTS.get("beats_per_bar", [3, 4])
            min_b = _GRID_CONSTRAINTS.get("min_bpm", 55.0)
            max_b = _GRID_CONSTRAINTS.get("max_bpm", 215.0)
            pred = np.empty((0, 2))
            for threshold in [0.05, 0.02, 0.01, 0.005]:
                proc = DBNDownBeatTrackingProcessor(
                    beats_per_bar=bpb, min_bpm=min_b, max_bpm=max_b,
                    threshold=threshold, fps=cfg.fps)
                pred = proc(combined[:, :2])
                if len(pred) >= 2:
                    break

            beats          = pred[:, 0].tolist() if len(pred) else []
            beat_positions = pred[:, 1].astype('int').tolist() if len(pred) else []
            downbeats      = pred[pred[:, 1] == 1., 0].tolist() if len(pred) else []
            return {'beats': beats, 'downbeats': downbeats, 'beat_positions': beat_positions}

        # helpers.py uses `from .postprocessing.metrical import postprocess_metrical_structure`
        # so it holds a direct reference — patch that binding too.
        import allin1.helpers as _helpers
        _helpers.postprocess_metrical_structure = _patched
        return True
    except Exception as e:
        print(f'  [madmom patch] failed: {e}')
        return False

_madmom_patched = _apply_madmom_patch()


# ─── Helpers ─────────────────────────────────────────────────────────────────

def slugify(name: str) -> str:
    """Convert a display name / filename to a URL-safe slug."""
    name = re.sub(r'\.[^.]+$', '', name)          # strip extension
    name = name.lower()
    name = re.sub(r'[^a-z0-9]+', '-', name)
    name = name.strip('-')
    return name


def label_to_type(label: str) -> str:
    """Map allin1 segment labels to the EDM section-type vocabulary."""
    label = label.lower().strip()
    mapping = {
        'intro':        'intro',
        'verse':        'verse',
        'pre-chorus':   'buildup',
        'chorus':       'drop',
        'bridge':       'breakdown',
        'break':        'breakdown',
        'instrumental': 'verse',
        'outro':        'outro',
        'solo':         'verse',
        'interlude':    'breakdown',
    }
    return mapping.get(label, label)


# ─── User-grid prior for allin1 ──────────────────────────────────────────────
# allin1's own beat tracker is left in charge of the grid — it produces real,
# onset-aligned beats/downbeats — but we hand it the user's choice as a PRIOR so
# it tracks at the right metrical level instead of octave-doubling or locking
# onto the wrong ratio. The user's `timeSignature` becomes the DBN's
# `beats_per_bar`, and a tempo window around the user's `bpm` becomes its
# `min_bpm`/`max_bpm` (see _GRID_CONSTRAINTS / the madmom patch above). No
# librosa/madmom consensus is consulted. allin1 will NOT run until the user has
# set BOTH a BPM and a time signature for the song — require_user_grid() gates
# it, and supplies the prior.

# Tempo half-window (fraction) around the user's BPM handed to the DBN tracker.
# ±15% comfortably excludes the ×0.5 / ×2 octaves (±50% / +100%) so the tracker
# can't fall back into an octave error, while leaving room for real tempo drift.
_TEMPO_WINDOW = 0.15


def _parse_beats_per_bar(time_signature):
    """Beats-per-bar (numerator) from an 'N/D' time-signature string, or None."""
    if not time_signature or "/" not in str(time_signature):
        return None
    try:
        num = int(str(time_signature).split("/")[0])
        return num if num > 0 else None
    except Exception:
        return None


def _user_grid_params(slug: str):
    """The user-chosen grid for `slug` from song-info: (bpm, beats_per_bar,
    time_signature, grid_offset_sec). Any unset piece is None (offset → 0.0).
    Searches data/ then the data-default/ seed."""
    for base in (DATA_DIR, DEFAULT_DATA_DIR):
        p = base / "song-info" / f"{slug}.json"
        if not p.is_file():
            continue
        try:
            info = json.loads(p.read_text())
        except Exception:
            continue
        bpm = info.get("bpm")
        ts = info.get("timeSignature")
        return (
            float(bpm) if bpm else None,
            _parse_beats_per_bar(ts),
            str(ts) if ts else None,
            float(info.get("gridOffset") or 0.0),
        )
    return None, None, None, 0.0


def require_user_grid(slug: str):
    """Gate: allin1 may run only once the user has chosen a BPM and a time
    signature for the song. Exits with a clear message otherwise. Returns
    (bpm, beats_per_bar, time_signature, grid_offset_sec)."""
    bpm, bpb, ts, offset = _user_grid_params(slug)
    if not bpm or not bpb:
        sys.exit(
            f"\nERROR: '{slug}' has no user-chosen grid yet.\n"
            f"  song-info must define BOTH a BPM and a time signature before\n"
            f"  All-In-One can run — its bar grid is built from those values.\n"
            f"  current: bpm={bpm!r}, timeSignature={ts!r}\n"
            f"  Set them in the app (song info / Dataset Prep), then re-run.\n"
        )
    return bpm, bpb, ts, offset


# ─── Demucs model monkey-patch ───────────────────────────────────────────────

def _patch_demucs_model(model_name: str):
    """Replace allin1's hardcoded 'htdemucs' with *model_name* at runtime."""
    import subprocess as _sp
    import sys as _sys
    import allin1.demix as _demix_mod

    def _patched_demix(paths, demix_dir, device):
        todos, demix_paths = [], []
        for p in paths:
            out_dir = demix_dir / model_name / p.stem
            demix_paths.append(out_dir)
            if out_dir.is_dir() and all(
                (out_dir / f'{s}.wav').is_file() for s in ('bass', 'drums', 'other', 'vocals')
            ):
                continue
            todos.append(p)
        existing = len(paths) - len(todos)
        print(f'=> Found {existing} tracks already demixed, {len(todos)} to demix.')
        if todos:
            _sp.run(
                [_sys.executable, '-m', 'demucs.separate',
                 '--out', demix_dir.as_posix(),
                 '--name', model_name,
                 '--device', str(device),
                 *[p.as_posix() for p in todos]],
                check=True,
            )
        return demix_paths

    _demix_mod.demix = _patched_demix


# ─── Main ────────────────────────────────────────────────────────────────────

DEMUCS_MODELS = ['htdemucs', 'mdx', 'mdx_q', 'mdx_extra']

def analyze_file(audio_path: str, save: bool = False, visualize: bool = False,
                 model: str = "harmonix-all", demucs_model: str = "htdemucs") -> dict:
    """Run allin1.analyze() on *audio_path*, print results, and optionally save JSON."""

    audio_path = os.path.abspath(audio_path)
    if not os.path.isfile(audio_path):
        sys.exit(f"File not found: {audio_path}")

    # Key the output by the song *folder* slug (data/songs/<slug>/audio.mp3),
    # not slugify(filename): the app and generators read analysis by directory
    # name, and slugifying underscores→hyphens stranded outputs in a dir the app
    # never reads (5am_chediak → 5am-chediak/). Fall back to the filename slug
    # for an audio file not inside a per-song folder.
    audio_filename = os.path.basename(audio_path)
    parent = Path(audio_path).parent.name
    slug = parent if re.match(r'^[a-z0-9._-]+$', parent or "") else slugify(audio_filename)

    # Gate the (saving) run on the user having chosen a BPM + time signature,
    # and hand those to allin1's tracker as a prior so it grids at the user's
    # metrical level. _GRID_CONSTRAINTS is read inside the madmom patch during
    # allin1.analyze() below; clear it so a no-save / no-grid run uses defaults.
    _GRID_CONSTRAINTS.clear()
    user_grid = require_user_grid(slug) if save else None
    if user_grid:
        bpm_u, bpb_u, ts_u, off_u = user_grid
        _GRID_CONSTRAINTS.update({
            "beats_per_bar": [bpb_u],
            "min_bpm": bpm_u * (1.0 - _TEMPO_WINDOW),
            "max_bpm": bpm_u * (1.0 + _TEMPO_WINDOW),
        })
        print(f"  user-grid prior: {bpm_u} BPM ({ts_u}) → DBN tempo window "
              f"[{_GRID_CONSTRAINTS['min_bpm']:.1f}–{_GRID_CONSTRAINTS['max_bpm']:.1f}], "
              f"beats_per_bar={bpb_u}")

    if demucs_model != "htdemucs":
        _patch_demucs_model(demucs_model)

    print(f"\nAnalyzing: {audio_path}  [model={model}, demucs={demucs_model}]")
    if _shimmed:
        print("  (natten compatibility shim active)")

    repo_root = Path(__file__).parent.parent
    demix_dir = repo_root / "demix"
    spec_dir  = repo_root / "spec"

    t0 = time.time()
    result = allin1.analyze(
        audio_path,
        model=model,
        demix_dir=demix_dir,
        spec_dir=spec_dir,
        keep_byproducts=True,   # keep stems + spectrograms for re-use
    )
    elapsed = time.time() - t0

    # ── Copy stems to canonical web-app location ─────────────────────────────
    audio_stem = Path(audio_path).stem
    cache_dir = demix_dir / demucs_model / audio_stem
    stem_dir = WEB_APP_STEMS_DIR / audio_stem
    if cache_dir.exists() and not (stem_dir / "manifest.json").exists():
        stem_dir.mkdir(parents=True, exist_ok=True)
        sources = []
        for wav in sorted(cache_dir.glob("*.wav")):
            shutil.copy2(wav, stem_dir / wav.name)
            sources.append(wav.stem)
        if sources:
            write_manifest(stem_dir, Path(audio_path).name, sources, 0, model_name=demucs_model)
            print(f"  Stems → {stem_dir}/")

    # ── Print summary ────────────────────────────────────────────────────────
    bpm_str = f"{result.bpm:.2f}" if result.bpm is not None else "N/A"
    print(f"\nBPM: {bpm_str}")
    print(f"\nSegments ({len(result.segments)}):")
    for seg in result.segments:
        print(f"  {seg.start:7.2f}s – {seg.end:7.2f}s   {seg.label}")
    print(f"\n(analyzed in {elapsed:.1f}s)")

    if visualize:
        print("\nOpening visualization…")
        allin1.visualize(result)

    if not save:
        return {}

    # ── Build output JSON ────────────────────────────────────────────────────
    # slug / audio_filename were resolved (and the user grid gated) up front.
    sections = []
    raw_boundaries = []
    for seg in result.segments:
        sections.append({
            "time":    round(seg.start, 4),
            "endTime": round(seg.end,   4),
            "type":    label_to_type(seg.label),
            "label":   seg.label.capitalize(),
        })
        raw_boundaries.append(round(seg.start, 4))
    if sections:
        raw_boundaries.append(round(result.segments[-1].end, 4))

    duration = result.segments[-1].end if result.segments else 0.0

    # Derive output filename: harmonix-all → allin1.json, harmonix-fold3 → allin1-fold3.json
    if model == "harmonix-all":
        out_filename = "allin1.json"
        algo_id   = "allin1"
        algo_name = "All-In-One (allin1 ensemble)"
    else:
        fold = model.replace("harmonix-", "")          # e.g. "fold3"
        out_filename = f"allin1-{fold}.json"
        algo_id   = f"allin1-{fold}"
        algo_name = f"All-In-One ({fold})"

    output = {
        "algorithm": algo_id,
        "algoName":  algo_name,
        "audioFile": audio_filename,
        "duration":  round(duration, 4),
        "bpm":               round(result.bpm, 4) if result.bpm is not None else None,
        "beatPositions":     [round(t, 4) for t in (result.beats or [])],
        "downbeatPositions": [round(t, 4) for t in (result.downbeats or [])],
        "sections":          sections,
        "rawBoundaries":     raw_boundaries,
        "computedAt":        int(time.time()),
        "elapsedSec":        round(elapsed, 2),
    }

    # ── Annotate the allin1 grid (tracked under the user's prior above) ──────
    bpm_u, bpb_u, ts_u, off_u = user_grid
    tracked = output.get("bpm")
    output["userBpm"]      = round(bpm_u, 2)
    output["beatsPerBar"]  = bpb_u
    output["timeSignature"] = ts_u
    output["gridSource"]   = "allin1+userprior"
    output["tempoPrior"]   = [round(bpm_u * (1.0 - _TEMPO_WINDOW), 1),
                              round(bpm_u * (1.0 + _TEMPO_WINDOW), 1)]
    n_beats = len(output.get("beatPositions") or [])
    n_downs = len(output.get("downbeatPositions") or [])
    off_pct = abs(tracked - bpm_u) / bpm_u * 100 if (tracked and bpm_u) else 0
    flag = "  ⚠ outside prior" if off_pct > _TEMPO_WINDOW * 100 + 1 else ""
    print(f"  grid: allin1 tracked {tracked} BPM (user {bpm_u}, {ts_u}; "
          f"{n_downs} bars / {n_beats} beats){flag}")

    # ── Write to data/algorithm-outputs/analysis/<slug>/<out_filename> ──────
    out_dir = ANALYSIS_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / out_filename
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved → {out_path}")
    return output


def main():
    parser = argparse.ArgumentParser(description="Analyze music with all-in-one (allin1)")
    parser.add_argument("audio", help="Path to audio file (MP3 or WAV)")
    parser.add_argument("--save",      action="store_true",
                        help="Save JSON to data/algorithm-outputs/analysis/<slug>/allin1[-foldN].json")
    parser.add_argument("--visualize", action="store_true",
                        help="Open allin1.visualize() plot window")
    parser.add_argument("--model", default="harmonix-all",
                        choices=["harmonix-all",
                                 "harmonix-fold0", "harmonix-fold1", "harmonix-fold2",
                                 "harmonix-fold3", "harmonix-fold4", "harmonix-fold5",
                                 "harmonix-fold6", "harmonix-fold7"],
                        help="Model variant (default: harmonix-all ensemble)")
    parser.add_argument("--demucs-model", default="htdemucs", choices=DEMUCS_MODELS,
                        help="Demucs source-separation model (default: htdemucs)")
    args = parser.parse_args()
    analyze_file(args.audio, save=args.save, visualize=args.visualize,
                 model=args.model, demucs_model=args.demucs_model)


if __name__ == "__main__":
    main()
