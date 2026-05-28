#!/usr/bin/env python3
"""Shared paths and helpers for cached Demucs stems.

The canonical stem cache lives in web-app/public/stems/<audio-stem>/ and is
the only location the web app reads from.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
WEB_APP_STEMS_DIR = REPO_ROOT / "web-app" / "public" / "stems"
ALLIN1_DEMIX_DIR = REPO_ROOT / "demix" / "htdemucs"


def stem_dir_for(audio_stem: str) -> Path:
    return WEB_APP_STEMS_DIR / audio_stem


def manifest_payload(audio_filename: str, stem_dir_name: str, sources: Iterable[str], elapsed_sec: float, model_name: str = "htdemucs") -> dict:
    stems_urls = {source: f"/stems/{stem_dir_name}/{source}.wav" for source in sources}
    return {
        "model": model_name,
        "audioFile": audio_filename,
        "slug": stem_dir_name,
        "computedAt": int(time.time()),
        "elapsedSec": elapsed_sec,
        "stems": stems_urls,
    }


def write_manifest(stem_dir: Path, audio_filename: str, sources: Iterable[str], elapsed_sec: float, model_name: str = "htdemucs") -> dict:
    manifest = manifest_payload(audio_filename, stem_dir.name, sources, elapsed_sec, model_name=model_name)
    stem_dir.mkdir(parents=True, exist_ok=True)
    with open(stem_dir / "manifest.json", "w") as file_handle:
        json.dump(manifest, file_handle, indent=2)
    return manifest
