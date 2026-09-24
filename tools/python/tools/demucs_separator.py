#!/usr/bin/env python3
"""Demucs v4 stem separator (htdemucs_6s / htdemucs).

Two models are selectable with --model:
  6s (htdemucs_6s, default) → vocals, drums, bass, other, guitar, piano
  4s (htdemucs)             → vocals, drums, bass, other

The 6-source model splits the old single `other` stem into guitar + piano +
a thinner `other` (synths / leads / pads / FX), so melodic content that used
to be lumped together is now selectable on its own. It costs roughly 1.5x the
wall time of the 4-source model, which is why 4s stays on offer for a quick
pass (and for hosts where the extra two stems aren't worth the wait).
Writes WAV files to public/stems/<slug>/ and a manifest.json consumed by the Inspector UI.

Audio is loaded via librosa (no ffmpeg needed). To stay within the ~2GB
memory budget of this environment, long tracks are processed in CHUNK_SECS
windows and written incrementally to disk.

Usage:
    # Separate one file:
    python tools/python/tools/demucs_separator.py --file common/audio/vandelux-tulum.mp3

    # Separate all files in common/audio/:
    python tools/python/tools/demucs_separator.py --all

    # Force re-run even if cache exists:
    python tools/python/tools/demucs_separator.py --all --force

Cache location (served statically by Vite and used by the web app):
    web-app/public/stems/<slug>/vocals.wav
    web-app/public/stems/<slug>/drums.wav
    web-app/public/stems/<slug>/bass.wav
    web-app/public/stems/<slug>/other.wav
    web-app/public/stems/<slug>/guitar.wav
    web-app/public/stems/<slug>/piano.wav
    web-app/public/stems/<slug>/manifest.json
"""

import argparse
import gc
import json
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch

# The two separation models the UI can pick between. `MODEL_NAME` stays the
# default (and the name other scripts import) so existing callers are unchanged.
MODEL_6S = "htdemucs_6s"
MODEL_4S = "htdemucs"
MODEL_NAME = MODEL_6S
# Short aliases the HTTP layer passes through, plus the real names so either
# spelling resolves. Anything else is rejected before a job starts.
MODEL_ALIASES = {
    "6s": MODEL_6S, "6": MODEL_6S, MODEL_6S: MODEL_6S,
    "4s": MODEL_4S, "4": MODEL_4S, MODEL_4S: MODEL_4S,
}


def resolve_model(name: str | None) -> str:
    """Map a UI/CLI model token onto a demucs pretrained-model name."""
    if not name:
        return MODEL_NAME
    resolved = MODEL_ALIASES.get(str(name).strip().lower())
    if resolved is None:
        raise ValueError(
            f"unknown model {name!r} — expected one of {sorted(set(MODEL_ALIASES))}"
        )
    return resolved


AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}

# Process at most this many seconds per chunk to stay within ~2 GB RAM.
# Overlap ensures no audible seam at chunk boundaries.
# 50 s OOM'd in a Codespace with ~2 GiB free; 15 s fits comfortably and only
# costs a small constant factor in wall time (htdemucs already segments
# internally at ~7.8 s, so making the outer chunk smaller has minimal impact).
CHUNK_SECS = 15
OVERLAP_SECS = 2
# Override htdemucs's internal segment (~7.8 s) on low-RAM hosts: smaller means
# lower peak activations during inference. ~4 s fits the spectral branch's
# minimum FFT window and trims peak RAM roughly in half.
_INNER_SEGMENT_SECS = 4.0

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_INPUT = REPO_ROOT / "common" / "audio"
DEFAULT_OUTPUT = REPO_ROOT / "web-app" / "public" / "stems"

TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from stem_paths import write_manifest

# One cache entry per model name — a session that separates one song with 6s
# and the next with 4s keeps both loaded rather than re-downloading each swap.
_models: dict = {}


def get_model(model_name: str = MODEL_NAME):
    if model_name not in _models:
        from demucs.pretrained import get_model as _get
        print(f"  Loading {model_name} model…")
        model = _get(model_name)
        model.eval()
        _models[model_name] = model
    return _models[model_name]


def _run_chunk(model, chunk_np: np.ndarray, segment: float | None = None) -> np.ndarray:
    """Run demucs on a (2, N) numpy array. Returns (n_sources, 2, N) numpy array.

    ``segment`` overrides the model's internal split length (in seconds). Pass
    a small value (~4 s) on low-RAM hosts to cap peak activations.
    """
    from demucs.apply import apply_model
    mix = torch.from_numpy(chunk_np).float().unsqueeze(0)  # (1, 2, N)
    kwargs: dict = {"shifts": 0, "progress": False}
    if segment is not None:
        kwargs["segment"] = segment
    with torch.no_grad():
        out = apply_model(model, mix, **kwargs)  # (1, n_sources, 2, N)
    result = out.squeeze(0).numpy()  # (n_sources, 2, N)
    del mix, out
    gc.collect()
    return result


def separate(
    audio_path: Path,
    output_dir: Path,
    force: bool = False,
    model: str | None = None,
) -> dict:
    """Separate a single audio file into stems and write manifest. Returns the manifest dict.

    ``model`` picks the source count — "6s" (default) or "4s"; see MODEL_ALIASES.
    """
    model_name = resolve_model(model)
    slug = audio_path.stem
    stem_dir = output_dir / slug
    manifest_path = stem_dir / "manifest.json"

    if manifest_path.exists() and not force:
        print(f"  [skip] {slug} — already cached (use --force to re-run)")
        with open(manifest_path) as f:
            return json.load(f)

    stem_dir.mkdir(parents=True, exist_ok=True)

    model = get_model(model_name)
    sr = model.samplerate          # 44100
    sources = model.sources        # 6s: ['drums','bass','other','vocals','guitar','piano']

    print(f"  Separating: {audio_path.name}")
    t0 = time.time()

    # Load full audio with librosa (handles mp3/flac/wav without ffmpeg)
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

    # Open one soundfile writer per stem (streaming write, no full concat in RAM)
    writers: dict[str, sf.SoundFile] = {}
    for source in sources:
        writers[source] = sf.SoundFile(
            str(stem_dir / f"{source}.wav"),
            mode="w",
            samplerate=sr,
            channels=2,
            subtype="PCM_16",
        )

    offset = 0
    chunk_idx = 0
    while offset < total_samples:
        end = min(offset + chunk_samples, total_samples)
        chunk = y[:, offset:end]

        # Pad short final chunk to avoid model issues with tiny segments
        pad = chunk_samples - chunk.shape[-1]
        if pad > 0:
            chunk = np.pad(chunk, ((0, 0), (0, pad)))

        n_chunks = max(1, int(np.ceil(total_samples / step)))
        print(f"    Chunk {chunk_idx + 1}/{n_chunks}  ({offset/sr:.0f}s–{end/sr:.0f}s)…")

        result = _run_chunk(model, chunk, segment=_INNER_SEGMENT_SECS)  # (n_sources, 2, chunk_samples)

        # Trim: skip overlap at the start of each chunk (except the first)
        trim_start = overlap_samples if offset > 0 else 0
        # Trim: don't write padding at the end of the final chunk
        trim_end = end - offset  # number of valid samples in this chunk
        result_trimmed = result[:, :, trim_start:trim_end]

        for i, source in enumerate(sources):
            writers[source].write(result_trimmed[i].T)  # soundfile wants (N, channels)

        offset += step
        chunk_idx += 1

    for w in writers.values():
        w.close()

    elapsed = round(time.time() - t0, 2)

    # Re-stemming 6s → 4s leaves guitar.wav / piano.wav behind. The manifest no
    # longer references them, so the UI is already correct, but the orphans burn
    # disk on a corpus-sized re-run — drop any stem WAV this model didn't write.
    for stale in stem_dir.glob("*.wav"):
        if stale.stem not in sources:
            print(f"    Removing stale stem from a previous model: {stale.name}")
            stale.unlink(missing_ok=True)

    manifest = write_manifest(stem_dir, audio_path.name, sources, elapsed, model_name=model_name)

    print(f"  Done in {elapsed}s  →  {stem_dir}/")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Demucs stem separator — generates cached stems for the Inspector UI"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", metavar="PATH", help="Single audio file to separate")
    group.add_argument("--all", action="store_true", help="Separate all audio files in --input dir")
    parser.add_argument("--input", default=str(DEFAULT_INPUT), help="Input directory (for --all)")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output stems directory")
    parser.add_argument("--force", action="store_true", help="Re-run even if cache already exists")
    parser.add_argument(
        "--model",
        default=MODEL_NAME,
        help=f"Separation model: 6s ({MODEL_6S}, 6 stems, default) or 4s ({MODEL_4S}, 4 stems)",
    )
    args = parser.parse_args()

    try:
        model_name = resolve_model(args.model)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(2)
    print(f"Model: {model_name}")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.file:
        audio_path = Path(args.file)
        if not audio_path.exists():
            import sys
            print(f"Error: file not found: {audio_path}", file=sys.stderr)
            sys.exit(1)
        separate(audio_path, output_dir, force=args.force, model=model_name)
    else:
        input_dir = Path(args.input)
        files = sorted(p for p in input_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS)
        if not files:
            import sys
            print(f"No audio files found in {input_dir}", file=sys.stderr)
            sys.exit(1)
        print(f"Found {len(files)} file(s) in {input_dir}")
        for f in files:
            separate(f, output_dir, force=args.force, model=model_name)

    print("All done.")


if __name__ == "__main__":
    main()
