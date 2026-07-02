"""Centralized on-disk paths for all data folders consumed by Python tools.

Per-song hierarchy:

  data/songs/<slug>/
  ├── audio/              — Audio files
  ├── song-info/          — Per-annotator metadata: <annotator>.json
  ├── annotations/        — All annotation types grouped by slug
  │   ├── manual/<annotator>/<slug>.json
  │   ├── auto-guess/<annotator>/<slug>.json
  │   └── layers/<annotator>/<slug>.json
  ├── stems/              — Demix stems
  └── analysis/           — Algorithm outputs
      ├── algo-clusters.json
      ├── bpm-detections.json
      ├── mir-features.json
      ├── msaf/...
      └── custom/...

Two parallel trees:

  data/         — user/local data (annotations, algorithm caches, audio).
                  Bind-mounted at runtime in docker; not baked into the image.

  data-default/ — read-only seeds shipped inside the docker image. Audio +
                  song-info for the CC0 tracks the app falls back to when
                  data/ doesn't have a slug.

All paths resolve from the repo root (parents[2] from this file). If you move
a folder on disk, update the value here and nowhere else. Mirror of
web-app/dataPaths.ts on the JS side.
"""

import re
from pathlib import Path
from typing import Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]

# URL-derived path-segment validator. Mirrors safeSlug() in
# web-app/vite.config.ts so the Node proxy and Python sidecars agree on
# what a valid slug looks like. Use at every request entry point in a
# sidecar before passing the value to any path helper below.
_SAFE_SEGMENT_RE = re.compile(r"^[a-z0-9._\-]+$")

def safe_segment(raw: Optional[str]) -> Optional[str]:
    """Validate a URL-derived path component used in a filesystem join.
    Returns the trimmed value if it's a single safe segment, else None.
    Rejects empty / oversized / `.` / `..` / separators / NUL / non-allowlisted
    characters.
    """
    if raw is None:
        return None
    v = str(raw)
    if not v or len(v) > 128:
        return None
    if v in (".", ".."):
        return None
    if "/" in v or "\\" in v or "\0" in v:
        return None
    if not _SAFE_SEGMENT_RE.match(v):
        return None
    return v

DATA_DIR         = REPO_ROOT / "data"
DEFAULT_DATA_DIR = REPO_ROOT / "data-default"

SONGS_DIR         = DATA_DIR / "songs"
DEFAULT_SONGS_DIR = DEFAULT_DATA_DIR / "songs"

# Top-level data directories (for fallback and batch operations)
SONG_INFO_DIR         = DATA_DIR / "song-info"
DEFAULT_SONG_INFO_DIR = DEFAULT_DATA_DIR / "song-info"

# Helper functions to build per-song paths
def song_dir(slug: str) -> Path:
    """Get the base directory for a song."""
    return SONGS_DIR / slug

def default_song_dir(slug: str) -> Path:
    """Get the default data directory for a song."""
    return DEFAULT_SONGS_DIR / slug

def annotations_dir(slug: str) -> Path:
    """Get annotations directory for a song: songs/<slug>/annotations"""
    return song_dir(slug) / "annotations"

def analysis_dir(slug: str) -> Path:
    """Get analysis directory for a song: songs/<slug>/analysis"""
    return song_dir(slug) / "analysis"

def stems_dir(slug: str) -> Path:
    """Get stems directory for a song: songs/<slug>/stems"""
    return song_dir(slug) / "stems"

# Demucs stems do NOT live under songs/<slug>/stems (that legacy per-song dir is
# unused). Their location depends on the environment:
#   * dev / run.sh:  web-app/public/stems/<slug>/  (stems daemon default;
#                    Vite serves them at /stems/...).
#   * prod docker:   data/stems/<slug>/  — the single /var/lib/timecues/data
#                    volume holds everything; the web container re-maps
#                    data/stems → /app/web-app/public/stems, but the
#                    experimental sidecars only mount data, so inside a sidecar
#                    the stems are reachable solely at data/stems.
#   * shipped seeds: data-default/stems/<slug>/  (read-only CC0 demo tracks).
# Search all three (user/dev trees first) so a per-stem detector run finds the
# stem regardless of which environment it runs in.
WEB_STEMS_DIR     = REPO_ROOT / "web-app" / "public" / "stems"
DATA_STEMS_DIR    = DATA_DIR / "stems"
DEFAULT_STEMS_DIR = DEFAULT_DATA_DIR / "stems"

# The six Demucs stems (htdemucs_6s). "mix" is the full track (the default,
# non-stem run) and is intentionally NOT in this set — callers treat stem in
# (None, "mix") as the full-mix path through find_audio(). `guitar` and `piano`
# are the 6-source split of the old single `other` stem.
STEM_NAMES = ("vocals", "drums", "bass", "other", "guitar", "piano")


def stem_audio(slug: str, stem: str) -> Optional[Path]:
    """Return the cached Demucs stem file for (slug, stem), or None.

    Searches web-app/public/stems/<slug>/ (locally-generated) then
    data-default/stems/<slug>/ (shipped seed). The stems daemon writes .wav;
    the CC0 seeds ship as .mp3 — accept either. Validates both segments with
    safe_segment() so a forgotten validator at a caller can't traverse out of
    the stems dirs, and rejects any stem outside STEM_NAMES.
    """
    if safe_segment(slug) is None:
        return None
    if stem not in STEM_NAMES:
        return None
    for base in (WEB_STEMS_DIR, DATA_STEMS_DIR, DEFAULT_STEMS_DIR):
        slug_dir = base / slug
        if not slug_dir.is_dir():
            continue
        for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
            cand = slug_dir / f"{stem}{ext}"
            if cand.is_file():
                return cand
    return None


def cache_name(algo: str, stem: Optional[str] = None) -> str:
    """Cache-file stem for a (algo, stem) pair: bare `<algo>` for the full mix
    (stem None/"mix"), `<algo>__<stem>` for a per-stem run. This composite id is
    the unit of work end-to-end — same string keys the on-disk JSON, the
    /api/<fam>/detect/<slug>/<id> read URL, and the UI overlay set."""
    if not stem or stem == "mix":
        return algo
    return f"{algo}__{stem}"

def song_info_dir(slug: str) -> Path:
    """Get song-info directory for a song: songs/<slug>/song-info"""
    return song_dir(slug) / "song-info"

# Annotation type directories (per-song)
def manual_annotations_dir(slug: str) -> Path:
    return annotations_dir(slug) / "manual"

def auto_guess_annotations_dir(slug: str) -> Path:
    return annotations_dir(slug) / "auto-guess"

def annotation_layers_dir(slug: str) -> Path:
    return annotations_dir(slug) / "layers"

# Analysis output directories (per-song)
def algo_clusters_dir(slug: str) -> Path:
    return analysis_dir(slug) / "algo-clusters.json"

def bpm_detections_dir(slug: str) -> Path:
    return analysis_dir(slug) / "bpm-detections.json"

def mir_features_dir(slug: str) -> Path:
    return analysis_dir(slug) / "mir-features.json"

def msaf_dir(slug: str) -> Path:
    return analysis_dir(slug) / "msaf"

def custom_results_dir(slug: str) -> Path:
    return analysis_dir(slug) / "custom"

# Legacy: These were top-level before the per-song migration
_DEPRECATED_ANNOTATIONS_DIR = DATA_DIR / "annotations"
_DEPRECATED_ALGO_OUTPUTS_DIR = DATA_DIR / "algorithm-outputs"
_DEPRECATED_STEMS_DIR = DATA_DIR / "stems"

# Old constants for reference (kept for backward compatibility if needed)
ANNOTATION_TIMES_DIR = _DEPRECATED_ANNOTATIONS_DIR / "timing"


# ── Resolver helpers ─────────────────────────────────────────────────────────

def songs_search_dirs() -> list[Path]:
    """Audio search order: user dir first, then shipped defaults."""
    return [SONGS_DIR, DEFAULT_SONGS_DIR]


def find_audio(slug: str, exts: Iterable[str] = (".mp3", ".wav", ".flac", ".ogg", ".m4a")) -> Optional[Path]:
    """Return the first audio file for `slug` found under user or default
    songs dir, or None if neither has it. User dir wins on conflict.
    Rejects slugs that don't pass safe_segment() so a forgotten validator
    at a caller can't be used to traverse out of the songs dirs.
    """
    if safe_segment(slug) is None:
        return None
    suffixes = {e.lower() for e in exts}
    for base in songs_search_dirs():
        slug_dir = base / slug
        if not slug_dir.is_dir():
            continue
        for child in slug_dir.iterdir():
            if child.is_file() and child.suffix.lower() in suffixes:
                return child
    return None


def list_song_slugs() -> list[str]:
    """Slugs available under user or default songs dirs (deduped, user first)."""
    seen: dict[str, None] = {}
    for base in songs_search_dirs():
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            if d.is_dir() and d.name not in seen:
                seen[d.name] = None
    return list(seen.keys())


# ── Backward compatibility: Old flat directory structure ──────────────────────
# These constants are exported for tools that haven't been migrated to the
# per-song structure yet. They point to the old flat directory locations.
# TODO: Update these tools to use the new per-song helpers instead.

_ANNOTATIONS_DIR     = DATA_DIR / "annotations"
_ALGO_OUTPUTS_DIR    = DATA_DIR / "algorithm-outputs"
_DEFAULT_ANNOTATIONS_DIR = DEFAULT_DATA_DIR / "annotations"

# Annotation folders (per-annotator subdirs: <dir>/<annotator>/<slug>.json)
MANUAL_ANNOTATIONS_DIR       = _ANNOTATIONS_DIR / "manual"
AUTO_GUESS_ANNOTATIONS_DIR = _ANNOTATIONS_DIR / "auto-guess"
ANNOTATION_TIMES_DIR       = _ANNOTATIONS_DIR / "timing"

# Default annotation folders shipped with the container (parallel layout).
DEFAULT_MANUAL_ANNOTATIONS_DIR       = _DEFAULT_ANNOTATIONS_DIR / "manual"
DEFAULT_AUTO_GUESS_ANNOTATIONS_DIR = _DEFAULT_ANNOTATIONS_DIR / "auto-guess"

# Custom-script annotation folders (per-script subdir + per-annotator subdir).
# Path is: <CUSTOM_ANNOTATIONS_DIR>/<script_name>/<annotator>/<slug>.json
CUSTOM_ANNOTATIONS_DIR = _ANNOTATIONS_DIR / "custom"

# User-created annotation layers (Cues today; Spans/Lyrics later).
# Path is: <ANNOTATION_LAYERS_DIR>/<annotator>/<slug>.json — a single file per
# song per annotator holds ALL custom layers for that song. Layer ordering,
# rename, visibility, and items all live inside this one document.
ANNOTATION_LAYERS_DIR = _ANNOTATIONS_DIR / "layers"

# Editable detector outputs (copy-on-write per annotator). When the user
# first Accept/Rejects an item in a detector's output, the algorithm-cache
# envelope is copied here with an extra `review` map, and subsequent edits
# write through to this path. The algorithm cache at CUSTOM_RESULTS_DIR
# stays untouched so re-runs can still be cached, but a re-run with an
# existing edited file at this path returns 409 unless the user confirms.
# Path: <DETECTOR_OUTPUTS_DIR>/<detector_name>/<annotator>/<slug>.json
DETECTOR_OUTPUTS_DIR = _ANNOTATIONS_DIR / "detector-outputs"

# Algorithm output caches (flat: <dir>/<slug>.json)
ANALYSIS_DIR    = _ALGO_OUTPUTS_DIR / "analysis"
ALGO_CLUSTERS_DIR  = _ALGO_OUTPUTS_DIR / "algo-clusters"
BPM_DETECTIONS_DIR = _ALGO_OUTPUTS_DIR / "bpm-detections"
MIR_FEATURES_DIR   = _ALGO_OUTPUTS_DIR / "mir-features"

# Custom-script result cache (algorithm-mode): <dir>/<script_name>/<slug>.json
CUSTOM_RESULTS_DIR = _ALGO_OUTPUTS_DIR / "custom"
# Read-only data-default seed for the above, shipped inside the image. Lets the
# demo corpus's curated outputs render on a fresh data dir without a writable
# cache (parallels DEFAULT_SONGS_DIR / DEFAULT_SONG_INFO_DIR). User data at
# CUSTOM_RESULTS_DIR always takes precedence.
DEFAULT_CUSTOM_RESULTS_DIR = DEFAULT_DATA_DIR / "algorithm-outputs" / "custom"

# MSAF raw outputs (per-slug folder: msaf/<slug>/msaf-{algo}.json + estimations.jams)
MSAF_DIR             = _ALGO_OUTPUTS_DIR / "msaf"
MSAF_BATCH_JAMS_DIR  = _ALGO_OUTPUTS_DIR / "msaf-batch-jams"

# Experimental: SPAN-family detector outputs (Silero-VAD, JDCNet, panns-tags).
# One file per (slug, algorithm): span/<slug>/<algo>.json.
SPAN_OUTPUTS_DIR    = _ALGO_OUTPUTS_DIR / "span"
# Experimental: BeatNet CUE-family detector. Same shape as bpm-detections,
# kept in its own dir so the existing bpm cache doesn't get re-keyed.
BEATNET_OUTPUTS_DIR = _ALGO_OUTPUTS_DIR / "beatnet"
# Experimental: LOOP-family detector outputs (chroma autocorrelation v0).
# One file per (slug, algorithm): loop/<slug>/<algo>.json.
LOOP_OUTPUTS_DIR    = _ALGO_OUTPUTS_DIR / "loop"
# Experimental: PANNs AudioSet-527 tagging (SPAN family). Separate sidecar
# from span_server so its torch + transformers footprint doesn't bloat
# the span image with another 80 MB of weights at every rebuild.
PANNS_OUTPUTS_DIR   = _ALGO_OUTPUTS_DIR / "panns"
# Experimental: basic-pitch polyphonic note transcription (CUE family).
# Spotify's pretrained ONNX model bundled with the pip package — no
# weight download at runtime.
PITCH_OUTPUTS_DIR   = _ALGO_OUTPUTS_DIR / "pitch"
# Experimental: pure-librosa CUE-family extras (key, autochord chords,
# onsets). One sidecar to keep the docker image count manageable.
CUE_EXTRAS_OUTPUTS_DIR = _ALGO_OUTPUTS_DIR / "cue-extras"
# Experimental: HPSS percussive-span detector (SPAN family).
PERCUSSIVE_OUTPUTS_DIR = _ALGO_OUTPUTS_DIR / "percussive"
# Experimental: Whisper-base vocal transcription (LYRICS family).
LYRICS_OUTPUTS_DIR     = _ALGO_OUTPUTS_DIR / "lyrics"
# Experimental: LoCoMotif motif discovery (PATTERN family).
# One file per (slug, algorithm): pattern/<slug>/<algo>.json.
PATTERN_OUTPUTS_DIR    = _ALGO_OUTPUTS_DIR / "pattern"

# Curated end-products: the five distilled outputs the project ships, each
# built by an orchestrating generator (tools/python/generators/) that
# combines the raw caches above (allin1, panns, lyrics, pattern, …) and
# stems into one clean, importable layer. Distinct from the raw caches so a
# generator never clobbers the algorithm output it consumes.
#   curated/<family>/<slug>.json   family in
#   {phrases, instruments, cues, drum-pattern, lyrics}
CURATED_OUTPUTS_DIR    = _ALGO_OUTPUTS_DIR / "curated"
