#!/usr/bin/env python3
"""
Lean batch All-In-One (allin1) over the whole corpus — structure JSON only,
NO stems retained.

Unlike run_allin1.py / run_allin1_batch.py (which call
allin1.analyze(keep_byproducts=True) and then copy the demixed stems into
web-app/public/stems/), this driver is built for a one-off corpus sweep that
must NOT bloat disk:

  * allin1.analyze(..., keep_byproducts=False) — the internal Demucs demix and
    the spectrograms are deleted immediately after each track, so peak extra
    disk is bounded to ONE song's transient stems (~140 MB) instead of the
    ~30 GB a keep-stems run over 110 songs would cost.
  * demix_dir / spec_dir point at a throwaway tmp dir OFF the data disk.
  * writes ONLY data/algorithm-outputs/analysis/<slug>/allin1-<fold>.json.

Slug policy: iterates the song FOLDER names (the canonical slug that find_audio
and the MSAF server use), NOT slugify(audio_filename) like run_allin1.py — that
older path created the stray dash-variant analysis dirs. Writing under the
folder slug keeps allin1 output in the same dir MSAF already populated.

Usage (inside the allin1 container, data bind-mounted at /app/data):
  python tools/run_allin1_lean.py [--model harmonix-fold0] [--force]
"""
import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "python"))
from paths import ANALYSIS_DIR, SONGS_DIR, find_audio  # noqa: E402
from natten_shim import apply_natten_shim  # noqa: E402

apply_natten_shim()
import allin1  # noqa: E402 — must follow the shim


# ── madmom beat-threshold patch (verbatim from run_allin1.py) ────────────────
# madmom's DBNDownBeatTrackingProcessor sometimes returns 0 beats on CPU.
# Retry with progressively lower thresholds until beats are found.
def _apply_madmom_patch():
    try:
        from madmom.features.downbeats import DBNDownBeatTrackingProcessor
        import torch
        import numpy as np

        def _patched(logits, cfg):
            raw_beat     = torch.sigmoid(logits.logits_beat[0])
            raw_downbeat = torch.sigmoid(logits.logits_downbeat[0])
            no_beat      = 1. - raw_beat
            no_downbeat  = 1. - raw_downbeat
            no           = (no_beat + no_downbeat) / 2.
            xbeat        = torch.maximum(torch.tensor(1e-8), raw_beat - raw_downbeat)
            combined     = torch.stack([xbeat, raw_downbeat, no], dim=-1)
            combined     = combined / combined.sum(dim=-1, keepdim=True)
            combined     = combined.cpu().numpy()

            pred = np.empty((0, 2))
            for threshold in [0.05, 0.02, 0.01, 0.005]:
                proc = DBNDownBeatTrackingProcessor(
                    beats_per_bar=[3, 4], threshold=threshold, fps=cfg.fps)
                pred = proc(combined[:, :2])
                if len(pred) >= 2:
                    break

            beats          = pred[:, 0].tolist() if len(pred) else []
            beat_positions = pred[:, 1].astype('int').tolist() if len(pred) else []
            downbeats      = pred[pred[:, 1] == 1., 0].tolist() if len(pred) else []
            return {'beats': beats, 'downbeats': downbeats, 'beat_positions': beat_positions}

        import allin1.helpers as _helpers
        _helpers.postprocess_metrical_structure = _patched
        return True
    except Exception as e:
        print(f'  [madmom patch] failed: {e}', file=sys.stderr)
        return False


_apply_madmom_patch()


def label_to_type(label: str) -> str:
    """Map allin1 segment labels to the EDM section-type vocabulary
    (verbatim from run_allin1.py so the JSON schema matches)."""
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


def out_meta(model: str):
    """(out_filename, algo_id, algo_name) for a given allin1 model variant."""
    if model == "harmonix-all":
        return "allin1.json", "allin1", "All-In-One (allin1 ensemble)"
    fold = model.replace("harmonix-", "")
    return f"allin1-{fold}.json", f"allin1-{fold}", f"All-In-One ({fold})"


def analyze_one(slug: str, audio_path: Path, model: str, tmp_root: Path) -> dict:
    demix_dir = tmp_root / "demix"
    spec_dir  = tmp_root / "spec"
    t0 = time.time()
    result = allin1.analyze(
        str(audio_path),
        model=model,
        demix_dir=demix_dir,
        spec_dir=spec_dir,
        keep_byproducts=False,   # ← the whole point: drop stems + spectrograms
    )
    elapsed = time.time() - t0

    sections, raw_boundaries = [], []
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
    out_filename, algo_id, algo_name = out_meta(model)

    output = {
        "algorithm": algo_id,
        "algoName":  algo_name,
        "audioFile": audio_path.name,
        "duration":  round(duration, 4),
        "bpm":               round(result.bpm, 4) if result.bpm is not None else None,
        "beatPositions":     [round(t, 4) for t in (result.beats or [])],
        "downbeatPositions": [round(t, 4) for t in (result.downbeats or [])],
        "sections":          sections,
        "rawBoundaries":     raw_boundaries,
        "computedAt":        int(time.time()),
        "elapsedSec":        round(elapsed, 2),
    }

    out_dir = ANALYSIS_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / out_filename).write_text(json.dumps(output, indent=2))
    return {"segments": len(sections), "elapsed": round(elapsed, 1),
            "out": str(out_dir / out_filename)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="harmonix-fold0",
                        help="allin1 model variant (default: harmonix-fold0)")
    parser.add_argument("--force", action="store_true",
                        help="recompute even if the output JSON already exists")
    args = parser.parse_args()

    out_filename, _, _ = out_meta(args.model)
    slugs = sorted(d.name for d in SONGS_DIR.iterdir() if d.is_dir())
    print(f"START allin1 lean — {len(slugs)} songs, model={args.model}", flush=True)

    ok = skip = err = 0
    with tempfile.TemporaryDirectory(prefix="allin1_lean_") as tmp:
        tmp_root = Path(tmp)
        for i, slug in enumerate(slugs, 1):
            existing = ANALYSIS_DIR / slug / out_filename
            if existing.exists() and not args.force:
                skip += 1
                continue
            audio = find_audio(slug)
            if audio is None:
                err += 1
                print(f"[{i}/{len(slugs)}] {slug}: no audio", flush=True)
                continue
            try:
                r = analyze_one(slug, audio, args.model, tmp_root)
                ok += 1
                print(f"[{i}/{len(slugs)}] {slug}: {r['segments']} segs in {r['elapsed']}s", flush=True)
            except Exception as e:
                err += 1
                print(f"[{i}/{len(slugs)}] {slug}: ERR {e}", flush=True)
    print(f"DONE ok={ok} skip={skip} err={err}", flush=True)


if __name__ == "__main__":
    main()
