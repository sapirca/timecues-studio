"""Run a custom detector against a song and persist the validated result.

Workflow per call to `run(name, slug)`:

  1. Resolve the audio file for `slug` (mirrors bpm_server._find_audio).
  2. Build a DetectionContext (audio, features, energy/tension, beats, stems).
  3. Re-import the detector via custom_loader.load_detector (so user edits
     take effect immediately).
  4. Call detect(ctx) inside try/except. On exception → result envelope with
     a single fatal error and zero items.
  5. Validate the returned list per-item. Bad items are dropped; per-item
     errors are accumulated in the envelope.
  6. Write the envelope to:
        algorithm-mode  →  data/algorithm-outputs/custom/<name>/<slug>.json
        annotation-mode →  the algorithm-mode file IS the source of truth for
                           the seed; per-annotator edits live in
                           data/annotations/custom/<name>/<annotator>/<slug>.json
                           and are written by the web app, not by this runner.

The envelope is the same shape regardless of output_kind, so the frontend
only needs one parser:

    {
      "name": "custom_1",
      "slug": "...",
      "output_kind": "boundary" | "cue" | "span" | "loop" | "riff" | "lyrics",
      "ran_at": "ISO-8601",
      "duration_ms": int,
      "items": [
        {time_ms, ...}                               # boundary | cue
                                                     #   (cue may add velocity, level_db, note, decay_ms, importance;
                                                     #    boundary/cue/span/loop may all add color)
        | {start_ms, duration_ms, label, intensity, description?, pulse?}  # span
        | {start_ms, duration_ms, label, snap_zero_cross}            # loop
        | {start, end, label, sequence, repeatCount, occurrences?}   # riff: seconds, as stored
        | {time_ms, end_ms, text, kind, onsets?, envelope?}  # lyrics
      ],
      # riff only: the lane's node library, as a Riff Patterns layer stores it
      "nodes": [ {id, name, color?, stepsPerCycle, subbeatsPerBeat, segments, names?} ],
      "combos": [ {id, name, color?, sequence} ], "drum"?: str, "summary"?: str,
      "errors": [ {index, field, value, message}, ... ],
      "notes":  [ {code, message}, ... ],     # caveats; the run still succeeded
      "stats": { "accepted": int, "rejected": int },
      "fatal": null | { "type": str, "message": str, "traceback": str }
    }
"""

from __future__ import annotations

import json
import math
import multiprocessing as mp
import os
import re
import signal
import sys
import threading
import time
import traceback
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np

try:
    import resource  # POSIX-only; falls back to in-process call on Windows.
except ImportError:
    resource = None  # type: ignore[assignment]

# Make sibling modules importable when this file is run from repo root.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from custom_api import (  # noqa: E402
    Boundary,
    Cue,
    DEFAULT_STRICTNESS,
    LANE_KINDS,
    DetectionContext,
    Loop,
    Lyrics,
    PULSE_RATES,
    RIFF_EVENTS,
    RIFF_PULSES,
    RIFF_SILENCE,
    Riff,
    RiffEntry,
    RiffNote,
    Span,
    ValidationError,
    _safe_repr,
    strictness_level,
)
from custom_loader import load_detector, missing_module_hint  # noqa: E402
from server_common import cached_result  # noqa: E402
from paths import (  # noqa: E402
    CUSTOM_RESULTS_DIR,
    DEFAULT_CUSTOM_RESULTS_DIR,
    REPO_ROOT,
    SONGS_DIR,
    find_audio,
)

# Optional deps live behind narrow try/excepts so the server can still start
# (and report load errors) on a machine that doesn't have librosa installed.
try:
    import librosa  # noqa: F401
    from shared.audio_loader import load_audio
    from shared.models import AudioData
    from shared.feature_extractor import (
        compute_energy_curve,
        compute_tension_curve,
        extract_features,
    )
    _AUDIO_OK = True
    _AUDIO_ERR = None
except Exception as exc:  # pragma: no cover - exercised only on broken installs
    _AUDIO_OK = False
    _AUDIO_ERR = f"{type(exc).__name__}: {exc}"


# Stems live inside web-app/public/stems/<slug>/manifest.json on this repo.
# Kept here as a runner concern (not in paths.py) because the web app owns
# the canonical layout.
_STEMS_ROOT = REPO_ROOT / "web-app" / "public" / "stems"
_AUDIO_EXTS = (".mp3", ".wav", ".flac", ".ogg", ".m4a")


# ─── Public API ──────────────────────────────────────────────────────────────


def _check_strictness(strictness) -> Optional[int]:
    """The annotator's 0-100 for a detector that declares `strictness = True`,
    or None when no setting was asked for. Raises ValueError on a bad one."""
    return None if strictness is None else strictness_level(strictness)


def _apply_strictness(detector, ctx: DetectionContext, envelope: dict,
                      strictness: Optional[int]) -> DetectionContext:
    """Hand a detector that offers a strictness the annotator's setting, and
    record it on the envelope so the UI can say which one it shows. Any other
    detector runs as it always has, and its envelope says nothing."""
    if getattr(detector, "strictness", False) is not True:
        return ctx
    level = DEFAULT_STRICTNESS if strictness is None else strictness
    envelope["strictness"] = level
    return replace(ctx, strictness=level)


def _check_drum_source(drum_source) -> Optional[str]:
    """The annotator's drum source for a detector that declares
    `drum_source = True`, or None when none was asked for. Raises ValueError
    on a bad one."""
    try:
        from generators.drum_hits import DRUM_SOURCES
    except ImportError:  # public bundle: no private drum readers
        DRUM_SOURCES = ("auto", "kit", "bands")

    if drum_source is None or drum_source == "":
        return None
    if drum_source not in DRUM_SOURCES:
        raise ValueError(f"drum_source must be one of {', '.join(DRUM_SOURCES)}")
    return drum_source


def _apply_drum_source(detector, ctx: DetectionContext, envelope: dict,
                       drum_source: Optional[str]) -> DetectionContext:
    """As `_apply_strictness`, for where the drums are read from."""
    if getattr(detector, "drum_source", False) is not True:
        return ctx
    source = drum_source or "auto"
    envelope["drum_source"] = source
    return replace(ctx, drum_source=source)


SECTION_SOURCES = ("auto", "annotated", "allin1")


def _check_section_source(section_source) -> Optional[str]:
    """As `_check_drum_source`, for where the sections are read from."""
    if section_source is None or section_source == "":
        return None
    if section_source not in SECTION_SOURCES:
        raise ValueError(f"section_source must be one of {', '.join(SECTION_SOURCES)}")
    return section_source


def _apply_section_source(detector, ctx: DetectionContext, envelope: dict,
                          section_source: Optional[str], annotator: Optional[str]) -> DetectionContext:
    """As `_apply_drum_source`, for where the sections are read from. The
    annotator rides along: "annotated" means THEIR boundaries layer. A
    `reads_layers` detector is handed the annotator too — whose layers it reads."""
    if getattr(detector, "reads_layers", False) is True:
        ctx = replace(ctx, annotator=annotator or None)
    if getattr(detector, "section_source", False) is not True:
        return ctx
    source = section_source or "auto"
    envelope["section_source"] = source
    return replace(ctx, section_source=source, annotator=annotator or None)


def _on_switches(envelope: Optional[dict]) -> set[str]:
    """The switches a saved result was read with ticked."""
    return {k for k, v in ((envelope or {}).get("switches") or {}).items() if v is True}


def _apply_switches(detector, ctx: DetectionContext, envelope: dict,
                    switches: Optional[set[str]], previous: Optional[dict]) -> DetectionContext:
    """Tick the switches the detector declares that were asked for; with none
    asked for, the ones the song's last result had — a switch is a fact about
    the song, so a run that does not mention it must not quietly untick it.
    Names the detector does not declare are ignored."""
    declared = getattr(detector, "switches", None) or {}
    if not declared:
        return ctx
    on = _on_switches(previous) if switches is None else switches
    state = {k: k in on for k in declared}
    envelope["switches"] = state
    return replace(ctx, switches=state)


def _apply_source(detector, ctx: DetectionContext, envelope: dict,
                  source: Optional[str]) -> DetectionContext:
    """Hand a `sources` detector the annotator's pick — its first source when
    none was asked for — and record it on the envelope. A name the detector
    does not offer is refused, before anything runs."""
    offered = list(getattr(detector, "sources", None) or {})
    if not offered:
        return ctx
    source = source or offered[0]
    one_lane = bool(getattr(detector, "lane_sources", None)) and source.startswith("lane:") \
        and len(source) > len("lane:")
    if source not in offered and not one_lane:
        raise ValueError(f"source must be one of {', '.join(offered)}"
                         + (", or lane:<layer id>" if getattr(detector, "lane_sources", None) else ""))
    envelope["source"] = source
    return replace(ctx, source=source)


def _detect(detector, ctx) -> dict:
    """detect(), and what came back with it: the notes `ctx.warn()` recorded
    and, when the run read drums, which (`drum_hits.reading`) — the saved run
    is the only place that says which kit run a lane was read from. Likewise
    the sections a `section_source` detector read."""
    try:
        from generators.drum_hits import reading
    except ImportError:  # public bundle: nothing reads drums, so nothing to record
        from contextlib import nullcontext

        def reading(_mode="auto"):
            return nullcontext({})

    with reading(getattr(ctx, "drum_source", "auto")) as drum_read:
        items = detector.detect(ctx)
    return {"items": items, "notes": list(getattr(ctx, "notes", [])), "drum_read": dict(drum_read),
            "section_read": dict(getattr(ctx, "section_read", None) or {}),
            "source_read": dict(getattr(ctx, "source_read", None) or {})}


def _cached_level(envelope: dict) -> Optional[int]:
    """The strictness a cached result was read at; a name from before the
    slider counts as its number, and no setting at all as Normal."""
    try:
        return strictness_level(envelope.get("strictness"))
    except ValueError:
        return None


def _apply_stem(detector, ctx: DetectionContext) -> DetectionContext:
    """Tell the run which stem it is for. A detector declaring several stems
    is loaded once per stem with that one stem on the instance (see
    custom_loader._per_stem); "mix", "stems" (several, read into one lane) and
    no stem are all runs for no single stem."""
    stem = getattr(detector, "stem", None)
    return replace(ctx, stem=stem if isinstance(stem, str) and stem not in ("mix", "stems") else None)


def run(name: str, slug: str, *, force: bool = False, strictness=None,
        drum_source=None, section_source=None, annotator=None, switches=None,
        source=None) -> dict:
    """Run detector `name` on song `slug`, persist, return the envelope.

    `strictness` is the annotator's 0 (Strict) … 100 (Loose), or one of the
    names, for a detector that offers it. The song keeps one result per
    detector, so a cached result read at another strictness is a miss, and the
    new run replaces it. `drum_source` ("auto" | "kit" | "bands") likewise,
    for a detector that declares `drum_source = True`, and `section_source`
    ("auto" | "annotated" | "allin1") for one that declares
    `section_source = True`; `annotator` is whose boundaries "annotated" reads.
    `switches` is the names ticked of those the detector declares; None keeps
    the ones the song's last result had. `source` is where a detector that
    declares `sources` reads from (its first source when None).
    """
    switches = None if switches is None else {str(s) for s in switches}
    strictness = _check_strictness(strictness)
    drum_source = _check_drum_source(drum_source)
    section_source = _check_section_source(section_source)
    cache_path = result_path(name, slug)
    hit = cached_result(cache_path, force, failed=lambda env: bool(env.get("fatal")))
    if hit is not None and (strictness is None
                            or _cached_level(hit) == strictness) and (
            drum_source is None or hit.get("drum_source", "auto") == drum_source) and (
            section_source is None or hit.get("section_source", "auto") == section_source) and (
            not source or hit.get("source") == source) and (
            switches is None or _on_switches(hit) == switches):
        return hit

    envelope = _empty_envelope(name, slug)

    if not has_user_grid(slug):
        # Not a result: nothing is saved, so the song's last one stays.
        envelope["fatal"] = _no_grid_fatal()
        return envelope

    if not _AUDIO_OK:
        envelope["fatal"] = {
            "type": "ImportError",
            "message": f"audio stack unavailable: {_AUDIO_ERR}",
            "traceback": "",
        }
        _persist(envelope, cache_path)
        return envelope

    audio_path = _find_audio(slug)
    if audio_path is None:
        envelope["fatal"] = {
            "type": "FileNotFoundError",
            "message": f"no audio file found under {SONGS_DIR}/{slug}/",
            "traceback": "",
        }
        _persist(envelope, cache_path)
        return envelope

    # Load the detector class. A failure here is reported in the envelope
    # rather than re-raised so the UI can render it the same way as run-time
    # errors.
    try:
        detector = load_detector(name)
    except Exception as exc:
        envelope["fatal"] = _build_fatal(exc, str(exc))
        _persist(envelope, cache_path)
        return envelope

    envelope["output_kind"] = detector.output_kind

    try:
        ctx = _build_context(audio_path, slug)
    except NoGridError:
        envelope["fatal"] = _no_grid_fatal()
        return envelope
    except Exception as exc:
        envelope["fatal"] = _build_fatal(exc, f"failed to build DetectionContext: {exc}")
        _persist(envelope, cache_path)
        return envelope
    ctx = _apply_stem(detector, _apply_drum_source(
        detector, _apply_strictness(detector, ctx, envelope, strictness), envelope, drum_source))
    ctx = _apply_section_source(detector, ctx, envelope, section_source, annotator)
    try:
        ctx = _apply_source(detector, ctx, envelope, source)
    except ValueError as exc:
        # A bad request, not a result: the song's saved one stays.
        envelope["fatal"] = _build_fatal(exc, str(exc))
        return envelope
    ctx = _apply_switches(detector, ctx, envelope, switches, get_cached(name, slug))

    envelope["duration_ms"] = ctx.duration_ms

    # The actual user code call. Run it in a forked child with memory + CPU
    # rlimits and a wall-clock timeout so an honest mistake (runaway loop,
    # large allocation, native-code crash) is contained instead of killing
    # the sidecar. See _run_detect_isolated().
    kind, payload = _run_detect_isolated(detector, ctx)
    if kind == "ok":
        # A bare list is the pre-notes shape; still accepted so a caller that
        # drives _run_detect_isolated directly is not broken by this.
        if isinstance(payload, dict):
            raw_items = payload.get("items")
            envelope["notes"] = list(payload.get("notes") or [])
            if payload.get("drum_read"):
                envelope["drum_read"] = payload["drum_read"]
            if payload.get("section_read"):
                envelope["section_read"] = payload["section_read"]
            if payload.get("source_read"):
                envelope["source_read"] = payload["source_read"]
        else:
            raw_items = payload
    else:
        envelope["fatal"] = _fatal_from_isolation(kind, payload)
        _persist(envelope, cache_path)
        return envelope

    if detector.output_kind == "lanes":
        lanes, errors = _validate_lanes(raw_items, ctx.duration_ms)
        envelope["lanes"] = lanes
        items: list[dict] = []
        accepted = sum(len(lane["items"]) for lane in lanes)
    elif detector.output_kind == "riff":
        riff, errors = _validate_riff(raw_items, ctx.duration_ms)
        items = riff.pop("items")
        envelope.update(riff)
        accepted = len(items)
    else:
        items, errors = _validate_items(raw_items, detector.output_kind, ctx.duration_ms)
        accepted = len(items)
    envelope["items"]  = items
    envelope["errors"] = [e.to_dict() for e in errors]
    envelope["stats"]  = {"accepted": accepted, "rejected": len(errors)}

    _persist(envelope, cache_path)
    return envelope


_LANE_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")


def _validate_lanes(raw: Any, duration_ms: int) -> tuple[list[dict], list[ValidationError]]:
    """A "lanes" detector's return value → [{id, label, output_kind, group,
    items}], each lane's items validated as its own kind's are. A malformed
    lane is dropped whole with one error; a bad item in a good lane is dropped
    alone, its error's field naming the lane (`kick_notes.items[3]`)."""
    if not isinstance(raw, list):
        return [], [ValidationError(
            index=None, field="<return>", value=_safe_repr(raw),
            message=f"detect() must return a list of Lane, got {type(raw).__name__}.")]
    lanes: list[dict] = []
    errors: list[ValidationError] = []
    seen: set[str] = set()
    for i, lane in enumerate(raw):
        get = (lane.get if isinstance(lane, dict) else lambda k, d=None: getattr(lane, k, d))
        lane_id, label, kind = get("id"), get("label"), get("output_kind")
        group, lane_items = get("group"), get("items")
        problem = None
        if not isinstance(lane_id, str) or not _LANE_ID_RE.match(lane_id):
            problem = ("id", lane_id, "must match ^[a-z][a-z0-9_-]{0,30}$.")
        elif lane_id in seen:
            problem = ("id", lane_id, "is used by an earlier lane; lane ids must be unique.")
        elif not isinstance(label, str) or not label.strip() or len(label) > 80:
            problem = ("label", label, "must be a non-empty string of at most 80 characters.")
        elif kind not in LANE_KINDS:
            problem = ("output_kind", kind, f"must be one of {list(LANE_KINDS)}.")
        elif group is not None and (not isinstance(group, str) or not group.strip()):
            problem = ("group", group, "must be a non-empty string, or omitted.")
        if problem:
            errors.append(ValidationError(index=i, field=f"lanes[{i}].{problem[0]}",
                                          value=_safe_repr(problem[1]), message=problem[2]))
            continue
        seen.add(lane_id)
        riff: dict = {}
        if kind == "riff":
            riff, item_errors = _validate_riff(lane_items, duration_ms)
            items = riff.pop("items")
        else:
            items, item_errors = _validate_items(lane_items, kind, duration_ms)
        for e in item_errors:
            e.field = f"{lane_id}.items[{e.index}].{e.field}" if e.index is not None \
                else f"{lane_id}.{e.field}"
        errors.extend(item_errors)
        lanes.append({"id": lane_id, "label": label.strip(), "output_kind": kind,
                      "group": group.strip()[:40] if isinstance(group, str) else None,
                      "items": items, **riff})
    return lanes, errors


def measure(name: str, slug: str, body) -> dict:
    """Ask detector `name` about what the annotator sent for song `slug` — the
    words of one lyrics lane, say — through its own `measure(slug, body)`. A
    question about the annotator's items, not a run: nothing is cached, and
    the detector reads only the files it needs. A ValueError is the detector
    saying what is missing (no stem, a bad body) and goes back as the message.
    """
    detector = load_detector(name)
    fn = getattr(detector, "measure", None)
    if not callable(fn):
        raise ValueError(f"{name} does not measure anything you send it")
    out = fn(slug, body)
    if not isinstance(out, dict):
        raise TypeError(f"{name}.measure must return a dict, got {type(out).__name__}")
    return out


def run_window(name: str, slug: str, start_ms: int, end_ms: int,
               stems: Optional[list[str]] = None, strictness=None) -> dict:
    """Run detector `name` on only `[start_ms, end_ms)` of song `slug`.

    The detector is handed a context cut to the range (see
    DetectionContext.window_start_ms), so it hears nothing outside it — its
    thresholds, loudest-hit scale and beat tracking are the range's own. The
    items come back in song time. Nothing is persisted: the song's cached
    output is whole-song by definition, and a range's answer is only a
    proposal until the annotator merges it into, or swaps it for, the part of
    their lane it covers.

    Only detectors that declare `windowable = True` run; any other one reads
    whole-song data off disk and could not honour the range.

    `stems` narrows a detector that declares `stem_parts` to the parts those
    stems carry (ctx.window_stems). The run then records the parts' label
    prefixes under `window.parts`, so a Replace removes only those parts'
    items and leaves the others' alone. Ignored for any other detector.

    `strictness` as for `run`. The drum source is the lane's own: a range is
    read as the lane it is folded into was.
    """
    strictness = _check_strictness(strictness)
    envelope = _empty_envelope(name, slug)
    envelope["window"] = {"start_ms": int(start_ms), "end_ms": int(end_ms)}

    if not has_user_grid(slug):
        envelope["fatal"] = _no_grid_fatal()
        return envelope
    if not _AUDIO_OK:
        envelope["fatal"] = {"type": "ImportError", "message": f"audio stack unavailable: {_AUDIO_ERR}", "traceback": ""}
        return envelope
    audio_path = _find_audio(slug)
    if audio_path is None:
        envelope["fatal"] = {"type": "FileNotFoundError",
                             "message": f"no audio file found under {SONGS_DIR}/{slug}/", "traceback": ""}
        return envelope
    try:
        detector = load_detector(name)
    except Exception as exc:
        envelope["fatal"] = _build_fatal(exc, str(exc))
        return envelope
    envelope["output_kind"] = detector.output_kind
    if getattr(detector, "windowable", False) is not True:
        envelope["fatal"] = {
            "type": "NotWindowable",
            "message": (f"{name} reads whole-song data from disk, so it cannot be run on a range. "
                        "Run it on the whole song, or set windowable = True once detect() reads "
                        "only its context."),
            "traceback": "",
        }
        return envelope

    stem_parts = getattr(detector, "stem_parts", None) or None
    run_stems: Optional[list[str]] = None
    if stems and stem_parts:
        run_stems = [s for s in stem_parts if s in stems]
        if not run_stems:
            envelope["fatal"] = {
                "type": "NoSuchPart",
                "message": (f"{name} reads no part from {', '.join(stems)} — it reads "
                            f"{', '.join(stem_parts)}."),
                "traceback": "",
            }
            return envelope
        envelope["window"]["stems"] = run_stems
        envelope["window"]["parts"] = [p for s in run_stems for p in stem_parts[s]]

    # The detector hears a short lead-in before the range. Cut audio starts
    # from silence, and to an onset detector that jump IS an attack: without
    # the lead-in every window run reports a hit at its first millisecond, and
    # dropping that hit would also drop the real downbeat a snapped range
    # usually starts on. The lead-in only sets the stage; nothing found in it
    # is kept.
    lead_ms = min(int(start_ms), _WINDOW_LEAD_MS)
    try:
        ctx = _build_context(audio_path, slug, window=(int(start_ms) - lead_ms, int(end_ms)),
                             lead_ms=lead_ms, window_stems=run_stems)
    except Exception as exc:
        envelope["fatal"] = _build_fatal(exc, f"failed to build DetectionContext: {exc}")
        return envelope
    ctx = _apply_stem(detector, _apply_drum_source(
        detector, _apply_strictness(detector, ctx, envelope, strictness), envelope,
        (get_cached(name, slug) or {}).get("drum_source")))
    ctx = _apply_switches(detector, ctx, envelope, None, get_cached(name, slug))
    envelope["duration_ms"] = ctx.duration_ms

    kind, payload = _run_detect_isolated(detector, ctx)
    if kind != "ok":
        envelope["fatal"] = _fatal_from_isolation(kind, payload)
        return envelope
    raw_items = payload.get("items") if isinstance(payload, dict) else payload
    if isinstance(payload, dict):
        envelope["notes"] = list(payload.get("notes") or [])
    if run_stems is not None:
        envelope["notes"].insert(0, {
            "code": "window-parts",
            "message": (f"Read only {', '.join(envelope['window']['parts'])} "
                        f"(from {', '.join(run_stems)}). Replace removes only those parts' "
                        f"items here; every other part stays."),
        })
    envelope["notes"].insert(0, {
        "code": "window",
        "message": (f"Heard only {_clock(start_ms)}–{_clock(end_ms)}"
                    + (f", plus {lead_ms / 1000:g} s before it so the cut is not heard as a hit"
                       if lead_ms else "")
                    + ". Anything scaled to the loudest or the most (velocity, level, "
                    "thresholds) is scaled to this range, not the song."),
    })

    # Validated against the range, where the detector's times live, then moved.
    offset = ctx.window_start_ms or 0

    def in_song(items: list[dict]) -> list[dict]:
        shifted = [_shift_item(it, offset) for it in items]
        return [it for it in shifted if _item_at(it) >= start_ms]

    if detector.output_kind == "lanes":
        # Each lane is moved and trimmed as a detector of its kind would be.
        lanes, errors = _validate_lanes(raw_items, ctx.duration_ms)
        for lane in lanes:
            lane["items"] = in_song(lane["items"])
        envelope["lanes"] = lanes
        kept: list[dict] = []
        accepted = sum(len(lane["items"]) for lane in lanes)
    elif detector.output_kind == "riff":
        riff, errors = _validate_riff(raw_items, ctx.duration_ms)
        kept = in_song(riff.pop("items"))
        envelope.update(riff)
        accepted = len(kept)
    else:
        items, errors = _validate_items(raw_items, detector.output_kind, ctx.duration_ms)
        kept = in_song(items)
        accepted = len(kept)
    envelope["items"] = kept
    envelope["errors"] = [e.to_dict() for e in errors]
    envelope["stats"] = {"accepted": accepted, "rejected": len(errors)}
    return envelope


_WINDOW_LEAD_MS = 1000


def _item_at(item: dict) -> int:
    """Where an item begins in the song."""
    if "sequence" in item:          # a riff item: seconds, as stored
        return int(round(float(item.get("start") or 0) * 1000))
    t = item.get("time_ms", item.get("start_ms"))
    return int(t) if isinstance(t, (int, float)) else 0


def _clock(ms: int) -> str:
    total = max(0, int(ms)) / 1000
    return f"{int(total // 60)}:{total % 60:04.1f}"


# Item fields that are instants in the song. Lengths (duration_ms, decay_ms)
# are not, and stay as they are.
_INSTANT_KEYS = ("time_ms", "start_ms", "end_ms")
# A lyric word's envelope, in the order its times must run.
_ENVELOPE_KEYS = ("start_ms", "peak_ms", "decay_end_ms", "release_ms", "end_ms")


def _shift_item(item: dict, offset_ms: int) -> dict:
    """Move one validated item from range-local time into song time."""
    if not offset_ms:
        return item
    out = dict(item)
    if "sequence" in out:           # a riff item: seconds, as stored
        for key in ("start", "end"):
            out[key] = round(float(out[key]) + offset_ms / 1000, 3)
        return out
    for key in _INSTANT_KEYS:
        if isinstance(out.get(key), (int, float)):
            out[key] = int(out[key]) + offset_ms
    if isinstance(out.get("candidates"), list):
        out["candidates"] = [int(t) + offset_ms for t in out["candidates"]]
    if isinstance(out.get("onsets"), list):
        out["onsets"] = [
            {**o, "time_ms": int(o["time_ms"]) + offset_ms}
            if isinstance(o, dict) and isinstance(o.get("time_ms"), (int, float)) else o
            for o in out["onsets"]
        ]
    if isinstance(out.get("envelope"), dict):
        out["envelope"] = {k: int(v) + offset_ms if k in _ENVELOPE_KEYS else v
                           for k, v in out["envelope"].items()}
    return out


# Two items with the same label this close together are the same event heard
# twice. A window run re-detects what the whole-song run already found, and
# its onsets land a few ms off (a different analysis frame phase); without a
# tolerance a Merge would double every hit in the range.
MERGE_SAME_MS = 20


def primary_ms(item: dict, output_kind: str) -> int:
    """The time an item is keyed and sorted by — mirrors the web app's review
    key (`${index}:${primaryMs}`): time_ms for boundaries, cues and lyrics,
    start_ms for spans and loops, and a riff item's start (seconds) in ms."""
    if output_kind == "riff":
        return _item_at(item)
    key = "time_ms" if output_kind in ("boundary", "cue", "lyrics") else "start_ms"
    v = item.get(key)
    return int(v) if isinstance(v, (int, float)) else 0


def merge_window_items(
    base: list[dict],
    incoming: list[dict],
    start_ms: int,
    end_ms: int,
    mode: str,
    output_kind: str,
    parts: Optional[list[str]] = None,
) -> tuple[list[dict], dict[int, int], dict]:
    """Fold a window run's items into a lane's items.

    mode "replace": every existing item that starts inside [start_ms, end_ms)
    goes, and the window run's items take its place.
    mode "merge": every existing item stays; a window item joins unless an
    existing one with the same label starts within MERGE_SAME_MS of it.

    `parts` (label prefixes, from a run narrowed to some stems) limits both
    to the items of those parts: an item of any other part is never removed,
    and never counted as the same event as an incoming one.

    Items outside the window are never touched, and an existing span that
    starts before the window stays even if it runs into it. Returns the new
    item list sorted by time, a map from each base index to its item's new
    index — survivors, plus replaced items heard again as the same event — so
    review decisions can follow their item, and counts.
    """
    if mode not in ("merge", "replace"):
        raise ValueError(f"mode must be 'merge' or 'replace', not {mode!r}")

    def inside(it: dict) -> bool:
        return (start_ms <= primary_ms(it, output_kind) < end_ms
                and (parts is None or item_in_parts(it, parts)))

    kept = [(i, it) for i, it in enumerate(base) if not (mode == "replace" and inside(it))]
    removed = len(base) - len(kept)
    added: list[dict] = []
    duplicates = 0
    for it in incoming:
        if not inside(it):
            continue
        if mode == "merge":
            t, label = primary_ms(it, output_kind), it.get("label")
            if any(inside(b) and b.get("label") == label
                   and abs(primary_ms(b, output_kind) - t) <= MERGE_SAME_MS for _, b in kept):
                duplicates += 1
                continue
        added.append(it)

    # On Replace, a new item that is the same event as one it replaced takes
    # over that item's place in the remap, so a ✓/✗ already given to the hit
    # is not lost just because it was heard again.
    replaced = [(i, it) for i, it in enumerate(base) if mode == "replace" and inside(it)]
    heir: dict[int, int] = {}
    for j, it in enumerate(added):
        t, label = primary_ms(it, output_kind), it.get("label")
        for i, b in replaced:
            if (i not in heir.values() and b.get("label") == label
                    and abs(primary_ms(b, output_kind) - t) <= MERGE_SAME_MS):
                heir[j] = i
                break

    rows = [(primary_ms(it, output_kind), 0, i, it) for i, it in kept]
    rows += [(primary_ms(it, output_kind), 1, heir.get(j, -1), it) for j, it in enumerate(added)]
    rows.sort(key=lambda r: (r[0], r[1]))
    remap = {old: new for new, (_, _, old, _) in enumerate(rows) if old >= 0}
    stats = {"added": len(added), "removed": removed, "duplicates": duplicates}
    return [r[3] for r in rows], remap, stats


def item_in_parts(item: dict, parts: list[str]) -> bool:
    """Whether `item`'s label names one of `parts`: it is the prefix, or
    continues after it with " · " — so "Bass" is not "Bassline"."""
    label = str(item.get("label") or "")
    return any(label == p or label.startswith(f"{p} · ") for p in parts)


def remap_review(review: dict, base: list[dict], merged: list[dict],
                 remap: dict[int, int], output_kind: str) -> dict:
    """Carry `${index}:${ms}` review decisions over to the items' new indices
    (and times, for a replaced item's heir). A decision whose item was
    replaced away with no heir is dropped with it."""
    out: dict = {}
    for old, new in remap.items():
        key = f"{old}:{primary_ms(base[old], output_kind)}"
        if key in review:
            out[f"{new}:{primary_ms(merged[new], output_kind)}"] = review[key]
    return out


def merge_window(
    name: str,
    slug: str,
    start_ms: int,
    end_ms: int,
    items: list,
    mode: str,
    parts: Optional[list[str]] = None,
    lanes: Optional[list[dict]] = None,
    riff: Optional[dict] = None,
) -> dict:
    """Write a window run's items into the song's cached output for `name`.

    `items` must be run_window()'s own validated output — the server holds it
    between the run and this call rather than taking it back from the client.
    For a "lanes" detector that output is `lanes` instead (and `items` is
    empty): each lane is folded into the cached lane of the same id, exactly
    as a single-kind detector's items are, and a cached lane the run did not
    return is left as it was. A "riff" output's node library (`riff`: its
    nodes and combos) joins the cached one.

    The cached output stays the lane's single source of truth, so the merged
    lane is what every later reader sees. It records each window folded into
    it under `window_runs` — it is no longer one whole-song run, and says so.
    """
    detector = load_detector(name)
    kind = detector.output_kind
    envelope = get_cached(name, slug)
    if not envelope or envelope.get("fatal") or envelope.get("output_kind") != kind:
        envelope = _empty_envelope(name, slug)
        envelope["output_kind"] = kind
    if not envelope.get("duration_ms"):
        audio_path = _find_audio(slug)
        if audio_path is not None:
            envelope["duration_ms"] = int(librosa.get_duration(path=str(audio_path)) * 1000)

    if kind == "lanes":
        merged_lanes, stats = merge_window_lanes(
            list(envelope.get("lanes") or []), list(lanes or []), start_ms, end_ms, mode)
        envelope["lanes"] = merged_lanes
        envelope["items"] = []
        envelope["stats"] = {"accepted": sum(len(l["items"]) for l in merged_lanes), "rejected": 0}
        envelope.setdefault("window_runs", []).append({
            "start_ms": int(start_ms), "end_ms": int(end_ms), "mode": mode,
            "ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **stats,
        })
        _persist(envelope, result_path(name, slug))
        return {"envelope": envelope, "base": [], "remap": {}, "stats": stats}

    base = list(envelope.get("items") or [])
    merged, remap, stats = merge_window_items(base, items, start_ms, end_ms, mode, kind, parts)
    envelope["items"] = merged
    if kind == "riff":
        envelope.update(_riff_library(envelope, riff or {}))
    envelope["stats"] = {"accepted": len(merged), "rejected": 0}
    envelope.setdefault("window_runs", []).append({
        "start_ms": int(start_ms), "end_ms": int(end_ms), "mode": mode,
        **({"parts": list(parts)} if parts else {}),
        "ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **stats,
    })
    _persist(envelope, result_path(name, slug))
    return {"envelope": envelope, "base": base, "remap": remap, "stats": stats}


def merge_window_lanes(
    base: list[dict],
    incoming: list[dict],
    start_ms: int,
    end_ms: int,
    mode: str,
) -> tuple[list[dict], dict]:
    """Fold a window run's lanes into a "lanes" detector's cached lanes, each
    by `merge_window_items` into the cached lane with its id. A lane only the
    run has (the whole-song run found nothing for it) is added; a lane only
    the cache has is kept untouched. Lanes stay in the cached order, new ones
    after. Returns the lanes and the counts summed over them."""
    by_id = {lane["id"]: lane for lane in incoming}
    out: list[dict] = []
    stats = {"added": 0, "removed": 0, "duplicates": 0}
    for lane in base:
        new = by_id.pop(lane["id"], None)
        if new is None:
            out.append(lane)
            continue
        merged, _remap, s = merge_window_items(list(lane.get("items") or []), new["items"],
                                               start_ms, end_ms, mode, lane["output_kind"])
        out.append({**lane, "label": new["label"], "group": new.get("group"), "items": merged,
                    **(_riff_library(lane, new) if lane.get("output_kind") == "riff" else {})})
        for k in stats:
            stats[k] += s[k]
    for lane in incoming:
        if lane["id"] in by_id:
            merged, _remap, s = merge_window_items([], lane["items"], start_ms, end_ms,
                                                   mode, lane["output_kind"])
            out.append({**lane, "items": merged})
            for k in stats:
                stats[k] += s[k]
    return out, stats


def _riff_library(cached: dict, incoming: dict) -> dict:
    """A riff's nodes and combos after a window run: the cached ones, with
    the run's joining them by id (the run's own wins, being the newer read)."""
    out = {}
    for key in ("nodes", "combos"):
        by_id = {x["id"]: x for x in cached.get(key) or []}
        by_id.update({x["id"]: x for x in incoming.get(key) or []})
        out[key] = list(by_id.values())
    return out


def drop_lane(name: str, slug: str, lane_id: str) -> dict:
    """Delete one lane from a "lanes" detector's cached output for the song —
    the Voice lane of Sounds on a song whose singer sings real words — and
    keep the rest. Returns the new envelope.

    The cache is the lane's single source of truth, so the lane is gone for
    every later reader. A whole-song run reads the song afresh and brings it
    back, as it would any lane. Raises LookupError when the song has no cached
    "lanes" output or the output has no such lane."""
    envelope = get_cached(name, slug)
    if not envelope or envelope.get("fatal") or envelope.get("output_kind") != "lanes":
        raise LookupError(f"{name} has no lanes saved for this song")
    lanes = list(envelope.get("lanes") or [])
    kept = [lane for lane in lanes if lane.get("id") != lane_id]
    if len(kept) == len(lanes):
        raise LookupError(f"{name} has no lane '{lane_id}' on this song")
    envelope["lanes"] = kept
    envelope["stats"] = {"accepted": sum(len(l.get("items") or []) for l in kept), "rejected": 0}
    envelope.setdefault("dropped_lanes", []).append({
        "id": lane_id,
        "label": next(l.get("label") for l in lanes if l.get("id") == lane_id),
        "dropped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    _persist(envelope, result_path(name, slug))
    return envelope


def get_cached(name: str, slug: str) -> Optional[dict]:
    """Return the cached envelope or None. Never raises.

    Reads the writable cache first, then falls back to the read-only
    data-default seed shipped in the image — so the demo corpus's curated
    outputs render on a fresh data dir that has never run the detector."""
    safe = slug.replace("/", "_")
    for base in (CUSTOM_RESULTS_DIR, DEFAULT_CUSTOM_RESULTS_DIR):
        p = base / name / f"{safe}.json"
        if not p.exists():
            continue
        try:
            return json.loads(p.read_text())
        except Exception:
            return None
    return None


def lane_view(envelope: Optional[dict], lane: Optional[str]) -> Optional[dict]:
    """One lane of a saved "lanes" result, shaped as a single-kind result: its
    `output_kind` and `items` are the lane's. A result without lanes (any
    other detector's, or one saved before its detector had lanes) is returned
    as it is, so a reader keeps working across the change. A lanes result
    without that lane has no items."""
    if not envelope or lane is None or "lanes" not in envelope:
        return envelope
    for l in envelope.get("lanes") or []:
        if l.get("id") == lane:
            return {**envelope, "output_kind": l.get("output_kind"), "items": list(l.get("items") or [])}
    return {**envelope, "items": []}


def get_cached_lane(name: str, slug: str, lane: Optional[str]) -> Optional[dict]:
    """`get_cached`, then `lane_view`: what another detector reads when it
    reads one lane of this one's saved output (Pulse reads Drum hits' hits)."""
    return lane_view(get_cached(name, slug), lane)


def result_path(name: str, slug: str) -> Path:
    """Where the algorithm-mode envelope for `name`/`slug` is WRITTEN on disk
    (the writable cache; reads also consult the data-default seed — see
    get_cached)."""
    safe = slug.replace("/", "_")
    return CUSTOM_RESULTS_DIR / name / f"{safe}.json"


def drop_items(name: str, slug: str, indices: list[int]) -> tuple[dict, dict[int, int], list[dict]]:
    """Delete the items at `indices` from `name`'s cached output for the song —
    a part lane (Pulse's Kick) is the items of one part, cut from the one list
    the detector returned, so deleting it is deleting those items. Returns the
    envelope, the old→new index of every kept item and the items before, so
    an edited copy's ✓/✗ can follow them (remap_review). Raises LookupError
    when nothing is saved or an index is out of range."""
    envelope = get_cached(name, slug)
    if not envelope or envelope.get("fatal") or envelope.get("output_kind") == "lanes":
        raise LookupError(f"{name} has no items saved for this song")
    base = list(envelope.get("items") or [])
    drop = set(indices)
    if not drop or any(not isinstance(i, int) or i < 0 or i >= len(base) for i in drop):
        raise LookupError(f"{name}: no such items on this song")
    remap: dict[int, int] = {}
    kept: list[dict] = []
    for i, item in enumerate(base):
        if i in drop:
            continue
        remap[i] = len(kept)
        kept.append(item)
    envelope["items"] = kept
    envelope["stats"] = {"accepted": len(kept), "rejected": 0}
    _persist(envelope, result_path(name, slug))
    return envelope, remap, base


def delete_results_for(name: str) -> None:
    """Remove all cached envelopes for detector `name`."""
    folder = CUSTOM_RESULTS_DIR / name
    if not folder.exists():
        return
    for p in folder.glob("*.json"):
        try:
            p.unlink()
        except OSError:
            pass
    try:
        folder.rmdir()
    except OSError:
        pass


# ─── Subprocess isolation (honest-mistakes guard) ────────────────────────────
#
# This is not an adversarial sandbox. Custom-detector authorship and execution
# are gated to authenticated researcher/team users, and the public-demo tier
# refuses script execution entirely. The isolation below exists so that a
# researcher's honest mistake — an infinite loop, a 50 GB allocation, a
# segfault inside a C extension — does not crash the sidecar or starve other
# annotators sharing the same VM.


_DETECT_MEMORY_LIMIT_BYTES = int(os.environ.get("CUSTOM_DETECT_MEMORY_LIMIT_BYTES", 4 * 1024 ** 3))
_DETECT_CPU_LIMIT_SEC      = int(os.environ.get("CUSTOM_DETECT_CPU_LIMIT_SEC", 120))
_DETECT_WALL_LIMIT_SEC     = int(os.environ.get("CUSTOM_DETECT_WALL_LIMIT_SEC", 180))

# Serializes concurrent forks. ThreadingHTTPServer hands off each request to
# its own thread; without this, a fork() could happen while another thread is
# mid-numpy/librosa call and the child would inherit a corrupt thread state.
_FORK_LOCK = threading.Lock()

_HAS_FORK = hasattr(os, "fork") and sys.platform != "win32"

# macOS refuses RLIMIT_AS (setrlimit raises, and _child_entry shrugs it off),
# so there the memory limit is enforced from the parent instead: it reads the
# child's physical footprint — the figure Activity Monitor shows, compressed
# pages included — every _MEMORY_POLL_SEC and kills the child past the limit.
# Without it, one runaway detect() can eat the whole machine before the wall
# limit fires.
_WATCH_MEMORY = sys.platform == "darwin"
_MEMORY_POLL_SEC = 0.25


def _phys_footprint(pid: int) -> int:
    """macOS proc_pid_rusage → ri_phys_footprint in bytes; 0 if unreadable."""
    import ctypes
    try:
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        buf = ctypes.create_string_buffer(512)
        # RUSAGE_INFO_V0: uuid[16], then uint64s; ri_phys_footprint is the 8th.
        if libc.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(0), buf) != 0:
            return 0
        return int.from_bytes(buf.raw[16 + 7 * 8:16 + 8 * 8], "little")
    except Exception:
        return 0


def _child_entry(detector: Any, ctx: Any, conn: Any) -> None:
    """Inside the forked child: apply rlimits, run detect(), ship result back.

    SIGXCPU (from RLIMIT_CPU) and SIGKILL (from cgroup OOM) cannot be caught
    here — they terminate the child before this function returns. The parent
    detects those paths by reading exitcode after Pipe.recv() yields EOF.
    """
    if resource is not None:
        try:
            resource.setrlimit(resource.RLIMIT_AS, (_DETECT_MEMORY_LIMIT_BYTES, _DETECT_MEMORY_LIMIT_BYTES))
        except (ValueError, OSError):
            pass
        try:
            # Gap between soft and hard so SIGXCPU's default termination has
            # time to run before the kernel escalates to SIGKILL at the hard
            # limit. Without the gap, hard==soft, and we get an "oom"-looking
            # SIGKILL exit code for what is really a CPU-time overrun.
            resource.setrlimit(
                resource.RLIMIT_CPU,
                (_DETECT_CPU_LIMIT_SEC, _DETECT_CPU_LIMIT_SEC + 30),
            )
        except (ValueError, OSError):
            pass

    try:
        # ctx lives in this child's copy of memory; anything warn() recorded is
        # lost unless it travels back with the items.
        conn.send(("ok", _detect(detector, ctx)))
    except BaseException as exc:
        conn.send(("error", {
            "type":      type(exc).__name__,
            "message":   str(exc),
            "traceback": traceback.format_exc(),
        }))
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _run_detect_isolated(detector: Any, ctx: Any) -> tuple[str, Any]:
    """Run detector.detect(ctx) in a forked child process with rlimits.

    Returns (kind, payload):
      ("ok",      list)  — raw items, ready for _validate_items()
      ("error",   dict)  — Python exception in the child: {type, message, traceback}
      ("timeout", int)   — exceeded wall-clock limit (seconds), child killed
      ("oom",     int)   — child killed by RLIMIT_AS (memory limit in bytes)
      ("cpu",     int)   — child killed by RLIMIT_CPU (SIGXCPU, limit in seconds)
      ("crash",   int)   — child died with no result; payload is exit code (often
                           SIGSEGV/SIGABRT from a native-code crash)

    On platforms without fork() (Windows dev) falls back to an in-process call
    so unit tests still pass; production runs in a Linux container.
    """
    if not _HAS_FORK:
        try:
            return ("ok", _detect(detector, ctx))
        except BaseException as exc:
            return ("error", {
                "type":      type(exc).__name__,
                "message":   str(exc),
                "traceback": traceback.format_exc(),
            })

    ctx_mp = mp.get_context("fork")
    parent_conn, child_conn = ctx_mp.Pipe(duplex=False)
    proc = ctx_mp.Process(
        target=_child_entry,
        args=(detector, ctx, child_conn),
        daemon=True,
    )
    with _FORK_LOCK:
        proc.start()
    child_conn.close()  # parent never writes

    if _WATCH_MEMORY:
        deadline = time.monotonic() + _DETECT_WALL_LIMIT_SEC
        ready = False
        while not ready and (left := deadline - time.monotonic()) > 0:
            ready = parent_conn.poll(timeout=min(_MEMORY_POLL_SEC, left))
            if not ready and _phys_footprint(proc.pid) > _DETECT_MEMORY_LIMIT_BYTES:
                proc.kill()
                proc.join()
                parent_conn.close()
                return ("oom", _DETECT_MEMORY_LIMIT_BYTES)
    else:
        ready = parent_conn.poll(timeout=_DETECT_WALL_LIMIT_SEC)
    if not ready:
        proc.terminate()
        proc.join(timeout=5)
        if proc.is_alive():
            proc.kill()
            proc.join()
        parent_conn.close()
        return ("timeout", _DETECT_WALL_LIMIT_SEC)

    try:
        kind, payload = parent_conn.recv()
    except EOFError:
        kind, payload = None, None
    parent_conn.close()
    proc.join(timeout=5)
    if proc.is_alive():
        proc.kill()
        proc.join()

    if kind in ("ok", "error"):
        return (kind, payload)

    # No payload reached us → the child died before send() returned. Classify
    # by exit code so the UI can render a helpful message.
    exit_code = proc.exitcode if proc.exitcode is not None else -999
    if exit_code == -signal.SIGXCPU:
        return ("cpu", _DETECT_CPU_LIMIT_SEC)
    if exit_code == -signal.SIGKILL:
        # SIGKILL with RLIMIT_AS in place is almost always a cgroup OOM-kill
        # racing the rlimit; treat as out-of-memory for messaging purposes.
        return ("oom", _DETECT_MEMORY_LIMIT_BYTES)
    return ("crash", exit_code)


def _fatal_from_isolation(kind: str, payload: Any) -> dict:
    """Translate a _run_detect_isolated() non-ok return into a fatal envelope."""
    if kind == "error":
        return {
            "type":      payload["type"],
            "message":   payload["message"],
            "traceback": payload["traceback"],
        }
    if kind == "timeout":
        return {
            "type":      "TimeoutError",
            "message": (
                f"detect() exceeded the {payload}s wall-clock limit and was killed. "
                f"Narrow your search range, vectorize hot loops, or early-return "
                f"once you have enough items."
            ),
            "traceback": "",
        }
    if kind == "cpu":
        return {
            "type":      "TimeoutError",
            "message": (
                f"detect() exceeded the {payload}s CPU-time limit and was killed. "
                f"This usually means an unbounded loop — check your stop condition."
            ),
            "traceback": "",
        }
    if kind == "oom":
        gib = payload / (1024 ** 3)
        return {
            "type":      "MemoryError",
            "message": (
                f"detect() exceeded the {gib:.1f} GiB memory limit and was killed. "
                f"Reuse ctx.features instead of re-extracting, and avoid loading "
                f"every stem into RAM at once."
            ),
            "traceback": "",
        }
    return {
        "type":      "RuntimeError",
        "message": (
            f"detect() died unexpectedly (exit code {payload}). This usually means "
            f"a native-code crash inside a library (librosa, numpy, essentia, torch). "
            f"The sandbox kept it from taking down the server."
        ),
        "traceback": "",
    }


# ─── Validation ──────────────────────────────────────────────────────────────


def _validate_items(
    raw: Any,
    output_kind: str,
    duration_ms: int,
) -> tuple[list[dict], list[ValidationError]]:
    """Return (accepted_dicts, errors). Per-item; never aborts on the first bad one."""
    if not isinstance(raw, list):
        return [], [ValidationError(
            index=None,
            field="<return>",
            value=_safe_repr(raw),
            message=f"detect() must return a list, got {type(raw).__name__}.",
        )]

    accepted: list[dict] = []
    errors: list[ValidationError] = []

    if output_kind == "boundary":
        for i, item in enumerate(raw):
            ok, err = _validate_boundary(i, item, duration_ms)
            if ok is not None:
                accepted.append(ok)
            errors.extend(err)
    elif output_kind == "cue":
        for i, item in enumerate(raw):
            ok, err = _validate_cue(i, item, duration_ms)
            if ok is not None:
                accepted.append(ok)
            errors.extend(err)
    elif output_kind == "span":
        for i, item in enumerate(raw):
            ok, err = _validate_span(i, item, duration_ms)
            if ok is not None:
                accepted.append(ok)
            errors.extend(err)
    elif output_kind == "loop":
        for i, item in enumerate(raw):
            ok, err = _validate_loop(i, item, duration_ms)
            if ok is not None:
                accepted.append(ok)
            errors.extend(err)
    elif output_kind == "lyrics":
        for i, item in enumerate(raw):
            ok, err = _validate_lyrics(i, item, duration_ms)
            if ok is not None:
                accepted.append(ok)
            errors.extend(err)
    else:  # should be impossible (loader rejects others)
        errors.append(ValidationError(
            index=None,
            field="output_kind",
            value=output_kind,
            message=f"unknown output_kind: {output_kind!r}",
        ))

    return accepted, errors


def _validate_boundary(
    i: int,
    item: Any,
    duration_ms: int,
) -> tuple[Optional[dict], list[ValidationError]]:
    if not isinstance(item, Boundary):
        return None, [ValidationError(
            index=i, field=None, value=_safe_repr(item),
            message=f"item must be a Boundary instance, got {type(item).__name__}.",
        )]

    errs: list[ValidationError] = []

    t = item.time_ms
    if not _is_int(t):
        errs.append(ValidationError(
            index=i, field="time_ms", value=_safe_repr(t),
            message=f"time_ms must be an int, got {type(t).__name__}.",
        ))
    elif t < 0 or t > duration_ms:
        errs.append(ValidationError(
            index=i, field="time_ms", value=t,
            message=f"time_ms ({t}) must be in [0, {duration_ms}].",
        ))

    if item.label is not None and not isinstance(item.label, str):
        errs.append(ValidationError(
            index=i, field="label", value=_safe_repr(item.label),
            message=f"label must be str or None, got {type(item.label).__name__}.",
        ))

    if item.importance is not None and item.importance not in ("critical", "optional"):
        errs.append(ValidationError(
            index=i, field="importance", value=_safe_repr(item.importance),
            message="importance must be 'critical', 'optional', or None.",
        ))

    cands = item.candidates
    if cands is not None:
        if not isinstance(cands, list):
            errs.append(ValidationError(
                index=i, field="candidates", value=_safe_repr(cands),
                message=f"candidates must be list[int] or None, got {type(cands).__name__}.",
            ))
        else:
            for j, c in enumerate(cands):
                if not _is_int(c) or c < 0 or c > duration_ms:
                    errs.append(ValidationError(
                        index=i, field=f"candidates[{j}]", value=_safe_repr(c),
                        message=f"candidate must be int in [0, {duration_ms}].",
                    ))
                    break  # one error per item is enough to reject candidates

    color = _check_color(i, item, errs)

    if errs:
        return None, errs

    return {
        "time_ms":    int(item.time_ms),
        "label":      item.label,
        "importance": item.importance,
        "candidates": [int(c) for c in (item.candidates or [])] or None,
        **({"color": color} if color is not None else {}),
    }, []


def _validate_cue(
    i: int,
    item: Any,
    duration_ms: int,
) -> tuple[Optional[dict], list[ValidationError]]:
    """Validate the point-shaped Cue: single timestamp with label/description/intensity."""
    if not isinstance(item, Cue):
        return None, [ValidationError(
            index=i, field=None, value=_safe_repr(item),
            message=f"item must be a Cue instance, got {type(item).__name__}.",
        )]

    errs: list[ValidationError] = []

    t = item.time_ms
    if not _is_int(t):
        errs.append(ValidationError(
            index=i, field="time_ms", value=_safe_repr(t),
            message=f"time_ms must be an int, got {type(t).__name__}.",
        ))
    elif t < 0 or t > duration_ms:
        errs.append(ValidationError(
            index=i, field="time_ms", value=t,
            message=f"time_ms ({t}) must be in [0, {duration_ms}].",
        ))

    if item.label is not None and not isinstance(item.label, str):
        errs.append(ValidationError(
            index=i, field="label", value=_safe_repr(item.label),
            message=f"label must be str or None, got {type(item.label).__name__}.",
        ))

    if item.description is not None and not isinstance(item.description, str):
        errs.append(ValidationError(
            index=i, field="description", value=_safe_repr(item.description),
            message=f"description must be str or None, got {type(item.description).__name__}.",
        ))

    if item.intensity is not None:
        if not isinstance(item.intensity, (int, float)) or isinstance(item.intensity, bool):
            errs.append(ValidationError(
                index=i, field="intensity", value=_safe_repr(item.intensity),
                message=f"intensity must be a float in [0, 1] or None, got {type(item.intensity).__name__}.",
            ))
        elif not (0.0 <= float(item.intensity) <= 1.0):
            errs.append(ValidationError(
                index=i, field="intensity", value=item.intensity,
                message=f"intensity ({item.intensity}) must be in [0, 1].",
            ))

    cands = item.candidates
    if cands is not None:
        if not isinstance(cands, list):
            errs.append(ValidationError(
                index=i, field="candidates", value=_safe_repr(cands),
                message=f"candidates must be list[int] or None, got {type(cands).__name__}.",
            ))
        else:
            for j, c in enumerate(cands):
                if not _is_int(c) or c < 0 or c > duration_ms:
                    errs.append(ValidationError(
                        index=i, field=f"candidates[{j}]", value=_safe_repr(c),
                        message=f"candidate must be int in [0, {duration_ms}].",
                    ))
                    break

    # The struck-hit fields. getattr: a detector may build its Cue against an
    # older custom_api that has none of them.
    velocity = getattr(item, "velocity", None)
    if velocity is not None and (not _is_int(velocity) or not 1 <= velocity <= 127):
        errs.append(ValidationError(
            index=i, field="velocity", value=_safe_repr(velocity),
            message="velocity must be an int in [1, 127] or None.",
        ))
    level_db = getattr(item, "level_db", None)
    if level_db is not None and (
            not isinstance(level_db, (int, float, np.floating)) or isinstance(level_db, bool)
            or not np.isfinite(level_db) or level_db > 0):
        errs.append(ValidationError(
            index=i, field="level_db", value=_safe_repr(level_db),
            message="level_db must be a finite float <= 0 or None.",
        ))
    color = _check_color(i, item, errs)
    note = getattr(item, "note", None)
    if note is not None and (not _is_int(note) or not 0 <= note <= 127):
        errs.append(ValidationError(
            index=i, field="note", value=_safe_repr(note),
            message="note must be an int MIDI note number in [0, 127] or None.",
        ))
    decay_ms = getattr(item, "decay_ms", None)
    if decay_ms is not None and (not _is_int(decay_ms) or decay_ms <= 0):
        errs.append(ValidationError(
            index=i, field="decay_ms", value=_safe_repr(decay_ms),
            message="decay_ms must be an int > 0 or None.",
        ))
    importance = getattr(item, "importance", None)
    if importance is not None and importance not in ("critical", "optional"):
        errs.append(ValidationError(
            index=i, field="importance", value=_safe_repr(importance),
            message="importance must be 'critical', 'optional', or None.",
        ))

    if errs:
        return None, errs

    return {
        "time_ms":     int(item.time_ms),
        "label":       item.label,
        "description": item.description,
        "intensity":   float(item.intensity) if item.intensity is not None else None,
        "candidates":  [int(c) for c in (item.candidates or [])] or None,
        # Only when set, so a cue detector that never strikes anything keeps
        # the envelope it always had.
        **({"velocity": int(velocity)} if velocity is not None else {}),
        **({"level_db": float(level_db)} if level_db is not None else {}),
        **({"color": color} if color is not None else {}),
        **({"note": int(note)} if note is not None else {}),
        **({"decay_ms": int(decay_ms)} if decay_ms is not None else {}),
        **({"importance": importance} if importance is not None else {}),
    }, []


def _validate_span(
    i: int,
    item: Any,
    duration_ms: int,
) -> tuple[Optional[dict], list[ValidationError]]:
    """Validate Span: labeled interval (start_ms + duration_ms). May overlap."""
    if not isinstance(item, Span):
        return None, [ValidationError(
            index=i, field=None, value=_safe_repr(item),
            message=f"item must be a Span instance, got {type(item).__name__}.",
        )]

    errs: list[ValidationError] = []

    s = item.start_ms
    d = item.duration_ms
    if not _is_int(s):
        errs.append(ValidationError(
            index=i, field="start_ms", value=_safe_repr(s),
            message=f"start_ms must be an int, got {type(s).__name__}.",
        ))
    elif s < 0 or s > duration_ms:
        errs.append(ValidationError(
            index=i, field="start_ms", value=s,
            message=f"start_ms ({s}) must be in [0, {duration_ms}].",
        ))

    if not _is_int(d):
        errs.append(ValidationError(
            index=i, field="duration_ms", value=_safe_repr(d),
            message=f"duration_ms must be an int, got {type(d).__name__}.",
        ))
    elif d <= 0:
        errs.append(ValidationError(
            index=i, field="duration_ms", value=d,
            message="duration_ms must be > 0.",
        ))
    elif _is_int(s) and s + d > duration_ms:
        errs.append(ValidationError(
            index=i, field="duration_ms", value=d,
            message=f"start_ms + duration_ms ({s + d}) exceeds track length ({duration_ms}).",
        ))

    if item.label is not None and not isinstance(item.label, str):
        errs.append(ValidationError(
            index=i, field="label", value=_safe_repr(item.label),
            message=f"label must be str or None, got {type(item.label).__name__}.",
        ))

    if item.intensity is not None:
        if not isinstance(item.intensity, (int, float)) or isinstance(item.intensity, bool):
            errs.append(ValidationError(
                index=i, field="intensity", value=_safe_repr(item.intensity),
                message=f"intensity must be a float in [0, 1] or None, got {type(item.intensity).__name__}.",
            ))
        elif not (0.0 <= float(item.intensity) <= 1.0):
            errs.append(ValidationError(
                index=i, field="intensity", value=item.intensity,
                message=f"intensity ({item.intensity}) must be in [0, 1].",
            ))

    color = _check_color(i, item, errs)

    description = getattr(item, "description", None)
    if description is not None and not isinstance(description, str):
        errs.append(ValidationError(
            index=i, field="description", value=_safe_repr(description),
            message=f"description must be str or None, got {type(description).__name__}.",
        ))

    pulse = getattr(item, "pulse", None)
    if pulse is not None and pulse not in PULSE_RATES:
        errs.append(ValidationError(
            index=i, field="pulse", value=_safe_repr(pulse),
            message=f"pulse must be one of {', '.join(PULSE_RATES)}, or None.",
        ))

    if errs:
        return None, errs

    return {
        "start_ms":    int(item.start_ms),
        "duration_ms": int(item.duration_ms),
        "label":       item.label,
        "intensity":   float(item.intensity) if item.intensity is not None else None,
        **({"color": color} if color is not None else {}),
        # Written only when set, like the cue extras: every span envelope
        # written before this field existed stays byte-identical.
        **({"description": description} if description is not None else {}),
        **({"pulse": pulse} if pulse is not None else {}),
    }, []


def _validate_loop(
    i: int,
    item: Any,
    duration_ms: int,
) -> tuple[Optional[dict], list[ValidationError]]:
    """Validate Loop: seamless-playback interval (start_ms + duration_ms)."""
    if not isinstance(item, Loop):
        return None, [ValidationError(
            index=i, field=None, value=_safe_repr(item),
            message=f"item must be a Loop instance, got {type(item).__name__}.",
        )]

    errs: list[ValidationError] = []

    s = item.start_ms
    d = item.duration_ms
    if not _is_int(s):
        errs.append(ValidationError(
            index=i, field="start_ms", value=_safe_repr(s),
            message=f"start_ms must be an int, got {type(s).__name__}.",
        ))
    elif s < 0 or s > duration_ms:
        errs.append(ValidationError(
            index=i, field="start_ms", value=s,
            message=f"start_ms ({s}) must be in [0, {duration_ms}].",
        ))

    if not _is_int(d):
        errs.append(ValidationError(
            index=i, field="duration_ms", value=_safe_repr(d),
            message=f"duration_ms must be an int, got {type(d).__name__}.",
        ))
    elif d <= 0:
        errs.append(ValidationError(
            index=i, field="duration_ms", value=d,
            message="duration_ms must be > 0.",
        ))
    elif _is_int(s) and s + d > duration_ms:
        errs.append(ValidationError(
            index=i, field="duration_ms", value=d,
            message=f"start_ms + duration_ms ({s + d}) exceeds track length ({duration_ms}).",
        ))

    if item.label is not None and not isinstance(item.label, str):
        errs.append(ValidationError(
            index=i, field="label", value=_safe_repr(item.label),
            message=f"label must be str or None, got {type(item.label).__name__}.",
        ))

    if item.snap_zero_cross is not None and not isinstance(item.snap_zero_cross, bool):
        errs.append(ValidationError(
            index=i, field="snap_zero_cross", value=_safe_repr(item.snap_zero_cross),
            message=f"snap_zero_cross must be bool or None, got {type(item.snap_zero_cross).__name__}.",
        ))

    color = _check_color(i, item, errs)

    if errs:
        return None, errs

    return {
        "start_ms":        int(item.start_ms),
        "duration_ms":     int(item.duration_ms),
        "label":           item.label,
        "snap_zero_cross": bool(item.snap_zero_cross) if item.snap_zero_cross is not None else None,
        **({"color": color} if color is not None else {}),
    }, []


def _round_beat(b: float) -> float:
    return round(float(b), 4)


def _riff_notes(notes: Any, where: str, length: Optional[float], errs: list) -> list[dict]:
    """RiffNotes → note blocks in the stored shape, each checked. `length`
    (beats) bounds them when known."""
    out: list[dict] = []
    if notes is None:
        return out
    if not isinstance(notes, (list, tuple)):
        errs.append(ValidationError(index=None, field=where, value=_safe_repr(notes),
                                    message="must be a list of RiffNote."))
        return out
    for k, n in enumerate(notes):
        f = f"{where}[{k}]"
        if not isinstance(n, RiffNote):
            errs.append(ValidationError(index=None, field=f, value=_safe_repr(n),
                                        message=f"must be a RiffNote, got {type(n).__name__}."))
            continue
        if not (_is_number(n.start) and _is_number(n.end)) or n.start < 0 or n.end <= n.start \
                or (length is not None and n.end > length + 1e-6):
            errs.append(ValidationError(
                index=None, field=f, value=_safe_repr((n.start, n.end)),
                message=f"start/end must be beats with 0 <= start < end"
                        f"{f' <= {length:g} (the node length)' if length is not None else ''}."))
            continue
        if n.note is not None and not (_is_int(n.note) and 0 <= n.note <= 127):
            errs.append(ValidationError(index=None, field=f"{f}.note", value=_safe_repr(n.note),
                                        message="note must be a MIDI number 0-127, or None."))
            continue
        if n.accent is not None and not (_is_int(n.accent) and 1 <= n.accent <= 127):
            errs.append(ValidationError(index=None, field=f"{f}.accent", value=_safe_repr(n.accent),
                                        message="accent must be 1-127, or None."))
            continue
        block = {"start": _round_beat(n.start), "end": _round_beat(n.end), "kind": "tick"}
        if n.label:
            block["label"] = str(n.label)[:40]
        if n.note is not None:
            block["note"] = int(n.note)
        if n.accent is not None:
            block["accent"] = int(n.accent)
        out.append(block)
    return out


def _tile(notes: list[dict], length: float) -> list[dict]:
    """A node's notes as the blocks a Riff Patterns node stores: sorted,
    overlaps cut (the earlier note wins), and every gap a rest, so the blocks
    tile [0, length) — normalizeBoundarySegments in the web app."""
    out: list[dict] = []
    at = 0.0
    for n in sorted(notes, key=lambda x: (x["start"], x["end"])):
        start = max(n["start"], at)
        if n["end"] - start < 0.01:
            continue
        if start - at >= 0.01:
            out.append({"start": _round_beat(at), "end": _round_beat(start), "kind": "empty"})
        out.append({**n, "start": _round_beat(start)})
        at = n["end"]
    if length - at >= 0.01 or not out:
        out.append({"start": _round_beat(at), "end": _round_beat(length), "kind": "empty"})
    elif out:
        out[-1] = {**out[-1], "end": _round_beat(length)}
    return out


def _riff_sequence(seq: Any, where: str, refs: set[str], errs: list) -> Optional[list[dict]]:
    if not isinstance(seq, (list, tuple)) or not seq:
        errs.append(ValidationError(index=None, field=where, value=_safe_repr(seq),
                                    message="must be a non-empty list of RiffEntry."))
        return None
    out = []
    for k, e in enumerate(seq):
        if not isinstance(e, RiffEntry) or not (e.type in refs or e.type == RIFF_SILENCE) \
                or not (_is_int(e.length_steps) and e.length_steps >= 1):
            errs.append(ValidationError(
                index=None, field=f"{where}[{k}]", value=_safe_repr(e),
                message="must be a RiffEntry naming a node or combo of this riff (or RIFF_SILENCE), "
                        "with length_steps >= 1."))
            return None
        out.append({"type": e.type, "lengthSteps": int(e.length_steps)})
    return out


def _validate_riff(raw: Any, duration_ms: int) -> tuple[dict, list[ValidationError]]:
    """A "riff" detector's return value → the lane in the shape a Riff Patterns
    layer stores: {nodes, combos, items, drum?, summary?}. A bad node is
    dropped with every item that plays it; a bad item alone."""
    out: dict = {"nodes": [], "combos": [], "items": []}
    if not isinstance(raw, Riff):
        return out, [ValidationError(
            index=None, field="<return>", value=_safe_repr(raw),
            message=f"detect() must return a Riff, got {type(raw).__name__}.")]
    errs: list[ValidationError] = []
    ids: set[str] = set()
    for k, node in enumerate(raw.nodes or []):
        f = f"nodes[{k}]"
        bad = None
        if not isinstance(getattr(node, "id", None), str) or not node.id or node.id in ids \
                or node.id == RIFF_SILENCE:
            bad = ("id", getattr(node, "id", None), "must be a non-empty string, unique in the riff.")
        elif not isinstance(node.name, str) or not node.name.strip():
            bad = ("name", node.name, "must be a non-empty string.")
        elif node.subbeats_per_beat not in RIFF_PULSES:
            bad = ("subbeats_per_beat", node.subbeats_per_beat, f"must be one of {list(RIFF_PULSES)}.")
        elif not (_is_int(node.steps_per_cycle) and node.steps_per_cycle >= 1):
            bad = ("steps_per_cycle", node.steps_per_cycle, "must be an int >= 1.")
        if bad:
            errs.append(ValidationError(index=k, field=f"{f}.{bad[0]}", value=_safe_repr(bad[1]),
                                        message=bad[2]))
            continue
        length = node.steps_per_cycle / node.subbeats_per_beat
        notes = _riff_notes(node.notes, f"{f}.notes", length, errs)
        ids.add(node.id)
        block = {
            "id": node.id,
            "name": node.name.strip()[:80],
            "stepsPerCycle": int(node.steps_per_cycle),
            "subbeatsPerBeat": int(node.subbeats_per_beat),
            "segments": _tile(notes, length),
        }
        if node.color:
            block["color"] = str(node.color)
        if node.names:
            block["names"] = [str(x) for x in node.names if str(x).strip()]
        out["nodes"].append(block)
    combo_ids: set[str] = set()
    for k, c in enumerate(raw.combos or []):
        seq = _riff_sequence(getattr(c, "sequence", None), f"combos[{k}].sequence", ids, errs)
        if seq is None or not isinstance(getattr(c, "id", None), str) or c.id in ids | combo_ids:
            continue
        combo_ids.add(c.id)
        out["combos"].append({"id": c.id, "name": str(c.name), "sequence": seq,
                              **({"color": str(c.color)} if c.color else {})})
    end_s = duration_ms / 1000
    for i, it in enumerate(raw.items or []):
        f = f"items[{i}]"
        if not _is_number(getattr(it, "start", None)) or not _is_number(getattr(it, "end", None)) \
                or it.start < 0 or it.end <= it.start or it.start > end_s:
            errs.append(ValidationError(index=i, field=f"{f}.start", value=_safe_repr(
                (getattr(it, "start", None), getattr(it, "end", None))),
                message="start/end must be seconds with 0 <= start < end, start inside the song."))
            continue
        if not (_is_int(it.repeat_count) and it.repeat_count >= 1):
            errs.append(ValidationError(index=i, field=f"{f}.repeat_count",
                                        value=_safe_repr(it.repeat_count), message="must be an int >= 1."))
            continue
        item_errs: list[ValidationError] = []
        seq = _riff_sequence(it.sequence, f"{f}.sequence", ids | combo_ids, item_errs)
        if seq is None:
            errs.extend(item_errs)
            continue
        plays = it.repeat_count * len(seq)
        occurrences = []
        for k, o in enumerate(it.occurrences or []):
            g = f"{f}.occurrences[{k}]"
            if not (_is_int(getattr(o, "index", None)) and 0 <= o.index < plays) \
                    or getattr(o, "event", None) not in RIFF_EVENTS:
                item_errs.append(ValidationError(index=i, field=g, value=_safe_repr(o),
                                                 message=f"index must be a play 0..{plays - 1} and event "
                                                         f"one of {list(RIFF_EVENTS)}."))
                continue
            entry = seq[o.index % len(seq)]["type"]
            node = next((n for n in out["nodes"] if n["id"] == entry), None)
            length = node["stepsPerCycle"] / node["subbeatsPerBeat"] if node else None
            added = _riff_notes(o.added, f"{g}.added", length, item_errs)
            missing = [{"start": _round_beat(m)} for m in (o.missing or []) if _is_number(m) and m >= 0]
            occ = {"index": int(o.index), "event": o.event}
            if added:
                occ["added"] = [{k2: v for k2, v in a.items() if k2 != "kind"} for a in added]
            if missing:
                occ["missing"] = missing
            occurrences.append(occ)
        errs.extend(item_errs)
        item = {"start": round(float(it.start), 3), "end": round(float(it.end), 3),
                "label": str(it.label or "")[:120], "sequence": seq,
                "repeatCount": int(it.repeat_count)}
        if occurrences:
            item["occurrences"] = sorted(occurrences, key=lambda o: o["index"])
        out["items"].append(item)
    out["items"].sort(key=lambda x: x["start"])
    if raw.drum:
        out["drum"] = str(raw.drum)
    if raw.summary:
        out["summary"] = str(raw.summary)
    return out, errs


def _validate_lyrics(
    i: int,
    item: Any,
    duration_ms: int,
) -> tuple[Optional[dict], list[ValidationError]]:
    """Validate Lyrics: a word/line timestamp with required text."""
    if not isinstance(item, Lyrics):
        return None, [ValidationError(
            index=i, field=None, value=_safe_repr(item),
            message=f"item must be a Lyrics instance, got {type(item).__name__}.",
        )]

    errs: list[ValidationError] = []

    t = item.time_ms
    if not _is_int(t):
        errs.append(ValidationError(
            index=i, field="time_ms", value=_safe_repr(t),
            message=f"time_ms must be an int, got {type(t).__name__}.",
        ))
    elif t < 0 or t > duration_ms:
        errs.append(ValidationError(
            index=i, field="time_ms", value=t,
            message=f"time_ms ({t}) must be in [0, {duration_ms}].",
        ))

    if not isinstance(item.text, str) or not item.text.strip():
        errs.append(ValidationError(
            index=i, field="text", value=_safe_repr(item.text),
            message="text must be a non-empty string.",
        ))

    if item.kind not in ("word", "line"):
        errs.append(ValidationError(
            index=i, field="kind", value=_safe_repr(item.kind),
            message="kind must be 'word' or 'line'.",
        ))

    e = item.end_ms
    if e is not None:
        if not _is_int(e):
            errs.append(ValidationError(
                index=i, field="end_ms", value=_safe_repr(e),
                message=f"end_ms must be an int or None, got {type(e).__name__}.",
            ))
        elif _is_int(t) and (e < t or e > duration_ms):
            errs.append(ValidationError(
                index=i, field="end_ms", value=e,
                message=f"end_ms ({e}) must be in [time_ms, {duration_ms}].",
            ))

    src = item.source
    if src is not None and not isinstance(src, str):
        errs.append(ValidationError(
            index=i, field="source", value=_safe_repr(src),
            message=f"source must be a str or None, got {type(src).__name__}.",
        ))

    onsets = None
    if item.onsets is not None:
        hi = e if _is_int(e) else duration_ms
        onsets = []
        for o in item.onsets:
            ot, otext = (o if isinstance(o, (list, tuple)) and len(o) == 2 else (None, None))
            if not _is_int(ot) or not _is_int(t) or ot < t or ot > hi:
                errs.append(ValidationError(
                    index=i, field="onsets", value=_safe_repr(o),
                    message=f"each onset must be (time_ms int in [time_ms, {hi}], text or None).",
                ))
                break
            if otext is not None and not isinstance(otext, str):
                errs.append(ValidationError(
                    index=i, field="onsets", value=_safe_repr(o),
                    message="an onset's text must be a str or None.",
                ))
                break
            onsets.append({"time_ms": int(ot), "text": otext or None})

    env = None
    if item.envelope is not None:
        ev = item.envelope if isinstance(item.envelope, dict) else {}
        times = [ev.get(k) for k in _ENVELOPE_KEYS]
        sus = ev.get("sustain_db")
        if (not all(_is_int(x) and 0 <= x <= duration_ms for x in times)
                or times != sorted(times)
                or not isinstance(ev.get("peak_db"), (int, float))
                or isinstance(ev.get("peak_db"), bool)
                or (sus is not None and (not isinstance(sus, (int, float)) or isinstance(sus, bool)))):
            errs.append(ValidationError(
                index=i, field="envelope", value=_safe_repr(item.envelope),
                message=("envelope must be {start_ms <= peak_ms <= decay_end_ms <= release_ms "
                         f"<= end_ms, ints in [0, {duration_ms}]; peak_db a number; "
                         "sustain_db a number or None}."),
            ))
        else:
            env = {k: int(x) for k, x in zip(_ENVELOPE_KEYS, times)}
            env["peak_db"] = float(ev["peak_db"])
            env["sustain_db"] = None if sus is None else float(sus)

    if errs:
        return None, errs

    out = {
        "time_ms": int(item.time_ms),
        "text":    item.text,
        "kind":    item.kind,
        "end_ms":  int(item.end_ms) if item.end_ms is not None else None,
        "source":  item.source,
    }
    if onsets:
        out["onsets"] = onsets
    if env:
        out["envelope"] = env
    return out, []


_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _check_color(i: int, item: Any, errs: list[ValidationError]) -> Optional[str]:
    """The optional per-item `color` every kind shares (boundary, cue, span,
    loop): "#rrggbb" or None. Appends an error and returns None when invalid;
    returns the colour lower-cased otherwise. getattr, so a detector built
    against an older custom_api without the field still validates."""
    color = getattr(item, "color", None)
    if color is None:
        return None
    if not (isinstance(color, str) and _HEX_COLOR_RE.match(color)):
        errs.append(ValidationError(
            index=i, field="color", value=_safe_repr(color),
            message='color must be a "#rrggbb" string or None.',
        ))
        return None
    return color.lower()


def _is_number(v: Any) -> bool:
    """A finite int or float (numpy's too); not a bool."""
    if isinstance(v, bool):
        return False
    return isinstance(v, (int, float, np.integer, np.floating)) and math.isfinite(float(v))


def _is_int(v: Any) -> bool:
    """True for plain Python ints AND numpy integers; rejects bool."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    if isinstance(v, np.integer):
        return True
    return False


# ─── Audio + context ─────────────────────────────────────────────────────────


def _find_audio(slug: str) -> Optional[Path]:
    """Walk both data/songs/<slug>/ and data-default/songs/<slug>/ (user
    wins). Returns None when the slug has no audio in either tree."""
    return find_audio(slug, exts=_AUDIO_EXTS)


def _load_song_info(slug: str) -> dict:
    """Read the curator's SongInfo from disk. Returns an empty dict if no
    file exists (the runner falls back to feature-extractor BPM in that
    case). SongInfo lives under both data/song-info/<slug>.json and
    data-default/song-info/<slug>.json (user data takes precedence)."""
    from paths import SONG_INFO_DIR, DEFAULT_SONG_INFO_DIR
    for root in (SONG_INFO_DIR, DEFAULT_SONG_INFO_DIR):
        candidate = root / f"{slug}.json"
        if candidate.is_file():
            try:
                import json as _json
                return _json.loads(candidate.read_text())
            except Exception:
                pass
    return {}


NO_GRID_MESSAGE = ("This song has no beat grid yet. Every detector cuts on your grid, never on "
                   "one guessed from the audio — set the BPM and bar 1 in Dataset Prep → Song "
                   "Setup, then run it again.")


class NoGridError(Exception):
    """The song has no BPM, so it has no grid, so no detector may run on it."""

    def __init__(self, slug: str):
        super().__init__(NO_GRID_MESSAGE)
        self.slug = slug


def has_user_grid(slug: str) -> bool:
    """Has the annotator given this song a BPM? The one test for "has a grid",
    the same one the app uses (isGridReady in web-app/src/types/songInfo.ts)."""
    bpm = _load_song_info(slug).get("bpm")
    return isinstance(bpm, (int, float)) and not isinstance(bpm, bool) and bpm > 0


def _no_grid_fatal() -> dict:
    return {"type": "NoGrid", "message": NO_GRID_MESSAGE, "traceback": ""}


def _parse_beats_per_bar(ts: str) -> int:
    try:
        n = int(str(ts).split("/")[0])
        return n if n > 0 else 4
    except Exception:
        return 4


def _build_context(
    audio_path: Path,
    slug: str,
    window: Optional[tuple[int, int]] = None,
    lead_ms: int = 0,
    window_stems: Optional[list[str]] = None,
) -> DetectionContext:
    """Heavy lifting: load audio, extract features, compute curves, locate stems.

    With `window` = (start_ms, end_ms) the context describes only that range,
    counted from zero: the audio and stems are cut to it BEFORE the features,
    curves and beats are computed, so none of them has heard the rest of the
    song. The curator grid is re-anchored to the first downbeat inside it.

    Raises NoGridError when the song has no BPM: every detector cuts on the
    annotator's grid, so without one there is nothing to run on.
    """
    if not has_user_grid(slug):
        raise NoGridError(slug)
    audio = load_audio(str(audio_path))
    song_duration_s = float(audio.duration_seconds)
    cut: Optional[slice] = None
    if window is not None:
        start_ms, end_ms = window
        cut = slice(int(start_ms * audio.sr / 1000), int(end_ms * audio.sr / 1000))
        y = audio.y[cut]
        if y.size == 0:
            raise ValueError(f"no audio between {start_ms} ms and {end_ms} ms")
        audio = AudioData(
            y=y, sr=audio.sr,
            duration_seconds=y.size / audio.sr,
            duration_ms=int(y.size * 1000 / audio.sr),
            file_path=audio.file_path,
        )
    features = extract_features(audio)
    energy = compute_energy_curve(features)
    tension = compute_tension_curve(features, energy)

    beat_times_ms: list[int] = []
    if features.beat_frames is not None and features.sr and features.hop_length:
        # frame_index → seconds → ms
        beat_seconds = features.beat_frames * features.hop_length / features.sr
        beat_times_ms = [int(round(t * 1000)) for t in beat_seconds.tolist()]

    # The song's grid is the annotator's SongInfo, and nothing else: no
    # detector runs on a tempo the feature extractor guessed.
    song_info = _load_song_info(slug)
    bpm_value = float(song_info["bpm"])
    time_signature = str(song_info.get("timeSignature") or "4/4")
    grid_offset_ms = int(round(float(song_info.get("gridOffset") or 0.0) * 1000))
    grid_mode = song_info.get("gridMode") or "static"
    if grid_mode not in ("static", "mapped", "manual"):
        grid_mode = "static"

    beats_per_bar = _parse_beats_per_bar(time_signature)

    # The grid every detector cuts at is the ANNOTATOR'S — the lines the app
    # draws, tempo splits and hand-placed beats included — so what a detector
    # marks lands where the annotator sees the beat. There is no other grid:
    # a song nobody has given a BPM was refused above, before any audio was
    # read. librosa's tracked beats are kept beside it only for a detector
    # that measures how the audio sits against the grid.
    import grid_truth
    tracked_beat_times_ms = beat_times_ms
    beats_s, downs_s = grid_truth.user_grid(song_info, song_duration_s)
    if not beats_s:
        raise NoGridError(slug)
    w0 = window[0] if window is not None else 0
    w1 = window[1] if window is not None else int(round(song_duration_s * 1000))

    def _local(ts):
        return [int(round(t * 1000)) - w0 for t in ts if w0 <= t * 1000 <= w1]
    beat_times_ms = _local(beats_s)
    downbeat_times_ms = _local(downs_s)
    grid_source = "user"

    stems = _load_stems(slug, audio_path)
    if window is not None:
        # Stems are loaded at 22050 Hz, the same rate as the mix, so the
        # mix's sample slice cuts them at the same instants.
        stems = {k: v[cut] for k, v in stems.items()}
        if bpm_value > 0:
            bar_ms = beats_per_bar * 60000.0 / bpm_value
            grid_offset_ms = int(round((grid_offset_ms - window[0]) % bar_ms))

    return DetectionContext(
        audio=audio.y,
        sr=audio.sr,
        duration_ms=audio.duration_ms,
        stems=stems,
        features=features,
        energy_curve=np.asarray(energy, dtype=np.float32),
        tension_curve=np.asarray(tension, dtype=np.float32),
        bpm=bpm_value,
        beat_times_ms=beat_times_ms,
        downbeat_times_ms=downbeat_times_ms,
        tracked_beat_times_ms=tracked_beat_times_ms,
        grid_source=grid_source,
        slug=slug,
        grid_offset_ms=grid_offset_ms,
        time_signature=time_signature,
        beats_per_bar=beats_per_bar,
        grid_mode=grid_mode,
        window_start_ms=window[0] if window is not None else None,
        window_lead_ms=lead_ms if window is not None else 0,
        window_stems=window_stems if window is not None else None,
    )


def _load_stems(slug: str, audio_path: Path) -> dict[str, np.ndarray]:
    """Best-effort stem lookup. Empty dict if not demuxed yet — never raises.

    Tries:
      1. <STEMS_ROOT>/<slug>/manifest.json (exact match, kebab slug).
      2. Scan <STEMS_ROOT>/* manifests for one whose audioFile basename equals
         our audio file's basename (handles repos where stems use display
         names while songs use kebab slugs).
    """
    try:
        manifest, stems_dir = _resolve_stems_manifest(slug, audio_path)
    except Exception:
        return {}
    if manifest is None:
        return {}

    out: dict[str, np.ndarray] = {}
    for kind, rel_path in manifest.get("stems", {}).items():
        if not isinstance(rel_path, str):
            continue
        # rel_path is like "/stems/<slug>/<kind>.wav" — convert to filesystem path.
        fname = Path(rel_path).name
        wav_path = stems_dir / fname
        if not wav_path.is_file():
            continue
        try:
            y, _ = librosa.load(str(wav_path), sr=22050, mono=True)
            out[kind] = y.astype(np.float32, copy=False)
        except Exception:
            # One bad stem must not poison the others.
            continue
    return out


def _resolve_stems_manifest(
    slug: str,
    audio_path: Path,
) -> tuple[Optional[dict], Path]:
    direct = _STEMS_ROOT / slug / "manifest.json"
    if direct.is_file():
        return json.loads(direct.read_text()), direct.parent

    if not _STEMS_ROOT.exists():
        return None, _STEMS_ROOT
    target_basename = audio_path.name
    for entry in _STEMS_ROOT.iterdir():
        m = entry / "manifest.json"
        if not m.is_file():
            continue
        try:
            data = json.loads(m.read_text())
        except Exception:
            continue
        if data.get("audioFile") == target_basename:
            return data, entry
    return None, _STEMS_ROOT


# ─── Fatal envelope ──────────────────────────────────────────────────────────


def _build_fatal(exc: BaseException, message: str) -> dict:
    """Standard fatal envelope with optional missing-module install hint.

    For ModuleNotFoundError (either raised here or carried on DetectorLoadError
    from the loader), embeds `missing_module` / `suggested_package` /
    `suggested_install` so the UI can render an install prompt.
    """
    fatal: dict = {
        "type":      type(exc).__name__,
        "message":   message,
        "traceback": traceback.format_exc(),
    }
    hint = getattr(exc, "hint", None) or missing_module_hint(exc)
    if hint:
        fatal.update(hint)
    return fatal


# ─── Persistence ─────────────────────────────────────────────────────────────


def _empty_envelope(name: str, slug: str) -> dict:
    return {
        "name":         name,
        "slug":         slug,
        "output_kind":  "boundary",
        "ran_at":       datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "duration_ms":  0,
        "items":        [],
        "errors":       [],
        "notes":        [],
        "stats":        {"accepted": 0, "rejected": 0},
        "fatal":        None,
    }


def _persist(envelope: dict, path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(envelope, indent=2))
    except Exception:
        # Persistence failure is not fatal to the response — caller still
        # gets the envelope, just no caching.
        pass


# Tiny re-export so test/runner code can serialize ValidationErrors uniformly.
__all__ = [
    "run",
    "run_window",
    "merge_window",
    "merge_window_items",
    "remap_review",
    "get_cached",
    "result_path",
    "delete_results_for",
    "asdict",
]
