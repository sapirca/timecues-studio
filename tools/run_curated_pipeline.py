#!/usr/bin/env python3
"""One command to take a song from raw audio to the five curated outputs.

Collapses the otherwise-manual chain — separate stems, fire each model
sidecar on the right stem, then build + cache the curated layers — into a
single invocation. Designed for the GCP VM where the heavy model deps
(Demucs, PANNs, Silero-VAD, Whisper, LoCoMotif) are installed; on a machine
without them each model step degrades to a reported "deps missing" instead
of crashing, so the script's flow can still be exercised anywhere.

Pipeline per slug
-----------------
  1. stems    — ensure Demucs stems exist (delegates to run_demucs_songs.py,
                which is idempotent and corpus-wide). Skipped if present.
  2. detect   — populate the raw sidecar caches each generator consumes,
                each on its best stem:
                  PANNs   panns-cnn14   on  other    → instruments / cues
                  SPAN    silero-vad    on  vocals   → instruments
                  LYRICS  whisper-base  on  vocals   → lyrics / cues
                  PATTERN locomotif     on  drums    → cues
                (phrases needs only the existing allin1 cache — no model.)
  3. generate — run the curated generators AND cache them as the four stub
                detectors so they show up, editable, in the app immediately:
                  curated_phrases / _instruments / _cues / _drum_pattern
                plus the lyrics generator (no stub — batch file only).

Usage
-----
  python tools/run_curated_pipeline.py --slug pantheon
  python tools/run_curated_pipeline.py                 # whole corpus
  python tools/run_curated_pipeline.py --slug pantheon --force
  python tools/run_curated_pipeline.py --slug pantheon --only detect
  python tools/run_curated_pipeline.py --skip-stems    # stems already done

`--only` accepts stems | detect | generate (repeatable via comma).
"""

from __future__ import annotations

import argparse
import importlib
import subprocess
import sys
from pathlib import Path

_TOOLS_DIR = Path(__file__).resolve().parent
_PY_DIR = _TOOLS_DIR / "python"
for p in (str(_PY_DIR), str(_TOOLS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from paths import STEM_NAMES, find_audio, list_song_slugs, stem_audio  # noqa: E402

# (sidecar module, algorithm id, stem) — the raw caches the generators read.
_DETECTS = [
    ("panns_server", "panns-cnn14", "other"),
    ("span_server", "silero-vad", "vocals"),
    ("lyrics_server", "whisper-base", "vocals"),
    # ctc-forced-aligner only fires when a reference transcript is saved
    # (data/lyrics-text/<slug>.txt); detect_one auto-loads it. Listed after
    # whisper so a no-reference run degrades to whisper, but when lyrics ARE
    # pasted the curated generator prefers this tighter alignment.
    ("lyrics_server", "ctc-forced-aligner", "vocals"),
    ("pattern_server", "locomotif", "drums"),
    # basic-pitch note transcription per stem → note-activity instrument
    # start/stop (inst_notes), one notes curator per pitched stem. Drums are
    # unpitched, so no basic-pitch / notes curator runs on them.
    ("pitch_server", "basic-pitch", "vocals"),
    ("pitch_server", "basic-pitch", "bass"),
    ("pitch_server", "basic-pitch", "other"),
    ("pitch_server", "basic-pitch", "guitar"),
    ("pitch_server", "basic-pitch", "piano"),
]

# Stub detector names (tools/python/custom/) → cached so the app surfaces them.
_STUBS = [
    "curated_phrases_msaf",
    "curated_inst_vocals",
    "curated_inst_drums",
    "curated_inst_bass",
    "curated_inst_other",
    # htdemucs_6s split the old `other` stem into guitar + piano
    "curated_inst_guitar",
    "curated_inst_piano",
    # alternative-model instrument start/stop — one note-activity layer per
    # pitched stem (basic-pitch notes sounding), the pitched complement to the
    # energy presence curators above. Drums are unpitched, so no notes curator.
    "curated_inst_notes_vocals",
    "curated_inst_notes_bass",
    "curated_inst_notes_other",
    "curated_inst_notes_guitar",
    "curated_inst_notes_piano",
    "curated_inst_drums_madmom",
    # EDM-focused start/stop
    "curated_edm_lowend",
    "curated_edm_hats",
    "curated_edm_arrangement",
    "curated_panns",
    # cues split per stem (one layer each) — other / guitar / piano
    "curated_cues",
    "curated_cues_guitar",
    "curated_cues_piano",
    # pitched complement to curated_cues: short, HIGH note onsets from
    # basic-pitch (sparkle/plucks/arps), same per-stem split.
    "curated_note_cues",
    "curated_note_cues_guitar",
    "curated_note_cues_piano",
    "curated_drum_pattern",
    # user-grid A/B sibling of curated_drum_pattern, plus the bass riff — both
    # quantize against the curator-confirmed grid, so they need no allin1 cache.
    "curated_drum_pattern_grid",
    "curated_bass_pattern",
    "curated_drum_sections",
    "curated_lyrics",
]


def _fmt(stage: str, label: str, status: str, detail: str = "") -> str:
    line = f"  [{stage:<8}] {label:<28} {status}"
    return f"{line}  {detail}" if detail else line


# ─── Stage 1: stems ───────────────────────────────────────────────────────────


def ensure_stems(slug: str, *, force: bool) -> list[str]:
    have = [s for s in STEM_NAMES if stem_audio(slug, s) is not None]
    if len(have) >= len(STEM_NAMES) and not force:
        return [_fmt("stems", "demucs", "ok", f"present ({', '.join(have)})")]
    if find_audio(slug) is None:
        return [_fmt("stems", "demucs", "SKIP", "no audio for slug")]
    # Delegate to the existing, idempotent corpus stem runner. It only does
    # work for songs missing a manifest, so re-running is cheap.
    try:
        proc = subprocess.run(
            [sys.executable, str(_TOOLS_DIR / "run_demucs_songs.py")],
            capture_output=True, text=True, timeout=3600,
        )
        if proc.returncode == 0:
            now = [s for s in STEM_NAMES if stem_audio(slug, s) is not None]
            ok = len(now) >= len(STEM_NAMES)
            return [_fmt("stems", "demucs", "ok" if ok else "PARTIAL", f"have ({', '.join(now)})")]
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [""]
        return [_fmt("stems", "demucs", "ERROR", tail[0])]
    except Exception as exc:  # noqa: BLE001 — report, never abort the run
        return [_fmt("stems", "demucs", "ERROR", f"{type(exc).__name__}: {exc}")]


# ─── Stage 2: detect ──────────────────────────────────────────────────────────


def run_detects(slug: str, *, force: bool) -> list[str]:
    out: list[str] = []
    for mod_name, algo, stem in _DETECTS:
        label = f"{algo} on {stem}"
        if stem_audio(slug, stem) is None:
            out.append(_fmt("detect", label, "SKIP", f"no '{stem}' stem"))
            continue
        try:
            mod = importlib.import_module(mod_name)
            env = mod.detect_one(slug, algo, stem=stem, force=force)
        except Exception as exc:  # noqa: BLE001
            out.append(_fmt("detect", label, "ERROR", f"{type(exc).__name__}: {exc}"))
            continue
        if env.get("ok"):
            n = len(env.get("spans") or env.get("patterns") or env.get("words") or [])
            out.append(_fmt("detect", label, "ok", f"{n} items"))
        else:
            out.append(_fmt("detect", label, "no-deps", str(env.get("error") or "")[:60]))
    return out


# ─── Stage 3: generate ────────────────────────────────────────────────────────


def ensure_allin1(slug: str) -> str:
    """Idempotent prerequisite: make the allin1 bar grid exist before the
    grid-dependent curators run. Only the allin1-based curators (phrases,
    curated_drum_pattern, drum_sections) need it — the *user-grid* pattern
    curators derive their grid from SongInfo and run fine without it. Generated
    only when absent (even under --force: allin1 is far heavier than the curated
    layers it feeds), and degrades to a reported status when its deps are
    missing instead of aborting the run."""
    from generators.common import load_allin1  # local: tools/python is on sys.path

    if load_allin1(slug) is not None:
        return _fmt("generate", "allin1 grid", "ok", "present")
    audio = find_audio(slug)
    if audio is None:
        return _fmt("generate", "allin1 grid", "SKIP", "no audio for slug")
    try:
        proc = subprocess.run(
            [sys.executable, str(_TOOLS_DIR / "run_allin1.py"), str(audio), "--save"],
            capture_output=True, text=True, timeout=3600,
        )
        if proc.returncode == 0 and load_allin1(slug) is not None:
            return _fmt("generate", "allin1 grid", "ok", "generated")
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [""]
        return _fmt("generate", "allin1 grid", "no-deps", tail[0][:60])
    except Exception as exc:  # noqa: BLE001 — report, never abort the run
        return _fmt("generate", "allin1 grid", "ERROR", f"{type(exc).__name__}: {exc}")


def run_generate(slug: str) -> list[str]:
    out: list[str] = []
    # Bar grid first: the allin1-based curators below need it; the user-grid
    # ones don't, but running it once here covers the whole stub set cheaply.
    out.append(ensure_allin1(slug))
    # The stub detectors: cache via the real custom runner so the web UI
    # lists + renders them exactly as it would after a manual "Run".
    # Always force here — regeneration is cheap and must reflect whatever the
    # detect stage just (re)wrote, never a stale prior envelope.
    try:
        import custom_runner
    except Exception as exc:  # noqa: BLE001
        return [_fmt("generate", "custom_runner", "ERROR", f"{type(exc).__name__}: {exc}")]
    for name in _STUBS:
        try:
            env = custom_runner.run(name, slug, force=True)
            fatal = env.get("fatal")
            if fatal:
                out.append(_fmt("generate", name, "SKIP", fatal.get("message", "")[:60]))
            else:
                out.append(_fmt("generate", name, "ok", f"accepted={env['stats']['accepted']}"))
        except Exception as exc:  # noqa: BLE001
            out.append(_fmt("generate", name, "ERROR", f"{type(exc).__name__}: {exc}"))
    return out


# ─── Driver ───────────────────────────────────────────────────────────────────


def run_slug(slug: str, *, stages: set[str], force: bool) -> None:
    print(f"▶ {slug}")
    if "stems" in stages:
        for line in ensure_stems(slug, force=force):
            print(line)
    if "detect" in stages:
        for line in run_detects(slug, force=force):
            print(line)
    if "generate" in stages:
        for line in run_generate(slug):
            print(line)
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", help="single song (default: whole corpus)")
    ap.add_argument("--force", action="store_true", help="recompute even when caches exist")
    ap.add_argument("--skip-stems", action="store_true", help="assume stems are already present")
    ap.add_argument("--only", default="", help="comma-separated subset of: stems,detect,generate")
    args = ap.parse_args()

    all_stages = ["stems", "detect", "generate"]
    if args.only:
        stages = {s.strip() for s in args.only.split(",") if s.strip()}
        bad = stages - set(all_stages)
        if bad:
            ap.error(f"unknown --only stage(s): {', '.join(sorted(bad))}")
    else:
        stages = set(all_stages)
    if args.skip_stems:
        stages.discard("stems")

    slugs = [args.slug] if args.slug else list_song_slugs()
    if not slugs:
        print("no songs found under data/songs or data-default/songs", file=sys.stderr)
        return 1

    print(f"slugs={len(slugs)}  stages={[s for s in all_stages if s in stages]}  force={args.force}\n")
    for slug in slugs:
        run_slug(slug, stages=stages, force=args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())