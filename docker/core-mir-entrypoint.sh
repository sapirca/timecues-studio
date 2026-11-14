#!/bin/sh
# Entrypoint for the core-mir merged container.
#
# Syncs the detectors shipped in the image into the live custom dir, then
# hands off to supervisord which runs the four backend servers
# (bpm/mir/ruptures/custom) as supervised child processes.
# See docker/core-mir.supervisord.conf for the program definitions.
set -e

# The live dir is a bind mount that outlives every image, so a copy-if-missing
# seed froze each detector at the version it first shipped with and never let
# a retired one go: prod kept serving 40 curators deleted months earlier.
#
# Instead the image owns the files it shipped. .seeded lists them; each start
# overwrites those that still ship, deletes those that no longer do, and never
# touches a file it did not seed (a Playground save, a hand upload, or a
# package someone installed). A detector package is a folder, and is owned the
# same way as a whole: replaced entire, so a file dropped from it goes too.
live=/app/tools/python/custom
seed=/app/tools/python/custom-seed
manifest="$live/.seeded"
mkdir -p "$live"

if [ -f "$manifest" ]; then
  while IFS= read -r base; do
    [ -n "$base" ] || continue
    if [ ! -e "$seed/$base" ]; then
      rm -rf "${live:?}/$base"
    fi
  done < "$manifest"
fi

: > "$manifest.tmp"
for f in "$seed"/*; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  case "$base" in
    .*|__pycache__) continue ;;
  esac
  if [ -d "$f" ]; then
    rm -rf "${live:?}/$base"
    cp -R "$f" "$live/$base"
    find "$live/$base" -name __pycache__ -type d -prune -exec rm -rf {} +
  else
    case "$base" in *.py) ;; *) continue ;; esac
    cp "$f" "$live/$base"
  fi
  echo "$base" >> "$manifest.tmp"
done
mv "$manifest.tmp" "$manifest"

exec supervisord -c /app/supervisord.conf
