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

from custom_api import Boundary, Cue, Loop, Pattern, Span  # noqa: E402
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
             intensity=0.7, candidates=[490, 510])],
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


def test_pattern_dict_matches_ts_interface():
    accepted, errs = _validate_items(
        [Pattern(start_ms=0, duration_ms=2000, label="kick-snare",
                 repeat_count=4, highlighted_beats=[0, 4, 8, 12])],
        "pattern",
        duration_ms=20_000,
    )
    assert errs == []
    ts_fields = _parse_ts_interface_fields("CustomPatternItem")
    py_keys = set(accepted[0].keys())
    assert py_keys == ts_fields, (
        f"Pattern schema drift!\n"
        f"  Python: {sorted(py_keys)}\n  TS: {sorted(ts_fields)}"
    )


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
