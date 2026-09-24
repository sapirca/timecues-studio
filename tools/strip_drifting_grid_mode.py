#!/usr/bin/env python3
"""Clear the removed Drifting grid mode out of a song-info corpus.

Drifting ('dynamic') was removed: its tempo anchors were derived from a tempo
detector, so any grid built on them was circular as evaluation ground truth.
Files written by an older build still carry its leftovers:

    tempoAnchors          -> dropped (nothing reads it)
    gridMode: "dynamic"   -> "static"
    manualBaseGridMode:
              "dynamic"   -> "static"

None of it changes what the app draws — `dynamic` is no longer in the GridMode
union, so today it already falls through to the static grid. What this fixes is
the document SAYING a mode that does not exist, which leaves the tempo-mode
picker with no tab selected and a curator with no way to tell which grid they
are looking at.

The app also cleans what it reads (sanitizeSongInfo in
web-app/src/types/songInfo.ts), so any song a curator opens and saves heals
itself. This script is for sweeping a corpus that nobody is about to touch —
notably the production volume on the VM, where the files sit untouched for
months.

Every other field, and the key order, is preserved: the file is rewritten in
the same 2-space JSON the app's own POST handler writes.

Idempotent — a clean corpus reports zero changes.

Usage
    python3 tools/strip_drifting_grid_mode.py --data data                  # dry run
    python3 tools/strip_drifting_grid_mode.py --data data --apply
    python3 tools/strip_drifting_grid_mode.py --data data --data data-default --apply

On the VM the production volume is root-owned, so:
    sudo python3 tools/strip_drifting_grid_mode.py --data /var/lib/timecues/data --apply
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

RETIRED_MODE = "dynamic"
FALLBACK_MODE = "static"
RETIRED_FIELDS = ("tempoAnchors",)
MODE_FIELDS = ("gridMode", "manualBaseGridMode")


def clean(doc: dict) -> tuple[dict, list[str]]:
    """Return (cleaned doc, human-readable list of what changed)."""
    changes: list[str] = []
    out = dict(doc)  # dict preserves insertion order, so key order survives

    for field in RETIRED_FIELDS:
        if field in out:
            value = out.pop(field)
            n = len(value) if isinstance(value, list) else "?"
            changes.append(f"dropped {field} ({n} entries)")

    for field in MODE_FIELDS:
        if out.get(field) == RETIRED_MODE:
            out[field] = FALLBACK_MODE
            changes.append(f"{field}: {RETIRED_MODE} -> {FALLBACK_MODE}")

    return out, changes


def sweep(data_root: Path, apply: bool) -> tuple[int, int, int]:
    song_info_dir = data_root / "song-info"
    if not song_info_dir.is_dir():
        print(f"  no song-info dir at {song_info_dir} — nothing to do")
        return 0, 0, 0

    changed = clean_already = failed = 0
    for path in sorted(song_info_dir.glob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except Exception as exc:  # noqa: BLE001 — report and keep going
            print(f"  FAIL  {path.name}: unreadable ({exc})")
            failed += 1
            continue

        if not isinstance(doc, dict):
            print(f"  FAIL  {path.name}: not a JSON object")
            failed += 1
            continue

        out, changes = clean(doc)
        if not changes:
            clean_already += 1
            continue

        print(f"  {'fix ' if apply else 'would fix'}  {path.name}: {'; '.join(changes)}")
        changed += 1
        if apply:
            path.write_text(json.dumps(out, indent=2) + "\n")

    return changed, clean_already, failed


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data", action="append", required=True,
                    help="data root holding song-info/ (repeatable)")
    ap.add_argument("--apply", action="store_true",
                    help="write changes (default is a dry run)")
    args = ap.parse_args()

    if not args.apply:
        print("DRY RUN — pass --apply to write\n")

    total_changed = total_clean = total_failed = 0
    for root in args.data:
        path = Path(root)
        print(f"{path}:")
        changed, already, failed = sweep(path, args.apply)
        total_changed += changed
        total_clean += already
        total_failed += failed

    print(f"\n  changed={total_changed} already-clean={total_clean} failed={total_failed}")
    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(main())
