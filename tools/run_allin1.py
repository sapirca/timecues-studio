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
from paths import ANALYSIS_DIR  # noqa: E402


# ─── natten compatibility shim (for natten >= 0.17) ──────────────────────────
# allin1 1.1.x imports natten1dav / natten1dqkrpb / natten2dav / natten2dqkrpb
# from natten.functional, which were removed in natten 0.17+.
# This shim re-implements them via pure PyTorch so allin1 keeps working.

def _apply_natten_shim():
    try:
        from natten.functional import natten1dav  # noqa: F401  — already present
        return False  # no shim needed
    except ImportError:
        pass

    import torch
    import natten.functional as _nf

    def natten1dqkrpb(query, key, rpb, kernel_size, dilation=1):
        """1-D neighborhood-attention QK + relative-position-bias."""
        B, H, L, D = query.shape
        r = kernel_size // 2
        offsets = torch.arange(-r, r + 1, device=query.device) * dilation
        positions = torch.arange(L, device=query.device)
        src_idx = (positions.unsqueeze(1) + offsets.unsqueeze(0)).clamp(0, L - 1)
        key_nbrs = key[:, :, src_idx, :]                     # (B, H, L, K, D)
        scores = (query.unsqueeze(3) * key_nbrs).sum(-1)     # (B, H, L, K)
        rpb_sel = rpb[:, torch.arange(kernel_size, device=query.device)]  # (H, K)
        return scores + rpb_sel.unsqueeze(0).unsqueeze(2)

    def natten1dav(attn, value, kernel_size, dilation=1):
        """1-D neighborhood-attention AV product."""
        _, _, L, _ = attn.shape
        r = kernel_size // 2
        offsets = torch.arange(-r, r + 1, device=attn.device) * dilation
        positions = torch.arange(L, device=attn.device)
        src_idx = (positions.unsqueeze(1) + offsets.unsqueeze(0)).clamp(0, L - 1)
        v_nbrs = value[:, :, src_idx, :]                     # (B, H, L, K, D)
        return (attn.unsqueeze(-1) * v_nbrs).sum(-2)         # (B, H, L, D)

    def natten2dqkrpb(query, key, rpb, kernel_size, dilation=1):
        """2-D neighborhood-attention QK + relative-position-bias."""
        B, H, h, w, D = query.shape
        r = kernel_size // 2
        K = kernel_size
        oy = torch.arange(-r, r + 1, device=query.device) * dilation
        ox = torch.arange(-r, r + 1, device=query.device) * dilation
        sy = (torch.arange(h, device=query.device).unsqueeze(1) + oy.unsqueeze(0)).clamp(0, h - 1)
        sx = (torch.arange(w, device=query.device).unsqueeze(1) + ox.unsqueeze(0)).clamp(0, w - 1)
        lin = sy[:, None, :, None] * w + sx[None, :, None, :]   # (h, w, K, K)
        kf = key.reshape(B, H, h * w, D)
        kn = kf[:, :, lin.reshape(-1), :].reshape(B, H, h, w, K, K, D)
        qe = query.unsqueeze(4).unsqueeze(5)
        scores = (qe * kn).sum(-1)                              # (B, H, h, w, K, K)
        ri = torch.arange(K, device=query.device)
        rp = rpb[:, ri[:, None], ri[None, :]]                   # (H, K, K)
        scores = scores + rp.unsqueeze(0).unsqueeze(2).unsqueeze(3)
        return scores.reshape(B, H, h, w, K * K)

    def natten2dav(attn, value, kernel_size, dilation=1):
        """2-D neighborhood-attention AV product."""
        B, H, h, w, _ = attn.shape
        K = kernel_size
        D = value.shape[-1]
        r = K // 2
        oy = torch.arange(-r, r + 1, device=attn.device) * dilation
        ox = torch.arange(-r, r + 1, device=attn.device) * dilation
        sy = (torch.arange(h, device=attn.device).unsqueeze(1) + oy.unsqueeze(0)).clamp(0, h - 1)
        sx = (torch.arange(w, device=attn.device).unsqueeze(1) + ox.unsqueeze(0)).clamp(0, w - 1)
        lin = sy[:, None, :, None] * w + sx[None, :, None, :]
        vf = value.reshape(B, H, h * w, D)
        vn = vf[:, :, lin.reshape(-1), :].reshape(B, H, h, w, K, K, D)
        at = attn.reshape(B, H, h, w, K, K).unsqueeze(-1)
        return (at * vn).sum(-2).sum(-2)                        # (B, H, h, w, D)

    _nf.natten1dqkrpb = natten1dqkrpb
    _nf.natten1dav = natten1dav
    _nf.natten2dqkrpb = natten2dqkrpb
    _nf.natten2dav = natten2dav
    return True


_shimmed = _apply_natten_shim()

import allin1  # noqa: E402 — must come after the shim


# ─── madmom beat-threshold patch ─────────────────────────────────────────────
# madmom's DBNDownBeatTrackingProcessor sometimes returns 0 beats on CPU.
# Retry with progressively lower thresholds until beats are found.

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
    audio_filename = os.path.basename(audio_path)
    slug = slugify(audio_filename)

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
