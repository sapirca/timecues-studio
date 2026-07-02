#!/usr/bin/env python3
"""
Run Demucs on songs missing stems or manifest.json in the canonical
web-app/public/stems/ cache.

Handles three cases:
    1. No stems folder at all, but allin1 demix cache exists → copy cached stems
    2. No stems folder at all, no cache → full Demucs separation
    3. WAVs exist but manifest.json missing → just write the manifest

Single source of truth:
    - web player cache: web-app/public/stems/<audio_filename_stem>/
    - allin1 cache:     demix/htdemucs/<audio_filename_stem>/ (source only)
    - both runners now write manifests using the same shared helper
"""
import gc
import shutil
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch

from stem_paths import ALLIN1_DEMIX_DIR, WEB_APP_STEMS_DIR, write_manifest

sys.path.insert(0, str(Path(__file__).resolve().parent / "python"))
from paths import SONGS_DIR  # noqa: E402

MODEL_NAME = "htdemucs_6s"
CHUNK_SECS = 50
OVERLAP_SECS = 2

STEMS_DIR = WEB_APP_STEMS_DIR

_model = None

def get_model():
    global _model
    if _model is None:
        from demucs.pretrained import get_model as _get
        print(f"  Loading {MODEL_NAME} model…")
        _model = _get(MODEL_NAME)
        _model.eval()
    return _model

def _run_chunk(model, chunk_np):
    from demucs.apply import apply_model
    mix = torch.from_numpy(chunk_np).float().unsqueeze(0)
    with torch.no_grad():
        out = apply_model(model, mix, shifts=0, progress=False)
    result = out.squeeze(0).numpy()
    del mix, out; gc.collect()
    return result

def separate(audio_path, stem_dir):
    stem_dir.mkdir(parents=True, exist_ok=True)
    model = get_model()
    sr = model.samplerate
    sources = model.sources

    print(f"    Loading audio at {sr} Hz…")
    y, _ = librosa.load(str(audio_path), sr=sr, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y], axis=0)
    elif y.shape[0] == 1:
        y = np.concatenate([y, y], axis=0)
    total_samples = y.shape[-1]
    duration_s = total_samples / sr
    print(f"    Duration: {duration_s:.1f}s — processing in {CHUNK_SECS}s chunks")

    chunk_samples = int(CHUNK_SECS * sr)
    overlap_samples = int(OVERLAP_SECS * sr)
    step = chunk_samples - overlap_samples

    writers = {}
    for source in sources:
        writers[source] = sf.SoundFile(
            str(stem_dir / f"{source}.wav"), mode="w",
            samplerate=sr, channels=2, subtype="PCM_16")

    t0 = time.time()
    offset, chunk_idx = 0, 0
    n_chunks = max(1, int(np.ceil(total_samples / step)))
    while offset < total_samples:
        end = min(offset + chunk_samples, total_samples)
        chunk = y[:, offset:end]
        pad = chunk_samples - chunk.shape[-1]
        if pad > 0:
            chunk = np.pad(chunk, ((0, 0), (0, pad)))
        print(f"    Chunk {chunk_idx+1}/{n_chunks}  ({offset/sr:.0f}s–{end/sr:.0f}s)…")
        result = _run_chunk(model, chunk)
        trim_start = overlap_samples if offset > 0 else 0
        trim_end = end - offset
        result_trimmed = result[:, :, trim_start:trim_end]
        for i, source in enumerate(sources):
            writers[source].write(result_trimmed[i].T)
        offset += step; chunk_idx += 1

    for w in writers.values(): w.close()
    elapsed = round(time.time() - t0, 2)
    print(f"    Done in {elapsed}s")
    write_manifest(stem_dir, audio_path.name, sources, elapsed, model_name=MODEL_NAME)

def copy_from_allin1_cache(audio_path, stem_dir):
    """Copy stems from allin1's demix cache to the web-player stems dir."""
    cache_dir = ALLIN1_DEMIX_DIR / audio_path.stem
    cached_wavs = sorted(cache_dir.glob("*.wav"))
    stem_dir.mkdir(parents=True, exist_ok=True)
    sources = []
    for wav in cached_wavs:
        dest = stem_dir / wav.name
        shutil.copy2(wav, dest)
        sources.append(wav.stem)
        print(f"    Copied {wav.name}")
    return sources


def main():
    # Collect songs needing demucs
    to_copy_from_cache = []  # allin1 cache exists → just copy
    to_separate = []          # need full run
    to_manifest = []          # have WAVs, just need manifest

    for song_dir in sorted(SONGS_DIR.iterdir()):
        if not song_dir.is_dir(): continue
        audio_files = [p for p in song_dir.iterdir()
                       if p.suffix.lower() in {".mp3",".wav",".flac",".ogg",".m4a"}]
        if not audio_files: continue
        audio_path = audio_files[0]
        stem_dir = STEMS_DIR / audio_path.stem

        if (stem_dir / "manifest.json").exists():
            continue  # already done

        wavs = list(stem_dir.glob("*.wav")) if stem_dir.exists() else []
        if len(wavs) >= 6:
            to_manifest.append((audio_path, stem_dir))
        else:
            # Check allin1 demix cache before scheduling a full Demucs run. That
            # cache is the old 4-stem htdemucs (demix/htdemucs/), so it is only a
            # valid shortcut if it already holds the full 6-source set; otherwise
            # fall through to a real htdemucs_6s separation.
            cache_dir = ALLIN1_DEMIX_DIR / audio_path.stem
            cached_wavs = list(cache_dir.glob("*.wav")) if cache_dir.exists() else []
            if len(cached_wavs) >= 6:
                to_copy_from_cache.append((audio_path, stem_dir))
            else:
                to_separate.append((audio_path, stem_dir))

    if not to_separate and not to_manifest and not to_copy_from_cache:
        print("All songs already have demucs stems + manifest."); return

    # Copy stems from allin1 cache (fast — no model needed)
    if to_copy_from_cache:
        print(f"Copying stems from allin1 demix cache for {len(to_copy_from_cache)} song(s):")
        for audio_path, stem_dir in to_copy_from_cache:
            print(f"  {audio_path.name}  (cache: demix/htdemucs/{audio_path.stem}/)")
            try:
                sources = copy_from_allin1_cache(audio_path, stem_dir)
                write_manifest(stem_dir, audio_path.name, sources, 0, model_name=MODEL_NAME)
                print(f"    Manifest written → {stem_dir}/manifest.json")
            except Exception as e:
                print(f"  ERROR: {e}")
        print()

    # Fix manifests for songs that already have WAVs
    if to_manifest:
        print(f"Writing missing manifests for {len(to_manifest)} song(s):")
        for audio_path, stem_dir in to_manifest:
            print(f"  {audio_path.stem}")
            sources = [p.stem for p in sorted(stem_dir.glob("*.wav"))]
            write_manifest(stem_dir, audio_path.name, sources, 0, model_name=MODEL_NAME)
        print()

    # Full demucs runs (only when no cache is available)
    if to_separate:
        print(f"Running Demucs on {len(to_separate)} song(s):")
        for audio_path, stem_dir in to_separate:
            print(f"  {audio_path.name}")
        print()

        for audio_path, stem_dir in to_separate:
            print(f"► {audio_path.name}")
            try:
                separate(audio_path, stem_dir)
            except Exception as e:
                print(f"  ERROR: {e}")
            print()

    print("All done.")

if __name__ == "__main__":
    main()
