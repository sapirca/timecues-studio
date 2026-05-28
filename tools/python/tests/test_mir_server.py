"""MIR-server NaN/inf-safety + JSON-serializability tests.

The web app reads every feature value out of the mir_server response into
typed React props. A NaN, an Inf, or a numpy scalar that didn't get coerced
silently corrupts the algorithm-inspector UI — JSON.stringify on a NaN
emits `null` (browser) or throws (Python `json.dumps(..., allow_nan=False)`),
and either path loses the bug between the server and the eyeballs.

These tests pin:

  * `_f` coerces numpy scalars and arrays-of-one, falls back to NaN on bad
    input rather than raising.
  * `_summary` skips non-finite values and returns all-None for empty/all-NaN
    inputs (so JSON encoders never see NaN downstream).
  * `_safe` collects exceptions into the `errors` list rather than aborting
    the whole extraction — one bad feature mustn't lose the rest.
  * Every `_feat_*` section produces JSON-serializable output on a synthetic
    tone and on near-silence (the two pathological corner cases the
    extraction loop hits in practice).
  * The full `extract()` end-to-end output is JSON-serializable under
    `json.dumps(..., allow_nan=False)` — the strict mode the on-disk cache
    writer effectively assumes.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

librosa = pytest.importorskip("librosa")
soundfile = pytest.importorskip("soundfile")

import mir_server  # noqa: E402
from mir_server import (  # noqa: E402
    _f,
    _safe,
    _summary,
    _feat_dynamics,
    _feat_spectral,
    _feat_timbre,
    _feat_tonal,
    _feat_rhythm,
    _feat_structure,
    extract,
    SR,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def tone():
    """4 seconds of a 220 Hz tone at sr=22050 with a small added click
    every 0.5 s — enough harmonic content for tempo/onset/chroma to fire."""
    sr = SR
    n = int(sr * 4.0)
    t = np.arange(n) / sr
    y = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    rng = np.random.RandomState(0)
    for tc in np.arange(0.0, 4.0, 0.5):
        s = int(tc * sr)
        burst = rng.randn(min(1024, n - s)).astype(np.float32) * 0.2
        y[s:s + len(burst)] += burst
    return y, sr


@pytest.fixture
def near_silence():
    """2 seconds of digital silence with a 1e-9 dither. Past versions of the
    extractor blew up on truly-zero input by dividing by zero in dB
    computations or by feeding empty windows to onset_strength."""
    sr = SR
    n = int(sr * 2.0)
    return (np.full(n, 1e-9, dtype=np.float32), sr)


# ─── `_f` — numpy → JSON-safe float ──────────────────────────────────────────

class TestCoerce:
    def test_plain_float_passes_through(self):
        assert _f(3.14) == 3.14

    def test_numpy_scalar_becomes_python_float(self):
        v = _f(np.float32(2.5))
        assert isinstance(v, float)
        assert v == 2.5

    def test_array_of_one_is_unwrapped(self):
        # This is the exact shape librosa.beat.beat_track returns in 0.10+.
        assert _f(np.array([117.45])) == pytest.approx(117.45)

    def test_zero_d_array_is_handled(self):
        assert _f(np.array(7.0)) == 7.0

    def test_bad_input_returns_nan_rather_than_raising(self):
        # JSON safety guarantee — if _f raised here, the whole extraction
        # would abort and the cache would never be written.
        assert math.isnan(_f("not a number"))
        assert math.isnan(_f(None))
        assert math.isnan(_f(object()))


# ─── `_summary` — drops non-finite, returns None on empty ───────────────────

class TestSummary:
    def test_returns_all_none_for_none_input(self):
        assert _summary(None) == {"mean": None, "std": None, "min": None, "max": None, "median": None}

    def test_returns_all_none_for_empty_array(self):
        assert _summary(np.array([])) == {"mean": None, "std": None, "min": None, "max": None, "median": None}

    def test_returns_all_none_when_every_value_is_nan(self):
        # Bug class: librosa.feature.rms on truly-zero input can yield NaN
        # rows in some versions. If _summary didn't strip them, every stat
        # would be NaN and break JSON serialization.
        nan_arr = np.array([np.nan, np.nan, np.nan])
        assert _summary(nan_arr) == {"mean": None, "std": None, "min": None, "max": None, "median": None}

    def test_strips_non_finite_before_computing_stats(self):
        # Inf/NaN must be filtered. Without the filter, the mean would be
        # +inf, JSON.dumps(..., allow_nan=False) would refuse to encode it.
        mixed = np.array([1.0, 2.0, 3.0, np.inf, -np.inf, np.nan])
        s = _summary(mixed)
        assert s["min"] == 1.0
        assert s["max"] == 3.0
        assert s["mean"] == pytest.approx(2.0)
        assert s["median"] == 2.0

    def test_output_is_json_serializable_in_strict_mode(self):
        s = _summary(np.array([1.0, 2.0, 3.0]))
        # allow_nan=False is the strict mode — a leaked NaN would raise here.
        json.dumps(s, allow_nan=False)


# ─── `_safe` — exception isolation ───────────────────────────────────────────

class TestSafe:
    def test_returns_function_result_on_success(self):
        errors: list[dict] = []
        assert _safe(lambda: 42, errors, "x") == 42
        assert errors == []

    def test_collects_exception_into_errors_returns_none(self):
        errors: list[dict] = []

        def boom():
            raise RuntimeError("kaboom")

        assert _safe(boom, errors, "the_feature") is None
        assert len(errors) == 1
        assert errors[0]["feature"] == "the_feature"
        assert "RuntimeError" in errors[0]["error"]
        assert "kaboom" in errors[0]["error"]


# ─── Per-section finite-ness on a tone and on near-silence ──────────────────

ALL_SECTIONS = [
    _feat_dynamics, _feat_spectral, _feat_timbre,
    _feat_tonal, _feat_rhythm, _feat_structure,
]


def _assert_json_safe(obj, path: str = "") -> None:
    """Walk a nested dict/list and assert every numeric leaf is JSON-safe.
    Raises with the path so a regression points at the exact feature key."""
    if obj is None or isinstance(obj, (bool, str, int)):
        return
    if isinstance(obj, float):
        assert math.isfinite(obj), f"non-finite float at {path or '<root>'}: {obj}"
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            _assert_json_safe(v, f"{path}.{k}" if path else str(k))
        return
    if isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            _assert_json_safe(v, f"{path}[{i}]")
        return
    # Catch numpy types that didn't get coerced — those are the silent bug.
    raise AssertionError(f"non-JSON-native type at {path}: {type(obj).__name__}")


@pytest.mark.parametrize("fn", ALL_SECTIONS, ids=lambda f: f.__name__)
def test_section_output_is_finite_on_tone(fn, tone):
    y, sr = tone
    errors: list[dict] = []
    result = fn(y, sr, errors)
    _assert_json_safe(result)
    # JSON.dumps strict mode is the actual guarantee the cache writer relies on.
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("fn", ALL_SECTIONS, ids=lambda f: f.__name__)
def test_section_does_not_crash_on_near_silence(fn, near_silence):
    """Past extractor versions blew up on near-silent input (div-by-zero in
    dB conversions, empty onset windows). The section must either produce
    JSON-safe output or report the failure into `errors` — never raise."""
    y, sr = near_silence
    errors: list[dict] = []
    result = fn(y, sr, errors)
    # Output is JSON-safe; any failure paths landed in `errors` instead.
    _assert_json_safe(result)
    json.dumps(result, allow_nan=False)
    # Errors are structured strings, not raw exception objects.
    for e in errors:
        assert isinstance(e.get("feature"), str)
        assert isinstance(e.get("error"), str)


# ─── End-to-end extract() — JSON-serializable output ────────────────────────


def test_extract_end_to_end_is_json_strict_serializable(tmp_path, tone, monkeypatch):
    """Write a tone to a wav file, point `find_audio` at it, run a partial
    `extract` (one section to stay fast), and assert the result survives
    json.dumps(..., allow_nan=False). The cache writer effectively assumes
    strict mode — a NaN here would silently produce `NaN` literals in the
    .json file that the browser then rejects on read."""
    y, sr = tone
    audio_path = tmp_path / "tone.wav"
    soundfile.write(str(audio_path), y, sr)

    monkeypatch.setattr(mir_server, "find_audio", lambda slug: audio_path)
    monkeypatch.setattr(mir_server, "CACHE_DIR", tmp_path)

    result = extract("tone", force=True, sections=["spectral"])

    # Schema invariants the web side reads.
    assert result["slug"] == "tone"
    assert result["audio_file"] == "tone.wav"
    assert isinstance(result["duration"], float) and math.isfinite(result["duration"])
    assert isinstance(result["sample_rate"], int)
    assert "spectral" in result["features"]
    assert isinstance(result["errors"], list)

    # The actual guarantee: strict JSON dump with NO NaN/Inf tolerance.
    json.dumps(result, allow_nan=False)


def test_extract_raises_filenotfound_for_unknown_slug(tmp_path, monkeypatch):
    """If find_audio returns None, extract must raise loudly — silently
    writing an empty cache file would mask a missing-upload bug."""
    monkeypatch.setattr(mir_server, "find_audio", lambda slug: None)
    monkeypatch.setattr(mir_server, "CACHE_DIR", tmp_path)
    with pytest.raises(FileNotFoundError, match="audio not found"):
        extract("does-not-exist", force=True, sections=["spectral"])
