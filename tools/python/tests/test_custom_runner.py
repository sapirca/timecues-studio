"""Runner validation tests.

These tests bypass the real audio pipeline by calling the validator directly.
End-to-end invocation (load audio → extract features → detect → persist) is
covered by manual integration testing per the plan's verification section.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_api import Boundary, Cue, Span  # noqa: E402
from custom_runner import _validate_items  # noqa: E402


# ─── Boundary validation ─────────────────────────────────────────────────────


def test_boundary_happy_path():
    items, errs = _validate_items(
        [Boundary(time_ms=0), Boundary(time_ms=500, label="x", importance="critical")],
        "boundary",
        duration_ms=1000,
    )
    assert errs == []
    assert items == [
        {"time_ms": 0, "label": None, "importance": None, "candidates": None},
        {"time_ms": 500, "label": "x", "importance": "critical", "candidates": None},
    ]


def test_non_list_return_is_rejected():
    items, errs = _validate_items({"not": "a list"}, "boundary", duration_ms=1000)
    assert items == []
    assert len(errs) == 1
    assert errs[0].field == "<return>"
    assert "must return a list" in errs[0].message


def test_wrong_dataclass_type_is_dropped():
    # Span passed where Boundary is required → drop with error.
    items, errs = _validate_items(
        [Span(start_ms=0, duration_ms=100), Boundary(time_ms=200)],
        "boundary",
        duration_ms=1000,
    )
    assert len(items) == 1
    assert items[0]["time_ms"] == 200
    assert len(errs) == 1
    assert errs[0].index == 0
    assert "Boundary instance" in errs[0].message


def test_time_ms_out_of_bounds():
    items, errs = _validate_items(
        [Boundary(time_ms=-5), Boundary(time_ms=999_999_999), Boundary(time_ms=500)],
        "boundary",
        duration_ms=1000,
    )
    assert len(items) == 1
    assert items[0]["time_ms"] == 500
    assert len(errs) == 2
    assert all(e.field == "time_ms" for e in errs)


def test_time_ms_must_be_int_not_float():
    items, errs = _validate_items([Boundary(time_ms=500.5)], "boundary", duration_ms=1000)  # type: ignore[arg-type]
    assert items == []
    assert len(errs) == 1
    assert errs[0].field == "time_ms"


def test_importance_only_allowed_values():
    items, errs = _validate_items(
        [Boundary(time_ms=100, importance="must-have")],  # type: ignore[arg-type]
        "boundary",
        duration_ms=1000,
    )
    assert items == []
    assert len(errs) == 1
    assert errs[0].field == "importance"


def test_candidates_validated_per_entry():
    items, errs = _validate_items(
        [Boundary(time_ms=100, candidates=[50, 200, -1])],
        "boundary",
        duration_ms=1000,
    )
    assert items == []
    assert len(errs) == 1
    assert "candidates[2]" in (errs[0].field or "")


def test_garbage_items_each_get_their_own_error():
    items, errs = _validate_items(
        [None, "string", {"time_ms": -5}, Boundary(time_ms=99_999_999)],
        "boundary",
        duration_ms=10_000,
    )
    assert items == []
    assert len(errs) == 4
    assert {e.index for e in errs} == {0, 1, 2, 3}


def test_numpy_int_is_accepted_as_time_ms():
    np = pytest.importorskip("numpy")
    items, errs = _validate_items(
        [Boundary(time_ms=np.int64(500))],  # type: ignore[arg-type]
        "boundary",
        duration_ms=1000,
    )
    assert errs == []
    assert items[0]["time_ms"] == 500
    assert isinstance(items[0]["time_ms"], int)  # coerced to plain int for JSON


def test_bool_is_not_accepted_as_int():
    # bool is technically an int subclass — we explicitly reject it.
    items, errs = _validate_items([Boundary(time_ms=True)], "boundary", duration_ms=1000)  # type: ignore[arg-type]
    assert items == []
    assert errs[0].field == "time_ms"


# ─── Cue validation (point events) ───────────────────────────────────────────


def test_cue_happy_path():
    items, errs = _validate_items(
        [Cue(time_ms=500, label="kick", description="first downbeat", intensity=0.7)],
        "cue",
        duration_ms=1000,
    )
    assert errs == []
    assert items == [
        {"time_ms": 500, "label": "kick", "description": "first downbeat",
         "intensity": 0.7, "candidates": None},
    ]


def test_cue_time_ms_out_of_bounds():
    items, errs = _validate_items(
        [Cue(time_ms=-1), Cue(time_ms=2000), Cue(time_ms=500)],
        "cue",
        duration_ms=1000,
    )
    assert len(items) == 1
    assert items[0]["time_ms"] == 500
    assert len(errs) == 2
    assert all(e.field == "time_ms" for e in errs)


def test_cue_time_ms_must_be_int_not_float():
    items, errs = _validate_items([Cue(time_ms=500.5)], "cue", duration_ms=1000)  # type: ignore[arg-type]
    assert items == []
    assert errs[0].field == "time_ms"


def test_cue_description_must_be_str_or_none():
    items, errs = _validate_items(
        [Cue(time_ms=100, description=123)],  # type: ignore[arg-type]
        "cue",
        duration_ms=1000,
    )
    assert items == []
    assert any(e.field == "description" for e in errs)


def test_cue_intensity_out_of_range():
    items, errs = _validate_items(
        [Cue(time_ms=100, intensity=1.5)],
        "cue",
        duration_ms=1000,
    )
    assert items == []
    assert any(e.field == "intensity" for e in errs)


def test_cue_rejects_span_instance():
    # Span passed where Cue is required → drop with error.
    items, errs = _validate_items(
        [Span(start_ms=0, duration_ms=100), Cue(time_ms=200)],
        "cue",
        duration_ms=1000,
    )
    assert len(items) == 1
    assert items[0]["time_ms"] == 200
    assert errs[0].index == 0
    assert "Cue instance" in errs[0].message


# ─── Span validation (intervals — backend-only for now) ──────────────────────


def test_span_happy_path():
    items, errs = _validate_items(
        [Span(start_ms=0, duration_ms=500, label="vox", intensity=0.7)],
        "span",
        duration_ms=1000,
    )
    assert errs == []
    assert items == [
        {"start_ms": 0, "duration_ms": 500, "label": "vox", "intensity": 0.7},
    ]


def test_span_zero_duration_rejected():
    items, errs = _validate_items([Span(start_ms=0, duration_ms=0)], "span", duration_ms=1000)
    assert items == []
    assert any(e.field == "duration_ms" for e in errs)


def test_span_overlapping_track_end():
    items, errs = _validate_items([Span(start_ms=900, duration_ms=200)], "span", duration_ms=1000)
    assert items == []
    assert any("exceeds track length" in e.message for e in errs)


def test_span_intensity_out_of_range():
    items, errs = _validate_items(
        [Span(start_ms=0, duration_ms=100, intensity=1.5)],
        "span",
        duration_ms=1000,
    )
    assert items == []
    assert any(e.field == "intensity" for e in errs)


def test_span_rejects_cue_instance():
    # Cue (point) passed where Span (interval) is required → drop with error.
    items, errs = _validate_items(
        [Cue(time_ms=0), Span(start_ms=200, duration_ms=100)],
        "span",
        duration_ms=1000,
    )
    assert len(items) == 1
    assert items[0]["start_ms"] == 200
    assert errs[0].index == 0
    assert "Span instance" in errs[0].message


# ─── Subprocess isolation (honest-mistakes guard) ────────────────────────────


import os as _os  # noqa: E402

import custom_runner  # noqa: E402

_POSIX_FORK = hasattr(_os, "fork") and sys.platform != "win32"
posix_only = pytest.mark.skipif(not _POSIX_FORK, reason="POSIX fork() required")


class _OkDetector:
    output_kind = "boundary"

    def detect(self, ctx):
        return [Boundary(time_ms=100), Boundary(time_ms=500)]


class _RaisingDetector:
    output_kind = "boundary"

    def detect(self, ctx):
        raise ValueError("intentional")


class _SleepyDetector:
    output_kind = "boundary"

    def detect(self, ctx):
        import time
        time.sleep(60)
        return []


class _BusyDetector:
    output_kind = "boundary"

    def detect(self, ctx):
        x = 0
        while True:
            x += 1


@posix_only
def test_isolation_happy_path():
    kind, payload = custom_runner._run_detect_isolated(_OkDetector(), None)
    assert kind == "ok"
    assert len(payload) == 2
    assert payload[0].time_ms == 100
    assert payload[1].time_ms == 500


@posix_only
def test_isolation_captures_python_exception():
    kind, payload = custom_runner._run_detect_isolated(_RaisingDetector(), None)
    assert kind == "error"
    assert payload["type"] == "ValueError"
    assert payload["message"] == "intentional"
    assert "ValueError" in payload["traceback"]


@posix_only
def test_isolation_kills_wall_clock_runaway(monkeypatch):
    monkeypatch.setattr(custom_runner, "_DETECT_WALL_LIMIT_SEC", 1)
    kind, payload = custom_runner._run_detect_isolated(_SleepyDetector(), None)
    assert kind == "timeout"
    assert payload == 1


@posix_only
def test_isolation_kills_cpu_runaway(monkeypatch):
    # CPU rlimit at 1 sec; wide wall budget so RLIMIT_CPU is the trigger we
    # exercise. On some CI runners the wall clock may still fire first; either
    # outcome is an acceptable honest-mistakes guard.
    monkeypatch.setattr(custom_runner, "_DETECT_CPU_LIMIT_SEC", 1)
    monkeypatch.setattr(custom_runner, "_DETECT_WALL_LIMIT_SEC", 20)
    kind, _payload = custom_runner._run_detect_isolated(_BusyDetector(), None)
    assert kind in ("cpu", "timeout")


@posix_only
def test_fatal_from_isolation_error_path():
    fatal = custom_runner._fatal_from_isolation(
        "error",
        {"type": "ValueError", "message": "x", "traceback": "tb"},
    )
    assert fatal["type"] == "ValueError"
    assert fatal["message"] == "x"
    assert fatal["traceback"] == "tb"


@posix_only
def test_fatal_from_isolation_timeout_messages():
    fatal = custom_runner._fatal_from_isolation("timeout", 5)
    assert fatal["type"] == "TimeoutError"
    assert "5s wall-clock" in fatal["message"]

    fatal = custom_runner._fatal_from_isolation("cpu", 3)
    assert fatal["type"] == "TimeoutError"
    assert "3s CPU-time" in fatal["message"]

    fatal = custom_runner._fatal_from_isolation("oom", 2 * 1024 ** 3)
    assert fatal["type"] == "MemoryError"
    assert "2.0 GiB" in fatal["message"]

    fatal = custom_runner._fatal_from_isolation("crash", -11)
    assert fatal["type"] == "RuntimeError"
    assert "-11" in fatal["message"]
