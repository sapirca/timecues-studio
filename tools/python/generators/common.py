"""Shared plumbing for the curated-output generators.

The envelope produced here is intentionally identical in shape to the one
the sandboxed custom-detector runner writes (see custom_runner._empty_envelope
and the docstring at the top of custom_runner.py). Keeping the two byte-for-byte
compatible means the web app needs exactly one parser and one
envelope→AnnotationLayer importer for both paths.

Extra, generator-only fields (`family`, `generator`) are additive — the
existing custom-result parser ignores keys it doesn't know.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

# Make sibling modules (paths, custom_api, …) importable whether this is run
# as `python -m generators.phrases` from tools/python or imported by a CLI in
# tools/.
_THIS_DIR = Path(__file__).resolve().parent
_PY_DIR = _THIS_DIR.parent
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from paths import (  # noqa: E402
    ANALYSIS_DIR,
    CURATED_OUTPUTS_DIR,
    LYRICS_OUTPUTS_DIR,
    PANNS_OUTPUTS_DIR,
    PATTERN_OUTPUTS_DIR,
    SPAN_OUTPUTS_DIR,
    safe_segment,
)

# The five families and the output_kind each one emits. The kind drives which
# AnnotationLayer type the importer creates and which validator the (optional)
# round-trip check applies. "lyrics" is a new kind added for these products;
# the others reuse the existing custom-detector kinds.
FAMILY_KINDS: dict[str, str] = {
    "phrases": "boundary",
    "instruments": "span",
    "cues": "cue",
    "drum-pattern": "pattern",
    "lyrics": "lyrics",
}


# ─── Envelope ─────────────────────────────────────────────────────────────────


def build_envelope(
    family: str,
    slug: str,
    *,
    items: list[dict],
    duration_ms: int,
    generator: str,
    errors: Optional[list[dict]] = None,
    fatal: Optional[dict] = None,
) -> dict:
    """Assemble the standard result envelope for one (family, slug).

    `items` are already-serialized dicts in the per-kind shape (the same
    shapes custom_runner emits). `generator` is a human-readable id of the
    producer (e.g. "phrases@allin1+grid") recorded for provenance.
    """
    if family not in FAMILY_KINDS:
        raise ValueError(f"unknown family {family!r}; expected one of {sorted(FAMILY_KINDS)}")
    errs = errors or []
    return {
        "name": family,
        "slug": slug,
        "family": family,
        "generator": generator,
        "output_kind": FAMILY_KINDS[family],
        "ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "duration_ms": int(duration_ms),
        "items": items,
        "errors": errs,
        "stats": {"accepted": len(items), "rejected": len(errs)},
        "fatal": fatal,
    }


def curated_path(family: str, slug: str) -> Path:
    """Where the curated envelope for (family, slug) lives on disk."""
    if family not in FAMILY_KINDS:
        raise ValueError(f"unknown family {family!r}")
    safe = (safe_segment(slug) or slug).replace("/", "_")
    return CURATED_OUTPUTS_DIR / family / f"{safe}.json"


def write_envelope(envelope: dict) -> Path:
    """Persist an envelope to its curated path. Returns the path written."""
    path = curated_path(envelope["family"], envelope["slug"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(envelope, indent=2))
    return path


# ─── Cache readers ────────────────────────────────────────────────────────────


def load_json(path: Path) -> Optional[dict]:
    """Read a JSON file, returning None on absence or parse error (never raises)."""
    try:
        if not path.is_file():
            return None
        return json.loads(path.read_text())
    except Exception:
        return None


def load_allin1(slug: str) -> Optional[dict]:
    """The cached All-In-One analysis for `slug` (sections + beat/downbeat grid)."""
    return load_json(ANALYSIS_DIR / slug / "allin1.json")


# Sidecar cache roots, keyed by the family the generator pulls from. The
# on-disk file name follows the sidecars' `cache_name(algo, stem)` convention:
# "<algo>__<stem>.json" for a per-stem run, "<algo>.json" for the full mix.
_FAMILY_DIR = {
    "span": SPAN_OUTPUTS_DIR,
    "panns": PANNS_OUTPUTS_DIR,
    "pattern": PATTERN_OUTPUTS_DIR,
    "lyrics": LYRICS_OUTPUTS_DIR,
}


def detect_cache(
    family: str,
    slug: str,
    algo: str,
    *,
    prefer_stems: tuple[Optional[str], ...] = (None,),
) -> tuple[Optional[dict], Optional[str]]:
    """Read a sidecar detect-cache for (family, slug, algo), trying each stem
    in `prefer_stems` order and returning the first present, ``ok`` result.

    `prefer_stems` entries are stem names ("vocals", "drums", "other", …) or
    None for the full mix. Returns (payload, stem_used) or (None, None).
    """
    base = _FAMILY_DIR.get(family)
    if base is None:
        return None, None
    for stem in prefer_stems:
        fname = f"{algo}__{stem}.json" if stem and stem != "mix" else f"{algo}.json"
        d = load_json(base / slug / fname)
        if d is not None and d.get("ok", True):
            return d, (stem or "mix")
    return None, None


# ─── Time conversion ──────────────────────────────────────────────────────────


def sec_to_ms(t: float, *, duration_ms: Optional[int] = None) -> int:
    """Seconds → clamped integer milliseconds."""
    ms = int(round(float(t) * 1000))
    if ms < 0:
        ms = 0
    if duration_ms is not None and ms > duration_ms:
        ms = duration_ms
    return ms


def merge_spans(
    spans: list[dict],
    *,
    gap_ms: int,
) -> list[dict]:
    """Merge same-label spans separated by <= gap_ms. Input/return dicts carry
    {start_ms, duration_ms, label, intensity}. Intensity of a merged span is
    the max of its parts. Spans must already be the curated Span shape."""
    by_label: dict[str, list[dict]] = {}
    for s in spans:
        by_label.setdefault(s.get("label") or "", []).append(s)
    out: list[dict] = []
    for label, group in by_label.items():
        group.sort(key=lambda x: x["start_ms"])
        cur = dict(group[0])
        for nxt in group[1:]:
            cur_end = cur["start_ms"] + cur["duration_ms"]
            if nxt["start_ms"] - cur_end <= gap_ms:
                new_end = max(cur_end, nxt["start_ms"] + nxt["duration_ms"])
                cur["duration_ms"] = new_end - cur["start_ms"]
                ci, ni = cur.get("intensity"), nxt.get("intensity")
                cur["intensity"] = max([v for v in (ci, ni) if v is not None], default=None)
            else:
                out.append(cur)
                cur = dict(nxt)
        out.append(cur)
    out.sort(key=lambda x: (x["start_ms"], x["duration_ms"]))
    return out


# ─── Misc ─────────────────────────────────────────────────────────────────────


def dedupe_sorted_ms(times_ms: Iterable[int], *, min_gap_ms: int = 1) -> list[int]:
    """Sort and drop near-duplicate timestamps closer than `min_gap_ms`."""
    out: list[int] = []
    for t in sorted(int(x) for x in times_ms):
        if not out or t - out[-1] >= min_gap_ms:
            out.append(t)
    return out


def near(value: int, anchors: Iterable[int], tol_ms: int) -> bool:
    """True if `value` is within `tol_ms` of any anchor."""
    return any(abs(value - a) <= tol_ms for a in anchors)


def to_dataclasses(envelope: dict) -> list:
    """Convert an envelope's serialized items back into the custom_api output
    dataclasses, so a first-party registry stub can re-emit a generator's
    result through the sandboxed custom-detector runner (which re-validates
    and re-serializes them). Returns [] for the "lyrics" kind, which the
    custom-detector framework doesn't carry yet.
    """
    from custom_api import Boundary, Cue, Pattern, Span  # local import: avoids a cycle

    kind = envelope.get("output_kind")
    items = envelope.get("items") or []
    if kind == "boundary":
        return [Boundary(time_ms=i["time_ms"], label=i.get("label"),
                         importance=i.get("importance"), candidates=i.get("candidates"))
                for i in items]
    if kind == "cue":
        return [Cue(time_ms=i["time_ms"], label=i.get("label"),
                    description=i.get("description"), intensity=i.get("intensity"),
                    candidates=i.get("candidates"))
                for i in items]
    if kind == "span":
        return [Span(start_ms=i["start_ms"], duration_ms=i["duration_ms"],
                     label=i.get("label"), intensity=i.get("intensity"))
                for i in items]
    if kind == "pattern":
        return [Pattern(start_ms=i["start_ms"], duration_ms=i["duration_ms"],
                        label=i.get("label"), repeat_count=i.get("repeat_count", 1),
                        highlighted_beats=i.get("highlighted_beats"))
                for i in items]
    return []


def missing_inputs_fatal(family: str, slug: str, *, hint: str) -> dict:
    """A consistent 'no upstream cache yet' envelope so run_generators reports
    SKIPPED instead of erroring. `hint` names what to run first."""
    return build_envelope(
        family, slug, items=[], duration_ms=0,
        generator=f"{family}@(no-input)",
        fatal={"type": "FileNotFoundError", "message": hint, "traceback": ""},
    )


__all__ = [
    "FAMILY_KINDS",
    "build_envelope",
    "curated_path",
    "write_envelope",
    "load_json",
    "load_allin1",
    "detect_cache",
    "sec_to_ms",
    "merge_spans",
    "dedupe_sorted_ms",
    "near",
    "to_dataclasses",
    "missing_inputs_fatal",
]
