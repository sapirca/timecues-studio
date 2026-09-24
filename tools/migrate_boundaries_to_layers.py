#!/usr/bin/env python3
"""Fold the single-doc manual boundary annotations into the layers document.

Before
    <data>/annotations/manual/<annotator>/<slug>.json   { song, reviewed, sections[] }
    <data>/annotations/layers/<annotator>/<slug>.json   { song, layers[], statusByType }

After
    <data>/annotations/layers/<annotator>/<slug>.json   { song, layers[ boundaries, ... ], statusByType }
    <data>/annotations/manual/                          (removed)

Boundaries stop being a singleton and become an ordinary AnnotationLayer of
`type: "boundaries"`, so every generic layer path (row order, lane rendering,
selection, per-type status) picks them up with no special case. The migrated
layer is named "Boundaries 1" and placed FIRST in `layers[]`, which is where
the canvas used to draw the fixed `manual` row.

Field mapping
    sections[]                 -> layer.items[]  (each gains a stable `id`)
    reviewed / ready_for_review-> statusByType.boundaries
    mode                       -> layer.mode
    genre                      -> dropped (write-only; nothing ever read it)
    auto_guess_status          -> dropped (the auto-guess doc is the source)

Idempotent: a target document that already has a `boundaries` layer is left
alone, so re-running after a partial pass is safe.

Usage
    python3 tools/migrate_boundaries_to_layers.py --data data            # dry run
    python3 tools/migrate_boundaries_to_layers.py --data data --apply
    python3 tools/migrate_boundaries_to_layers.py --data data --apply --delete-source
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path

LAYER_NAME = "Boundaries 1"
LAYER_COLOR = "#a78bfa"
LAYER_SNAP = "bar"

# Every field BoundaryItem carries, in declaration order. Anything else on a
# stored section is dropped loudly rather than smuggled into the new document.
ITEM_FIELDS = ("time", "beat", "type", "label", "description", "importance", "candidates")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def stage_from(doc: dict) -> str:
    if doc.get("reviewed"):
        return "reviewed"
    if doc.get("ready_for_review"):
        return "ready_for_review"
    return "in_progress"


def section_to_item(section: dict) -> tuple[dict, list[str]]:
    item = {"id": new_id()}
    for field in ITEM_FIELDS:
        if field in section and section[field] is not None:
            item[field] = section[field]
    item.setdefault("type", "unset")
    item.setdefault("label", "")
    unknown = sorted(set(section) - set(ITEM_FIELDS))
    return item, unknown


def boundary_layer_from(manual: dict) -> tuple[dict, list[str]]:
    items: list[dict] = []
    unknown: set[str] = set()
    for section in manual.get("sections") or []:
        if not isinstance(section, dict):
            continue
        item, extra = section_to_item(section)
        items.append(item)
        unknown.update(extra)
    # Boundaries tile the track, so the stored order IS the reading order.
    items.sort(key=lambda it: it.get("time", 0.0))
    layer = {
        "id": new_id(),
        "name": LAYER_NAME,
        "type": "boundaries",
        "visible": True,
        "color": LAYER_COLOR,
        "snap": LAYER_SNAP,
        "items": items,
    }
    if manual.get("mode"):
        layer["mode"] = manual["mode"]
    return layer, sorted(unknown)


def iter_manual_files(manual_dir: Path):
    """Yield (annotator_or_None, slug, path) for both corpus layouts.

    Per-annotator: <manual>/<annotator>/<slug>.json
    Shared corpus: <manual>/<slug>.json
    """
    if not manual_dir.is_dir():
        return
    for entry in sorted(manual_dir.iterdir()):
        if entry.is_dir():
            for f in sorted(entry.glob("*.json")):
                yield entry.name, f.stem, f
        elif entry.suffix == ".json":
            yield None, entry.stem, entry


def target_path(layers_dir: Path, annotator: str | None, slug: str) -> Path:
    return (layers_dir / annotator / f"{slug}.json") if annotator else (layers_dir / f"{slug}.json")


def migrate(data_root: Path, apply: bool, delete_source: bool) -> int:
    manual_dir = data_root / "annotations" / "manual"
    layers_dir = data_root / "annotations" / "layers"

    if not manual_dir.exists():
        print(f"  no manual dir at {manual_dir} — nothing to do")
        return 0

    migrated = skipped = failed = 0
    for annotator, slug, src in iter_manual_files(manual_dir):
        who = annotator or "<shared>"
        try:
            manual = json.loads(src.read_text())
        except Exception as exc:  # noqa: BLE001 - report and keep going
            print(f"  FAIL  {who}/{slug}: unreadable ({exc})")
            failed += 1
            continue

        dst = target_path(layers_dir, annotator, slug)
        if dst.exists():
            try:
                doc = json.loads(dst.read_text())
            except Exception as exc:  # noqa: BLE001
                print(f"  FAIL  {who}/{slug}: target unreadable ({exc})")
                failed += 1
                continue
        else:
            doc = {
                "song": manual.get("song", slug),
                "annotated_at": manual.get("annotated_at", ""),
                "layers": [],
                "statusByType": {},
            }

        doc.setdefault("layers", [])
        doc.setdefault("statusByType", {})
        doc.setdefault("song", manual.get("song", slug))

        if any(isinstance(l, dict) and l.get("type") == "boundaries" for l in doc["layers"]):
            print(f"  skip  {who}/{slug}: already has a boundaries layer")
            skipped += 1
            continue

        layer, unknown = boundary_layer_from(manual)
        if unknown:
            print(f"  note  {who}/{slug}: dropped unknown section fields {unknown}")
        doc["layers"].insert(0, layer)
        doc["statusByType"]["boundaries"] = stage_from(manual)

        print(f"  ok    {who}/{slug}: {len(layer['items'])} boundaries -> {dst.relative_to(data_root)}")
        migrated += 1
        if apply:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(json.dumps(doc, indent=2) + "\n")

    print(f"\n  migrated={migrated} skipped={skipped} failed={failed}")

    if failed:
        print("  refusing to delete the source tree while any file failed")
        return 1

    if delete_source:
        if apply:
            shutil.rmtree(manual_dir)
            print(f"  removed {manual_dir}")
        else:
            print(f"  would remove {manual_dir}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", action="append", required=True,
                    help="data root holding annotations/ (repeatable, e.g. --data data --data data-default)")
    ap.add_argument("--apply", action="store_true", help="write changes (default is a dry run)")
    ap.add_argument("--delete-source", action="store_true", help="remove annotations/manual/ when every file migrated")
    args = ap.parse_args()

    if not args.apply:
        print("DRY RUN — pass --apply to write\n")

    rc = 0
    for root in args.data:
        path = Path(root).resolve()
        print(f"{path}:")
        rc |= migrate(path, args.apply, args.delete_source)
        print()
    return rc


if __name__ == "__main__":
    sys.exit(main())
