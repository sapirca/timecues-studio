"""Schema-roundtrip test: Python custom-detector output dicts ↔ TypeScript types.

The web app (`web-app/src/types/customScript.ts`) and the Python runner
(`custom_runner._validate_items`) must agree on the exact field names and
shapes of every custom-detector item — silent drift here is the most-burned
boundary in the repo. This test pins both sides:

  1. Build a synthetic detector output of each kind (Boundary, Cue, Span,
     Loop, Riff), push it through the runner's validator, and assert the
     accepted-dict keys match the keys the TypeScript types declare — for a
     riff, the Riff Patterns layer's own types in annotationLayer.ts, since a
     detector's riff IS that layer.
  2. JSON-roundtrip the envelope shape (the runner's persisted format) and
     assert it survives unchanged.

If you rename a field on either side (Python dataclass, TS interface, or the
runner's accepted-dict literal), this test fails with a key-set diff.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_api import (  # noqa: E402
    Boundary, Cue, Loop, Riff, RiffEntry, RiffItem, RiffNode, RiffNote, RiffOccurrence, Span,
)
from custom_runner import _validate_items, _validate_riff  # noqa: E402


# ─── TS type → expected key set ──────────────────────────────────────────────
#
# Parsed lazily from web-app/src/types/customScript.ts by walking each
# `export interface CustomXItem { ... }` body and collecting field names.
# Hardcoding these here would defeat the test's purpose (the test would still
# pass after a one-sided rename). Parsing keeps the source-of-truth on the TS
# side: the test fails when the TS file drifts from the Python validator.

_TS_TYPES_PATH = (
    Path(__file__).resolve().parents[3]
    / "web-app" / "src" / "types" / "customScript.ts"
)


_TS_LAYER_TYPES_PATH = _TS_TYPES_PATH.parent / "annotationLayer.ts"


def _parse_ts_interface_fields(name: str, path: Path = _TS_TYPES_PATH) -> set[str]:
    """Return the set of field names declared on `export interface <name>`.

    Strips comments and recognizes a field as `<ident>?: ...;` or `<ident>: ...;`
    at the start of a line. Doesn't try to parse types — only names matter
    here, and a name mismatch is what the test is guarding against.
    """
    src = path.read_text()
    # Find the interface block: `export interface Name {  ...  }`
    pattern = re.compile(
        rf"export\s+interface\s+{re.escape(name)}\s*\{{(.*?)\n\}}",
        re.DOTALL,
    )
    m = pattern.search(src)
    if not m:
        raise AssertionError(f"interface {name} not found in {path}")
    body = m.group(1)
    # Strip `/* ... */` block comments and `// ...` line comments.
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    body = re.sub(r"//[^\n]*", "", body)

    fields: set[str] = set()
    depth = 0
    for line in body.splitlines():
        line = line.strip()
        # `ident?: ...` or `ident: ...` — at the interface's own level only:
        # the fields of a nested object type (`window?: { start_ms: … }`)
        # belong to that object, not to the interface.
        m = re.match(r"([a-zA-Z_][a-zA-Z0-9_]*)\s*\??\s*:", line)
        if m and depth == 0:
            fields.add(m.group(1))
        depth += line.count("{") - line.count("}")
    return fields


# ─── Roundtrip per output_kind ───────────────────────────────────────────────


def test_boundary_dict_matches_ts_interface():
    """Accepted Boundary dict keys must exactly match CustomBoundaryItem fields."""
    accepted, errs = _validate_items(
        [Boundary(time_ms=500, label="drop", importance="critical",
                  candidates=[480, 520], color="#f87171")],
        "boundary",
        duration_ms=10_000,
    )
    assert errs == []
    assert len(accepted) == 1
    ts_fields = _parse_ts_interface_fields("CustomBoundaryItem")
    py_keys = set(accepted[0].keys())
    assert py_keys == ts_fields, (
        f"Boundary schema drift!\n"
        f"  Python keys: {sorted(py_keys)}\n"
        f"  TS fields:   {sorted(ts_fields)}\n"
        f"  Python only: {sorted(py_keys - ts_fields)}\n"
        f"  TS only:     {sorted(ts_fields - py_keys)}"
    )


def test_cue_dict_matches_ts_interface():
    accepted, errs = _validate_items(
        [Cue(time_ms=500, label="kick", description="first downbeat",
             intensity=0.7, candidates=[490, 510],
             velocity=100, level_db=-3.5, color="#f87171",
             note=36, decay_ms=180, importance="critical")],
        "cue",
        duration_ms=10_000,
    )
    assert errs == []
    assert len(accepted) == 1
    ts_fields = _parse_ts_interface_fields("CustomCueItem")
    py_keys = set(accepted[0].keys())
    assert py_keys == ts_fields, (
        f"Cue schema drift!\n"
        f"  Python keys: {sorted(py_keys)}\n"
        f"  TS fields:   {sorted(ts_fields)}\n"
        f"  Python only: {sorted(py_keys - ts_fields)}\n"
        f"  TS only:     {sorted(ts_fields - py_keys)}"
    )


def test_span_dict_matches_ts_interface():
    accepted, errs = _validate_items(
        [Span(start_ms=1000, duration_ms=2000, label="vox", intensity=0.5, color="#38bdf8",
              description="sung", pulse="8th")],
        "span",
        duration_ms=10_000,
    )
    assert errs == []
    ts_fields = _parse_ts_interface_fields("CustomSpanItem")
    py_keys = set(accepted[0].keys())
    assert py_keys == ts_fields, (
        f"Span schema drift!\n"
        f"  Python: {sorted(py_keys)}\n  TS: {sorted(ts_fields)}"
    )


def test_loop_dict_matches_ts_interface():
    accepted, errs = _validate_items(
        [Loop(start_ms=1000, duration_ms=2000, label="drums", snap_zero_cross=True, color="#a3e635")],
        "loop",
        duration_ms=10_000,
    )
    assert errs == []
    ts_fields = _parse_ts_interface_fields("CustomLoopItem")
    py_keys = set(accepted[0].keys())
    assert py_keys == ts_fields, (
        f"Loop schema drift!\n"
        f"  Python: {sorted(py_keys)}\n  TS: {sorted(ts_fields)}"
    )


# ─── Riffs: the one shape a repeated figure takes ────────────────────────────


def _kick_riff(**over) -> Riff:
    node = RiffNode(id="a", name="A", steps_per_cycle=16, color="#f87171",
                    names=["four on the floor"],
                    notes=[RiffNote(start=0, end=0.25, accent=120), RiffNote(start=1, end=1.25),
                           RiffNote(start=2, end=3, label="C1", note=24)])
    item = RiffItem(start=1.0, end=3.0, label="A", repeat_count=4,
                    sequence=[RiffEntry(type="a", length_steps=16)],
                    occurrences=[RiffOccurrence(index=3, event="variation",
                                                added=[RiffNote(start=3.5, end=3.75, accent=70)],
                                                missing=[1.0])])
    return Riff(**{"nodes": [node], "items": [item], "drum": "kick", **over})


def test_a_riff_is_the_riff_patterns_layer_shape():
    """Every key a detector's riff writes is a field of the app's Riff
    Patterns types — the layer stores it as it comes."""
    riff, errs = _validate_riff(_kick_riff(), duration_ms=20_000)
    assert errs == []
    riff = json.loads(json.dumps(riff))
    node, item = riff["nodes"][0], riff["items"][0]
    layer = lambda name: _parse_ts_interface_fields(name, _TS_LAYER_TYPES_PATH)  # noqa: E731
    assert set(node) == layer("RiffNode")
    assert set(node["segments"][0]) <= layer("RiffBoundarySegment")
    assert {"accent", "label", "note"} <= {k for sg in node["segments"] for k in sg}
    assert set(item) <= layer("RiffPatternItem")
    assert set(item["occurrences"][0]) == layer("RiffOccurrence")
    assert set(item["sequence"][0]) == layer("RiffSeqEntry")
    assert set(item["occurrences"][0]["added"][0]) <= layer("RiffBoundarySegment") - {"kind"}
    assert riff["drum"] == "kick"


def test_a_node_s_rests_are_filled_in():
    """A detector writes notes; the node stores them tiling its length."""
    riff, _ = _validate_riff(_kick_riff(), duration_ms=20_000)
    shape = [(sg["start"], sg["end"], sg["kind"]) for sg in riff["nodes"][0]["segments"]]
    assert shape == [(0, 0.25, "tick"), (0.25, 1, "empty"), (1, 1.25, "tick"),
                     (1.25, 2, "empty"), (2, 3, "tick"), (3, 4, "empty")]


def test_a_bad_node_goes_with_the_items_that_play_it():
    bad = RiffNode(id="a", name="A", steps_per_cycle=16, subbeats_per_beat=5, notes=[])
    riff, errs = _validate_riff(_kick_riff(nodes=[bad]), duration_ms=20_000)
    assert riff["nodes"] == [] and riff["items"] == []
    assert any(e.field == "nodes[0].subbeats_per_beat" for e in errs)
    assert any("sequence" in (e.field or "") for e in errs)


def test_a_note_off_the_node_or_an_accent_out_of_range_is_dropped():
    node = RiffNode(id="a", name="A", steps_per_cycle=16,
                    notes=[RiffNote(start=3.5, end=4.5), RiffNote(start=0, end=0.25, accent=200),
                           RiffNote(start=1, end=1.25)])
    riff, errs = _validate_riff(Riff(nodes=[node], items=[]), duration_ms=20_000)
    assert [sg["start"] for sg in riff["nodes"][0]["segments"] if sg["kind"] == "tick"] == [1]
    assert len(errs) == 2


def test_an_occurrence_must_name_a_play_of_its_item():
    riff = _kick_riff()
    riff.items[0].occurrences = [RiffOccurrence(index=4, event="fill"),
                                 RiffOccurrence(index=0, event="louder")]
    out, errs = _validate_riff(riff, duration_ms=20_000)
    assert "occurrences" not in out["items"][0]
    assert len(errs) == 2


def test_a_riff_detector_must_return_a_riff():
    out, errs = _validate_riff([], duration_ms=20_000)
    assert out == {"nodes": [], "combos": [], "items": []}
    assert errs[0].field == "<return>"


# ─── Envelope-level shape (what gets persisted + shipped to the UI) ──────────


def test_envelope_shape_matches_ts_interface():
    """The on-disk envelope keys must match CustomResultEnvelope on the TS side.

    We don't run the full `run()` pipeline (it needs audio); we use the same
    `_empty_envelope` factory and fill in the validated items as `run()`
    would, then assert the key set survives JSON-roundtrip and matches TS.
    """
    from custom_runner import _empty_envelope

    env = _empty_envelope("demo_detector", "demo_song")
    items, _ = _validate_items(
        [Boundary(time_ms=500)], "boundary", duration_ms=10_000,
    )
    env["items"] = items
    env["duration_ms"] = 10_000

    roundtripped = json.loads(json.dumps(env))
    # Set only on a section run's envelope (window, window_token) or on an
    # output a section run was folded into (window_runs) — never on a
    # whole-song run's. TS must still declare them.
    window_only = {"window", "window_token", "window_runs"}
    # Set only by a detector that offers Strict / Normal / Loose.
    strictness_only = {"strictness"}
    # Set only by a detector that offers a drum source, or a run that read drums.
    drums_only = {"drum_source", "drum_read"}
    # Set only by a detector that offers a section source.
    sections_only = {"section_source", "section_read"}
    # Set only by a detector whose output_kind is "lanes" (dropped_lanes: once
    # a cached lane a run no longer returns was dropped); see the test below.
    lanes_only = {"lanes", "dropped_lanes"}
    # Set only by a detector that declares switches.
    switches_only = {"switches"}
    # Set only by a detector that declares sources.
    sources_only = {"source", "source_read"}
    # Set only by a detector whose output_kind is "riff": the lane's library.
    riff_only = {"nodes", "combos", "drum", "summary"}
    optional = (window_only | strictness_only | drums_only | sections_only | lanes_only
                | switches_only | sources_only | riff_only)
    all_ts_fields = _parse_ts_interface_fields("CustomResultEnvelope")
    assert optional <= all_ts_fields
    ts_fields = all_ts_fields - optional
    py_keys = set(roundtripped.keys())
    assert py_keys == ts_fields, (
        f"Envelope schema drift!\n"
        f"  Python: {sorted(py_keys)}\n  TS: {sorted(ts_fields)}\n"
        f"  Python only: {sorted(py_keys - ts_fields)}\n"
        f"  TS only:     {sorted(ts_fields - py_keys)}"
    )


# ─── Sanity: TS-side type guard catches a mis-shaped value ───────────────────


def test_validation_error_shape_matches_ts():
    """ValidationError.to_dict() must produce keys matching CustomValidationError."""
    items, errs = _validate_items([Boundary(time_ms=-5)], "boundary", duration_ms=1000)
    assert items == []
    assert len(errs) == 1
    err_dict = errs[0].to_dict()
    ts_fields = _parse_ts_interface_fields("CustomValidationError")
    py_keys = set(err_dict.keys())
    assert py_keys == ts_fields, (
        f"ValidationError schema drift!\n"
        f"  Python: {sorted(py_keys)}\n  TS: {sorted(ts_fields)}"
    )


# ─── Pre-flight: the TS file is present and parseable ────────────────────────


def test_ts_file_exists():
    """If web-app/src/types/customScript.ts moves, every other test in this
    file would fail with a confusing 'interface not found' error. Surface
    that condition once, here, with a clearer message."""
    assert _TS_TYPES_PATH.is_file(), (
        f"customScript.ts not found at {_TS_TYPES_PATH} — "
        f"did the file move? Update _TS_TYPES_PATH in this test."
    )


def test_a_lane_matches_the_ts_lane_interface():
    """A "lanes" detector's envelope carries `lanes`, each with the fields
    CustomLane declares on the TS side."""
    from custom_api import Cue, Lane
    from custom_runner import _validate_lanes

    lanes, errs = _validate_lanes(
        [Lane(id="kick_notes", label="Kick notes", output_kind="cue", group="Kick",
              items=[Cue(time_ms=500)]),
         Lane(id="kick_pattern", label="Kick pattern", output_kind="riff", group="Kick",
              items=_kick_riff())], duration_ms=10_000)
    assert errs == []
    cue, riff = json.loads(json.dumps(lanes))
    riff_only = {"nodes", "combos", "drum", "summary"}
    assert set(cue) == _parse_ts_interface_fields("CustomLane") - riff_only
    assert set(riff) <= _parse_ts_interface_fields("CustomLane")
    assert {"nodes", "combos", "drum"} <= set(riff)
