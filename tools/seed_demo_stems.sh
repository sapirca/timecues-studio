#!/usr/bin/env bash
# Encode the six Demucs stems (vocals, drums, bass, other, guitar, piano) for
# each demo track to 192 kbps MP3 and stage them under data-default/stems/<slug>/ so
# they ship inside the docker image. Without this seed step the demo
# visitor has to wait for Demucs to run on first stem-button click (which
# also isn't available to anonymous users since /api/run-demucs is admin-
# gated). Writes a manifest.json next to each stem set pointing at the MP3
# URLs that the Inspector consumes.
#
# Expects the source WAV stems to already exist under web-app/public/stems/
# (run tools/python/tools/demucs_separator.py first — htdemucs_6s model).
#
# Usage:  bash tools/seed_demo_stems.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/web-app/public/stems"
DST_DIR="$ROOT/data-default/stems"

SLUGS=("edm-at-midnight" "pantheon" "phonk-remix")
STEMS=("vocals" "drums" "bass" "other" "guitar" "piano")

for slug in "${SLUGS[@]}"; do
  src="$SRC_DIR/$slug"
  dst="$DST_DIR/$slug"
  if [[ ! -d "$src" ]]; then
    echo "SKIP $slug: no source dir $src" >&2
    continue
  fi
  # Clear any stale 4-stem set so the demo never serves a mix of old + new.
  rm -f "$dst"/*.mp3 "$dst"/manifest.json
  mkdir -p "$dst"
  for stem in "${STEMS[@]}"; do
    if [[ ! -f "$src/$stem.wav" ]]; then
      echo "SKIP $slug/$stem: $src/$stem.wav missing" >&2
      continue
    fi
    echo "→ $slug/$stem.mp3"
    ffmpeg -y -loglevel error -i "$src/$stem.wav" \
      -codec:a libmp3lame -b:a 192k "$dst/$stem.mp3"
  done

  # Find the original audio file to mention in the manifest (for parity with
  # the WAV manifest the live Demucs run produces).
  audio_file=""
  for ext in mp3 wav flac ogg m4a; do
    candidate="$ROOT/data-default/songs/$slug/$slug.$ext"
    if [[ -f "$candidate" ]]; then
      audio_file="$slug.$ext"
      break
    fi
  done

  cat > "$dst/manifest.json" <<EOF
{
  "model": "htdemucs_6s",
  "audioFile": "$audio_file",
  "slug": "$slug",
  "shipped": true,
  "stems": {
    "drums": "/stems/$slug/drums.mp3",
    "bass": "/stems/$slug/bass.mp3",
    "other": "/stems/$slug/other.mp3",
    "vocals": "/stems/$slug/vocals.mp3",
    "guitar": "/stems/$slug/guitar.mp3",
    "piano": "/stems/$slug/piano.mp3"
  }
}
EOF
  echo "wrote $dst/manifest.json"
done

echo "done"
du -sh "$DST_DIR"/* 2>/dev/null || true
