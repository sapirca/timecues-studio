"""Schema-roundtrip test: Python custom-detector output dicts ↔ TypeScript types.

The web app (`web-app/src/types/customScript.ts`) and the Python runner
(`custom_runner._validate_items`) must agree on the exact field names and
shapes of every custom-detector item — silent drift here is the most-burned
boundary in the repo. This test pins both sides:

  1. Build a synthetic detector output of each kind (Boundary, Cue, Span,
     Loop, Pattern), push it through `_validate_items`, and assert the
     accepted-dict keys match the keys the TypeScript types declare.
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

from custom_api import PatternOccurrence, PatternRow, Boundary, Cue, Loop, Pattern, Span  # noqa: E402
from custom_runner import _validate_items  # noqa: E402


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


def _parse_ts_interface_fields(name: str) -> set[str]:
    """Return the set of field names declared on `export interface <name>`.

    Strips comments and recognizes a field as `<ident>?: ...;` or `<ident>: ...;`
    at the start of a line. Doesn't try to parse types — only names matter
    here, and a name mismatch is what the test is guarding against.
    """
    src = _TS_TYPES_PATH.read_text()
    # Find the interface block: `export interface Name {  ...  }`
    pattern = re.compile(
        rf"export\s+interface\s+{re.escape(name)}\s*\{{(.*?)\n\}}",
        re.DOTALL,
    )
    m = pattern.search(src)
    if not m:
        raise AssertionError(f"interface {name} not found in {_TS_TYPES_PATH}")
    body = m.group(1)
    # Strip `/* ... */` block comments and `// ...` line comments.
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    body = re.sub(r"//[^\n]*", "", body)

    fields: set[str] = set()
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        # `ident?: ...` or `ident: ...`
        m = re.match(r"([a-zA-Z_][a-zA-Z0-9_]*)\s*\??\s*:", line)
        if m:
            fields.add(m.group(1))
    return fields


# ─── Roundtrip per output_kind ───────────────────────────────────────────────


def test_boundary_dict_matches_ts_interface():
    """Accepted Boundary dict keys must exactly match CustomBoundaryItem fields."""
    accepted, errs = _validate_items(
        [Boundary(time_ms=500, label="drop", importance="critical",
                  candidates=[480, 520])],
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
        [Span(start_ms=1000, duration_ms=2000, label="vox", intensity=0.5)],
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
        [Loop(start_ms=1000, duration_ms=2000, label="drums", snap_zero_cross=True)],
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


def test_pattern_spans_validation_rejects_bad_holds():
    # length < 2 is not a span
    _, e1 = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1, spans=[[3, 1]])],
        "pattern", duration_ms=20_000,
    )
    assert any(err.field.startswith("spans") for err in e1)

    # overlaps a highlighted_beats tick
    _, e2 = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1,
                 highlighted_beats=[5], spans=[[4, 3]], steps_per_cycle=16)],
        "pattern", duration_ms=20_000,
    )
    assert any(err.field.startswith("spans") for err in e2)

    # runs past steps_per_cycle
    _, e3 = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1,
                 spans=[[14, 4]], steps_per_cycle=16)],
        "pattern", duration_ms=20_000,
    )
    assert any(err.field.startswith("spans") for err in e3)

    # two spans overlapping each other
    _, e4 = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1,
                 spans=[[2, 3], [3, 2]], steps_per_cycle=16)],
        "pattern", duration_ms=20_000,
    )
    assert any(err.field.startswith("spans") for err in e4)



# ─── Multi-row patterns (a drum groove is three lines, not one) ──────────────


def test_pattern_rows_and_occurrences_survive_validation():
    """The runner serializes a fixed key set; these have to be in it.

    They were not, once — a detector could emit rows and occurrences and the
    runner would quietly drop them on the way to the envelope, so the UI saw a
    single-row pattern and nothing said why.
    """
    accepted, errs = _validate_items(
        [Pattern(
            start_ms=0, duration_ms=2000, label="groove", repeat_count=4,
            highlighted_beats=[0, 4, 8, 12], steps_per_cycle=16,
            rows=[
                PatternRow(row="kick", highlighted_beats=[0, 8], accents=[120, 60]),
                PatternRow(row="hat", highlighted_beats=[4, 12]),
            ],
            occurrences=[
                PatternOccurrence(index=0, start_ms=0, deviation=0.0),
                PatternOccurrence(index=1, start_ms=2000, deviation=0.25,
                                  missing=[{"row": "hat", "step": 12}]),
            ],
        )],
        "pattern", duration_ms=20_000,
    )
    assert errs == []
    item = accepted[0]
    assert [r["row"] for r in item["rows"]] == ["kick", "hat"]
    assert item["rows"][0]["accents"] == [120, 60]
    assert "accents" not in item["rows"][1], "a row that measured nothing carries no key"
    assert item["occurrences"][1]["deviation"] == 0.25
    assert item["occurrences"][1]["missing"] == [{"row": "hat", "step": 12}]


def test_a_single_row_pattern_is_unchanged_by_the_new_fields():
    accepted, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=2,
                 highlighted_beats=[0, 8], steps_per_cycle=16)],
        "pattern", duration_ms=20_000,
    )
    assert errs == []
    assert "rows" not in accepted[0] and "occurrences" not in accepted[0]


def test_a_row_step_outside_the_cycle_is_rejected():
    _, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1, steps_per_cycle=16,
                 rows=[PatternRow(row="kick", highlighted_beats=[0, 16])])],
        "pattern", duration_ms=20_000,
    )
    assert any(e.field.startswith("rows[0].highlighted_beats") for e in errs)


def test_more_accents_than_steps_is_rejected():
    """accents is positional against highlighted_beats, so a longer list means
    the detector lost track of which velocity belongs to which step."""
    _, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1, steps_per_cycle=16,
                 rows=[PatternRow(row="kick", highlighted_beats=[0], accents=[100, 90])])],
        "pattern", duration_ms=20_000,
    )
    assert any(e.field.startswith("rows[0].accents") for e in errs)


def test_velocities_are_clamped_into_midi_range():
    accepted, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1, steps_per_cycle=16,
                 rows=[PatternRow(row="kick", highlighted_beats=[0, 4], accents=[999, -5])])],
        "pattern", duration_ms=20_000,
    )
    assert errs == []
    assert accepted[0]["rows"][0]["accents"] == [127, 1]


def test_a_deviation_outside_zero_to_one_is_rejected():
    _, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, repeat_count=1, steps_per_cycle=16,
                 occurrences=[PatternOccurrence(index=0, start_ms=0, deviation=1.5)])],
        "pattern", duration_ms=20_000,
    )
    assert any(e.field.startswith("occurrences[0].deviation") for e in errs)

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
    ts_fields = _parse_ts_interface_fields("CustomResultEnvelope")
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


def test_motif_survives_validation_and_is_omitted_when_unset():
    """`motif` is what says two runs are the same figure coming back.

    The letter is computed by the generator and was then dropped on the way
    out, because `Pattern` had no field to carry it — so the UI fell back to
    the run's label and named every node after it, producing "Groove Drum
    groove A (10 hits/bar) · Kick", which is truncated to "Gro…" on the canvas
    and loses the only part worth reading.
    """
    accepted, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, label="Drum groove A (10 hits/bar)",
                 repeat_count=4, highlighted_beats=[0, 8], steps_per_cycle=16,
                 motif="A")],
        "pattern", duration_ms=20_000,
    )
    assert errs == []
    assert accepted[0]["motif"] == "A"

    # A detector that names no motif emits no key, rather than a null the UI
    # would have to special-case.
    plain, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, label="x", repeat_count=1,
                 highlighted_beats=[0], steps_per_cycle=16)],
        "pattern", duration_ms=20_000,
    )
    assert errs == []
    assert "motif" not in plain[0]


def test_a_non_string_motif_is_an_error_not_a_coerced_label():
    accepted, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, label="x", repeat_count=1,
                 highlighted_beats=[0], steps_per_cycle=16, motif=7)],
        "pattern", duration_ms=20_000,
    )
    assert accepted == []
    assert any(e.field == "motif" for e in errs)
