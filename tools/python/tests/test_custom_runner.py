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

import numpy as np  # noqa: E402
from custom_api import Boundary, Cue, DetectionContext, Loop, Span  # noqa: E402
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


def test_cue_struck_hit_fields_pass_through():
    items, errs = _validate_items(
        [Cue(time_ms=100, label="kick", velocity=112, level_db=-3.2, color="#F87171",
             note=36, decay_ms=180, importance="optional")],
        "cue",
        duration_ms=1000,
    )
    assert errs == []
    assert items[0]["velocity"] == 112
    assert items[0]["level_db"] == -3.2
    assert items[0]["color"] == "#f87171"
    assert items[0]["note"] == 36
    assert items[0]["decay_ms"] == 180
    assert items[0]["importance"] == "optional"


def test_cue_without_struck_hit_fields_keeps_old_shape():
    items, _ = _validate_items([Cue(time_ms=100)], "cue", duration_ms=1000)
    assert set(items[0]) == {"time_ms", "label", "description", "intensity", "candidates"}


@pytest.mark.parametrize("field,value", [
    ("velocity", 0), ("velocity", 128), ("velocity", 64.0), ("velocity", True),
    ("level_db", 0.5), ("level_db", float("nan")), ("level_db", "loud"),
    ("color", "red"), ("color", "#fff"), ("color", 0xff0000),
    ("note", -1), ("note", 128), ("note", 60.0),
    ("decay_ms", 0), ("decay_ms", -5), ("decay_ms", 12.5),
    ("importance", "high"),
])
def test_cue_struck_hit_fields_rejected(field, value):
    items, errs = _validate_items(
        [Cue(time_ms=100, **{field: value})],
        "cue",
        duration_ms=1000,
    )
    assert items == []
    assert [e.field for e in errs] == [field]


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


def test_span_pulse_is_written_only_when_set():
    items, errs = _validate_items(
        [Span(start_ms=0, duration_ms=100, pulse="16th"),
         Span(start_ms=100, duration_ms=100, pulse="silent"),
         Span(start_ms=200, duration_ms=100)],
        "span",
        duration_ms=1000,
    )
    assert errs == []
    assert [it.get("pulse") for it in items] == ["16th", "silent", None]
    assert "pulse" not in items[2]


def test_span_pulse_outside_the_vocabulary_is_rejected():
    items, errs = _validate_items(
        [Span(start_ms=0, duration_ms=100, pulse="quarter")],  # type: ignore[arg-type]
        "span",
        duration_ms=1000,
    )
    assert items == []
    assert any(e.field == "pulse" for e in errs)


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
    items = payload["items"]
    assert len(items) == 2
    assert items[0].time_ms == 100
    assert items[1].time_ms == 500
    assert payload["notes"] == []


class _WarningDetector:
    output_kind = "boundary"

    def detect(self, ctx):
        ctx.warn("thin-input", "measured almost nothing to go on")
        ctx.warn("thin-input", "a second call with the same code")
        return []


@posix_only
def test_a_warning_raised_inside_the_child_reaches_the_parent():
    """detect() runs in a forked child, so anything it recorded on ctx dies
    with that process unless it travels back with the items. A caveat that
    silently evaporates is worse than none: the envelope then positively
    asserts there was nothing to say."""
    ctx = DetectionContext(
        audio=np.zeros(1, dtype=np.float32), sr=22050, duration_ms=1000,
        stems={}, features=None, energy_curve=np.zeros(1), tension_curve=np.zeros(1),
        bpm=120.0, beat_times_ms=[0],
    )
    kind, payload = custom_runner._run_detect_isolated(_WarningDetector(), ctx)
    assert kind == "ok"
    # Deduplicated by code — a per-hit check can call warn() in a loop.
    assert payload["notes"] == [
        {"code": "thin-input", "message": "measured almost nothing to go on"},
    ]
    # The parent's own ctx is untouched: the child mutated its copy.
    assert ctx.notes == []


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


# ─── Per-item colour, shared by every kind ──────────────────────────────────


@pytest.mark.parametrize("kind,item", [
    ("boundary", lambda c: Boundary(time_ms=100, color=c)),
    ("cue", lambda c: Cue(time_ms=100, color=c)),
    ("span", lambda c: Span(start_ms=100, duration_ms=200, color=c)),
    ("loop", lambda c: Loop(start_ms=100, duration_ms=200, color=c)),
])
def test_every_kind_takes_an_optional_color(kind, item):
    items, errs = _validate_items([item("#A3E635")], kind, duration_ms=1000)
    assert errs == [] and items[0]["color"] == "#a3e635"
    items, errs = _validate_items([item(None)], kind, duration_ms=1000)
    assert errs == [] and "color" not in items[0]
    items, errs = _validate_items([item("green")], kind, duration_ms=1000)
    assert items == [] and [e.field for e in errs] == ["color"]


# ─── output_kind = "lanes" ───────────────────────────────────────────────────

def test_each_lane_is_validated_as_its_own_kind():
    from custom_api import Lane, Riff, RiffEntry, RiffItem, RiffNode, RiffNote
    from custom_runner import _validate_lanes

    node = RiffNode(id="a", name="A", steps_per_cycle=4, notes=[RiffNote(start=0, end=0.25)])
    lanes, errs = _validate_lanes([
        Lane(id="kick_notes", label="Kick notes", output_kind="cue", group="Kick",
             items=[Cue(time_ms=100), Cue(time_ms=99_999)]),
        Lane(id="kick_pattern", label="Kick pattern", output_kind="riff", group="Kick",
             items=Riff(nodes=[node], items=[RiffItem(start=0, end=0.5,
                                                      sequence=[RiffEntry(type="a", length_steps=4)])])),
    ], duration_ms=1000)
    assert [(l["id"], l["output_kind"], l["group"], len(l["items"])) for l in lanes] == [
        ("kick_notes", "cue", "Kick", 1), ("kick_pattern", "riff", "Kick", 1)]
    assert [n["id"] for n in lanes[1]["nodes"]] == ["a"]
    # The cue past the end is dropped alone, and its error names its lane.
    assert len(errs) == 1 and errs[0].field.startswith("kick_notes.items[1]")


def test_a_malformed_lane_is_dropped_whole_and_the_rest_kept():
    from custom_api import Lane
    from custom_runner import _validate_lanes

    lanes, errs = _validate_lanes([
        Lane(id="ok", label="Fine", output_kind="cue", items=[Cue(time_ms=1)]),
        Lane(id="ok", label="Same id", output_kind="cue", items=[]),
        Lane(id="Bad Id", label="x", output_kind="cue", items=[]),
        Lane(id="nested", label="x", output_kind="lanes", items=[]),
        Lane(id="nolabel", label=" ", output_kind="cue", items=[]),
    ], duration_ms=1000)
    assert [l["id"] for l in lanes] == ["ok"]
    assert [e.field for e in errs] == [
        "lanes[1].id", "lanes[2].id", "lanes[3].output_kind", "lanes[4].label"]


def test_lanes_must_be_a_list():
    from custom_runner import _validate_lanes

    lanes, errs = _validate_lanes({"kick": []}, duration_ms=1000)
    assert lanes == [] and errs[0].field == "<return>"


def test_a_section_run_is_merged_lane_by_lane():
    from custom_runner import merge_window_lanes

    cue = lambda ms, label=None: {"time_ms": ms, "label": label}  # noqa: E731
    base = [
        {"id": "onsets", "label": "Onsets", "output_kind": "cue", "group": None,
         "items": [cue(100, "a"), cue(1500, "b"), cue(5000, "c")]},
        {"id": "untouched", "label": "Other", "output_kind": "cue", "group": None,
         "items": [cue(1200)]},
    ]
    incoming = [
        {"id": "onsets", "label": "Onsets", "output_kind": "cue", "group": None,
         "items": [cue(1300, "x")]},
        {"id": "fresh", "label": "New", "output_kind": "cue", "group": None,
         "items": [cue(1100)]},
    ]
    lanes, stats = merge_window_lanes(base, incoming, 1000, 2000, "replace")
    by_id = {l["id"]: [it["time_ms"] for it in l["items"]] for l in lanes}
    # Inside the window the run replaces the lane's items; outside, nothing moves.
    assert by_id == {"onsets": [100, 1300, 5000], "untouched": [1200], "fresh": [1100]}
    assert [l["id"] for l in lanes] == ["onsets", "untouched", "fresh"]
    assert stats == {"added": 2, "removed": 1, "duplicates": 0}


def test_another_detector_reads_one_lane_of_a_saved_lanes_result():
    from custom_runner import lane_view

    saved = {"output_kind": "lanes", "items": [], "fatal": None, "lanes": [
        {"id": "hits", "label": "Hits", "output_kind": "cue", "group": "Drums",
         "items": [{"time_ms": 10, "label": "kick"}]},
        {"id": "grooves", "label": "Grooves", "output_kind": "pattern", "group": "Drums", "items": []},
    ]}
    hits = lane_view(saved, "hits")
    assert hits["output_kind"] == "cue" and hits["items"] == [{"time_ms": 10, "label": "kick"}]
    assert lane_view(saved, "nope")["items"] == []
    # A result saved before its detector had lanes is read as it is.
    old = {"output_kind": "cue", "items": [{"time_ms": 5}]}
    assert lane_view(old, "hits") is old
    assert lane_view(None, "hits") is None
