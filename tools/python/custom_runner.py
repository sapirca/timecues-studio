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
      "output_kind": "boundary" | "cue" | "span" | "loop" | "pattern" | "lyrics",
      "ran_at": "ISO-8601",
      "duration_ms": int,
      "items": [
        {time_ms, ...}                               # boundary | cue
                                                     #   (cue may add velocity, level_db, color, note, decay_ms, importance)
        | {start_ms, duration_ms, label, intensity}  # span
        | {start_ms, duration_ms, label, snap_zero_cross}            # loop
        | {start_ms, duration_ms, label, repeat_count, highlighted_beats, spans, steps_per_cycle}  # pattern
        | {time_ms, end_ms, text, kind}              # lyrics
      ],
      "errors": [ {index, field, value, message}, ... ],
      "notes":  [ {code, message}, ... ],     # caveats; the run still succeeded
      "stats": { "accepted": int, "rejected": int },
      "fatal": null | { "type": str, "message": str, "traceback": str }
    }
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import re
import signal
import sys
import threading
import traceback
from dataclasses import asdict
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
    DetectionContext,
    Loop,
    Lyrics,
    Pattern,
    Span,
    ValidationError,
    _safe_repr,
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


def run(name: str, slug: str, *, force: bool = False) -> dict:
    """Run detector `name` on song `slug`, persist, return the envelope."""
    cache_path = result_path(name, slug)
    hit = cached_result(cache_path, force, failed=lambda env: bool(env.get("fatal")))
    if hit is not None:
        return hit

    envelope = _empty_envelope(name, slug)

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
    except Exception as exc:
        envelope["fatal"] = _build_fatal(exc, f"failed to build DetectionContext: {exc}")
        _persist(envelope, cache_path)
        return envelope

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
        else:
            raw_items = payload
    else:
        envelope["fatal"] = _fatal_from_isolation(kind, payload)
        _persist(envelope, cache_path)
        return envelope

    items, errors = _validate_items(raw_items, detector.output_kind, ctx.duration_ms)
    envelope["items"]  = items
    envelope["errors"] = [e.to_dict() for e in errors]
    envelope["stats"]  = {"accepted": len(items), "rejected": len(errors)}

    _persist(envelope, cache_path)
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


def result_path(name: str, slug: str) -> Path:
    """Where the algorithm-mode envelope for `name`/`slug` is WRITTEN on disk
    (the writable cache; reads also consult the data-default seed — see
    get_cached)."""
    safe = slug.replace("/", "_")
    return CUSTOM_RESULTS_DIR / name / f"{safe}.json"


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
        items = detector.detect(ctx)
        # ctx lives in this child's copy of memory; anything warn() recorded is
        # lost unless it travels back with the items.
        conn.send(("ok", {"items": items, "notes": list(getattr(ctx, "notes", []))}))
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
            items = detector.detect(ctx)
            return ("ok", {"items": items, "notes": list(getattr(ctx, "notes", []))})
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
    elif output_kind == "pattern":
        for i, item in enumerate(raw):
            ok, err = _validate_pattern(i, item, duration_ms)
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

    if errs:
        return None, errs

    return {
        "time_ms":    int(item.time_ms),
        "label":      item.label,
        "importance": item.importance,
        "candidates": [int(c) for c in (item.candidates or [])] or None,
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
    color = getattr(item, "color", None)
    if color is not None and not (isinstance(color, str) and _HEX_COLOR_RE.match(color)):
        errs.append(ValidationError(
            index=i, field="color", value=_safe_repr(color),
            message='color must be a "#rrggbb" string or None.',
        ))
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
        **({"color": color.lower()} if color is not None else {}),
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

    if errs:
        return None, errs

    return {
        "start_ms":    int(item.start_ms),
        "duration_ms": int(item.duration_ms),
        "label":       item.label,
        "intensity":   float(item.intensity) if item.intensity is not None else None,
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

    if errs:
        return None, errs

    return {
        "start_ms":        int(item.start_ms),
        "duration_ms":     int(item.duration_ms),
        "label":           item.label,
        "snap_zero_cross": bool(item.snap_zero_cross) if item.snap_zero_cross is not None else None,
    }, []


def _validate_pattern(
    i: int,
    item: Any,
    duration_ms: int,
) -> tuple[Optional[dict], list[ValidationError]]:
    """Validate Pattern: tiled cycle (start_ms + duration_ms + repeat_count)."""
    if not isinstance(item, Pattern):
        return None, [ValidationError(
            index=i, field=None, value=_safe_repr(item),
            message=f"item must be a Pattern instance, got {type(item).__name__}.",
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
            message="duration_ms must be > 0 (one cycle length).",
        ))

    rc = item.repeat_count
    if not _is_int(rc):
        errs.append(ValidationError(
            index=i, field="repeat_count", value=_safe_repr(rc),
            message=f"repeat_count must be an int, got {type(rc).__name__}.",
        ))
    elif rc < 1:
        errs.append(ValidationError(
            index=i, field="repeat_count", value=rc,
            message="repeat_count must be >= 1.",
        ))
    elif _is_int(s) and _is_int(d) and s + rc * d > duration_ms:
        errs.append(ValidationError(
            index=i, field="repeat_count", value=rc,
            message=(
                f"start_ms + repeat_count * duration_ms ({s + rc * d}) "
                f"exceeds track length ({duration_ms})."
            ),
        ))

    if item.label is not None and not isinstance(item.label, str):
        errs.append(ValidationError(
            index=i, field="label", value=_safe_repr(item.label),
            message=f"label must be str or None, got {type(item.label).__name__}.",
        ))

    hb = item.highlighted_beats
    if hb is not None:
        if not isinstance(hb, list):
            errs.append(ValidationError(
                index=i, field="highlighted_beats", value=_safe_repr(hb),
                message=f"highlighted_beats must be list[int] or None, got {type(hb).__name__}.",
            ))
        else:
            for j, step in enumerate(hb):
                if not _is_int(step) or step < 0:
                    errs.append(ValidationError(
                        index=i, field=f"highlighted_beats[{j}]", value=_safe_repr(step),
                        message="highlighted_beats entries must be non-negative ints (16th-note step indices).",
                    ))
                    break

    spc = item.steps_per_cycle
    if spc is not None:
        if not _is_int(spc):
            errs.append(ValidationError(
                index=i, field="steps_per_cycle", value=_safe_repr(spc),
                message=f"steps_per_cycle must be an int or None, got {type(spc).__name__}.",
            ))
        elif spc < 1:
            errs.append(ValidationError(
                index=i, field="steps_per_cycle", value=spc,
                message="steps_per_cycle must be >= 1.",
            ))
        elif isinstance(hb, list) and hb and all(_is_int(s) for s in hb) and max(hb) >= spc:
            errs.append(ValidationError(
                index=i, field="steps_per_cycle", value=spc,
                message=(
                    f"steps_per_cycle ({spc}) must be > every highlighted_beats "
                    f"index (max {max(hb)}) — indices are 0-based within the cycle."
                ),
            ))

    # spans: held runs [start_step, length], length >= 2, in-bounds, and
    # disjoint both from each other and from highlighted_beats.
    sp = item.spans
    clean_spans: list[list[int]] = []
    if sp is not None:
        tick_set = set(hb) if isinstance(hb, list) and all(_is_int(x) for x in hb) else set()
        covered: set[int] = set()
        if not isinstance(sp, list):
            errs.append(ValidationError(
                index=i, field="spans", value=_safe_repr(sp),
                message=f"spans must be list[[start, length]] or None, got {type(sp).__name__}.",
            ))
        else:
            for j, entry in enumerate(sp):
                if not (isinstance(entry, (list, tuple)) and len(entry) == 2
                        and _is_int(entry[0]) and _is_int(entry[1])):
                    errs.append(ValidationError(
                        index=i, field=f"spans[{j}]", value=_safe_repr(entry),
                        message="each span must be [start_step, length] with int entries.",
                    ))
                    break
                start, length = int(entry[0]), int(entry[1])
                if start < 0 or length < 2:
                    errs.append(ValidationError(
                        index=i, field=f"spans[{j}]", value=_safe_repr(entry),
                        message="span start must be >= 0 and length must be >= 2.",
                    ))
                    break
                if spc is not None and _is_int(spc) and start + length > spc:
                    errs.append(ValidationError(
                        index=i, field=f"spans[{j}]", value=_safe_repr(entry),
                        message=f"span [{start}, {length}] runs past steps_per_cycle ({spc}).",
                    ))
                    break
                run = set(range(start, start + length))
                if run & covered or run & tick_set:
                    errs.append(ValidationError(
                        index=i, field=f"spans[{j}]", value=_safe_repr(entry),
                        message="spans must not overlap each other or highlighted_beats.",
                    ))
                    break
                covered |= run
                clean_spans.append([start, length])

    # Multi-row content. Validated against the SAME step index space as the
    # single-row fields, so a row cannot describe a step the cycle doesn't have
    # — a silently out-of-range step would draw nothing and look like a bug in
    # the grid rather than in the detector.
    # `steps_per_cycle` is optional (the UI falls back to beats_per_bar * 4),
    # so the upper bound is only enforced when the detector declared one.
    row_limit = spc if (_is_int(spc) and spc >= 1) else None

    clean_rows: list[dict] = []
    if item.rows is not None:
        if not isinstance(item.rows, (list, tuple)):
            errs.append(ValidationError(
                index=i, field="rows", value=_safe_repr(item.rows),
                message="rows must be a list of PatternRow.",
            ))
        else:
            for j, row in enumerate(item.rows):
                name = getattr(row, "row", None)
                steps_list = getattr(row, "highlighted_beats", None)
                if not isinstance(name, str):
                    errs.append(ValidationError(
                        index=i, field=f"rows[{j}].row", value=_safe_repr(name),
                        message="row must be a string naming the line (e.g. \"kick\").",
                    ))
                    continue
                if not isinstance(steps_list, (list, tuple)):
                    errs.append(ValidationError(
                        index=i, field=f"rows[{j}].highlighted_beats", value=_safe_repr(steps_list),
                        message="highlighted_beats must be a list of step indices.",
                    ))
                    continue
                bad = [
                    x for x in steps_list
                    if not _is_int(x) or x < 0 or (row_limit is not None and x >= row_limit)
                ]
                if bad:
                    upper = f"[0, {row_limit - 1}]" if row_limit is not None else "[0, ...)"
                    errs.append(ValidationError(
                        index=i, field=f"rows[{j}].highlighted_beats", value=_safe_repr(bad[:5]),
                        message=f"step indices must be ints in {upper}.",
                    ))
                    continue
                accents = getattr(row, "accents", None)
                clean_accents: Optional[list[int]] = None
                if accents is not None:
                    if not isinstance(accents, (list, tuple)):
                        errs.append(ValidationError(
                            index=i, field=f"rows[{j}].accents", value=_safe_repr(accents),
                            message="accents must be a list of velocities (1-127).",
                        ))
                        continue
                    if len(accents) > len(steps_list):
                        errs.append(ValidationError(
                            index=i, field=f"rows[{j}].accents", value=len(accents),
                            message=(f"accents ({len(accents)}) is positional against "
                                     f"highlighted_beats ({len(steps_list)}); it cannot be longer."),
                        ))
                        continue
                    clean_accents = [max(1, min(127, int(v))) for v in accents if _is_int(v)]
                    if len(clean_accents) != len(accents):
                        errs.append(ValidationError(
                            index=i, field=f"rows[{j}].accents", value=_safe_repr(accents[:5]),
                            message="accents must be ints.",
                        ))
                        continue
                clean_rows.append({
                    "row": name,
                    "highlighted_beats": [int(x) for x in steps_list],
                    **({"accents": clean_accents} if clean_accents is not None else {}),
                })

    clean_occurrences: list[dict] = []
    if item.occurrences is not None:
        if not isinstance(item.occurrences, (list, tuple)):
            errs.append(ValidationError(
                index=i, field="occurrences", value=_safe_repr(item.occurrences),
                message="occurrences must be a list of PatternOccurrence.",
            ))
        else:
            for j, occ in enumerate(item.occurrences):
                dev = getattr(occ, "deviation", 0.0)
                if not isinstance(dev, (int, float)) or isinstance(dev, bool) or not (0.0 <= float(dev) <= 1.0):
                    errs.append(ValidationError(
                        index=i, field=f"occurrences[{j}].deviation", value=_safe_repr(dev),
                        message="deviation must be a number in [0, 1] (0 = played exactly).",
                    ))
                    continue
                clean_occurrences.append({
                    "index": int(getattr(occ, "index", j)),
                    "start_ms": int(getattr(occ, "start_ms", 0)),
                    "deviation": round(float(dev), 4),
                    "added": list(getattr(occ, "added", None) or []),
                    "missing": list(getattr(occ, "missing", None) or []),
                    "relabelled": list(getattr(occ, "relabelled", None) or []),
                })

    motif = getattr(item, "motif", None)
    if motif is not None and not isinstance(motif, str):
        errs.append(ValidationError(
            index=i, field="motif", value=_safe_repr(motif),
            message=f"motif must be a str or None, got {type(motif).__name__}.",
        ))

    if errs:
        return None, errs

    return {
        "start_ms":          int(item.start_ms),
        "duration_ms":       int(item.duration_ms),
        "label":             item.label,
        **({"motif": motif} if motif else {}),
        "repeat_count":      int(item.repeat_count),
        "highlighted_beats": [int(x) for x in (item.highlighted_beats or [])] or None,
        "spans":             clean_spans or None,
        "steps_per_cycle":   int(item.steps_per_cycle) if item.steps_per_cycle is not None else None,
        **({"rows": clean_rows} if clean_rows else {}),
        **({"occurrences": clean_occurrences} if clean_occurrences else {}),
    }, []


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

    if errs:
        return None, errs

    return {
        "time_ms": int(item.time_ms),
        "text":    item.text,
        "kind":    item.kind,
        "end_ms":  int(item.end_ms) if item.end_ms is not None else None,
        "source":  item.source,
    }, []


_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


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


def _parse_beats_per_bar(ts: str) -> int:
    try:
        n = int(str(ts).split("/")[0])
        return n if n > 0 else 4
    except Exception:
        return 4


def _build_context(audio_path: Path, slug: str) -> DetectionContext:
    """Heavy lifting: load audio, extract features, compute curves, locate stems."""
    audio = load_audio(str(audio_path))
    features = extract_features(audio)
    energy = compute_energy_curve(features)
    tension = compute_tension_curve(features, energy)

    beat_times_ms: list[int] = []
    if features.beat_frames is not None and features.sr and features.hop_length:
        # frame_index → seconds → ms
        beat_seconds = features.beat_frames * features.hop_length / features.sr
        beat_times_ms = [int(round(t * 1000)) for t in beat_seconds.tolist()]

    # SongInfo overlay — curator-confirmed grid params take precedence over
    # the feature extractor's auto-detected tempo. Missing fields fall
    # back to the legacy defaults (4/4, offset 0, static mode).
    song_info = _load_song_info(slug)
    si_bpm = song_info.get("bpm")
    bpm_value = float(si_bpm) if isinstance(si_bpm, (int, float)) and si_bpm > 0 else (
        float(features.tempo) if features.tempo is not None else 0.0
    )
    time_signature = str(song_info.get("timeSignature") or "4/4")
    grid_offset_ms = int(round(float(song_info.get("gridOffset") or 0.0) * 1000))
    grid_mode = song_info.get("gridMode") or "static"
    if grid_mode not in ("static", "mapped", "manual"):
        grid_mode = "static"

    return DetectionContext(
        audio=audio.y,
        sr=audio.sr,
        duration_ms=audio.duration_ms,
        stems=_load_stems(slug, audio_path),
        features=features,
        energy_curve=np.asarray(energy, dtype=np.float32),
        tension_curve=np.asarray(tension, dtype=np.float32),
        bpm=bpm_value,
        beat_times_ms=beat_times_ms,
        slug=slug,
        grid_offset_ms=grid_offset_ms,
        time_signature=time_signature,
        beats_per_bar=_parse_beats_per_bar(time_signature),
        grid_mode=grid_mode,
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
    "get_cached",
    "result_path",
    "delete_results_for",
    "asdict",
]
