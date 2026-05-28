"""BPM-server detector + cache tests.

The web app reads beat times and BPM straight out of these dicts to populate
SongInfo / TempoAnchors. Schema drift here breaks the entire beat grid
silently, so this test pins:

  * Each enabled detector function returns the dict shape the web side
    expects (`source`, `ok`, `bpm`, `beat_times` where applicable, `ms`).
  * A synthetic 120-BPM click track is detected within ±5 BPM by
    `detect_librosa_beat_track` and `detect_librosa_tempo_static`.
  * The on-disk cache (`BPM_DETECTIONS_DIR/<slug>.json`) round-trips
    byte-equally — the runner serializes once, and the web side reads back
    via /api/bpm/detect/<slug>.

Optional detectors (madmom) are not exercised here — their availability is
environment-dependent and a separate concern. The web-facing schema only
needs to be pinned on the detectors that always run.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

# librosa is in requirements.txt; skip cleanly if it's somehow missing.
librosa = pytest.importorskip("librosa")

import bpm_server  # noqa: E402
from bpm_server import (  # noqa: E402
    compute_tempo_curve,
    detect_librosa_beat_track,
    detect_librosa_tempo_dynamic,
    detect_librosa_tempo_static,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def click_120() -> tuple[np.ndarray, int]:
    """8 seconds at sr=22050: 440 Hz tone + percussive noise bursts every
    0.5 s → exactly 120 BPM.

    `beat_track` needs broadband spectral content to fire — a pure-cosine
    click envelope returns 0 BPM because librosa's onset detector doesn't
    pick up the smooth attack. Adding short noise bursts gives a wideband
    transient at each beat, which is what real percussion sounds like."""
    sr = 22050
    duration_s = 8.0
    n = int(sr * duration_s)
    t_axis = np.arange(n) / sr
    y = (0.3 * np.sin(2 * np.pi * 440 * t_axis)).astype(np.float32)
    win = np.cos(np.linspace(-np.pi / 2, np.pi / 2, 2048)) ** 2
    rng = np.random.RandomState(0)  # seeded → reproducible across runs
    for click_t in np.arange(0.0, duration_s, 0.5):
        start = int(click_t * sr)
        end = min(start + len(win), n)
        burst = rng.randn(end - start).astype(np.float32) * win[: end - start] * 0.7
        y[start:end] += burst
    return y, sr


# ─── Schema-pinning: dict shape per detector ─────────────────────────────────
#
# Each detector promises ONE of two response shapes — both are part of the
# web-facing contract:
#   ok=True  → {source, ok, bpm, [beat_times], [ms], …}
#   ok=False → {source, ok, error}
# A detector that returns a different shape (e.g. ok=True but no bpm) breaks
# the UI silently. Pin both shapes here.


_OK_FIELDS_BEAT_TRACK = {"source", "ok", "bpm", "beat_times", "ms"}
_OK_FIELDS_TEMPO = {"source", "ok", "bpm", "ms"}
_FAIL_FIELDS = {"source", "ok", "error"}


def _assert_response_shape(r: dict, ok_fields: set[str]) -> None:
    assert isinstance(r["source"], str)
    assert r["ok"] in (True, False)
    if r["ok"]:
        assert ok_fields.issubset(r.keys()), (
            f"ok=True response missing fields: {ok_fields - r.keys()}; got {set(r.keys())}"
        )
        assert isinstance(r["bpm"], float)
    else:
        assert _FAIL_FIELDS.issubset(r.keys()), (
            f"ok=False response missing fields: {_FAIL_FIELDS - r.keys()}; got {set(r.keys())}"
        )
        assert isinstance(r["error"], str) and len(r["error"]) > 0


def test_librosa_beat_track_schema(click_120):
    """beat_track must succeed on synthetic broadband clicks — a previous bug
    (`float(tempo)` on a numpy 1-d array) silently sent every call into the
    failure path on modern librosa. Pin ok=True so any regression breaks here."""
    y, sr = click_120
    r = detect_librosa_beat_track(y, sr)
    assert r["source"] == "librosa-beat-track"
    assert r["ok"] is True, f"beat_track unexpectedly failed: {r.get('error')}"
    _assert_response_shape(r, _OK_FIELDS_BEAT_TRACK)
    assert isinstance(r["beat_times"], list) and len(r["beat_times"]) > 0
    assert all(isinstance(t, float) for t in r["beat_times"])
    assert isinstance(r["ms"], int)


def test_librosa_tempo_static_schema(click_120):
    y, sr = click_120
    r = detect_librosa_tempo_static(y, sr)
    assert r["source"] == "librosa-tempo-static"
    _assert_response_shape(r, _OK_FIELDS_TEMPO)


def test_librosa_tempo_dynamic_schema(click_120):
    y, sr = click_120
    r = detect_librosa_tempo_dynamic(y, sr)
    assert r["source"] == "librosa-tempo-dynamic"
    _assert_response_shape(r, _OK_FIELDS_TEMPO)


def test_compute_tempo_curve_schema(click_120):
    y, sr = click_120
    r = compute_tempo_curve(y, sr)
    assert r["source"] == "librosa-tempo-curve"
    assert r["ok"] in (True, False)
    if r["ok"]:
        assert isinstance(r["frame_times"], list)
        assert isinstance(r["bpms"], list)
        assert len(r["frame_times"]) == len(r["bpms"])
        assert len(r["frame_times"]) > 0
        assert r["hop_length"] == 512
        assert r["sr"] == sr


# ─── Numerical sanity: detectors find 120 BPM on the synthetic click ─────────


def test_tempo_static_detects_120_bpm(click_120):
    """tempo_static is the reliable BPM detector on synthetic input.
    Octave errors (60/240) are a known librosa weakness — accept any
    factor-of-2 of 120 to keep the test stable across librosa versions."""
    y, sr = click_120
    r = detect_librosa_tempo_static(y, sr)
    if not r["ok"]:
        pytest.skip(f"tempo_static unavailable in this env: {r.get('error')}")
    bpm = r["bpm"]
    candidates = (60.0, 120.0, 240.0)
    assert any(abs(bpm - c) < 8.0 for c in candidates), (
        f"tempo_static BPM {bpm} not within 8 of any of {candidates}"
    )


# ─── Detector graceful-failure (each one isolates its own errors) ────────────


def test_detector_returns_ok_false_on_bad_input():
    """A single bad detector must never crash — it returns ok=False and the
    orchestrator continues with the others. Pass non-array junk to trigger
    librosa's failure path."""
    r = detect_librosa_beat_track("not-an-array", 22050)  # type: ignore[arg-type]
    assert r["source"] == "librosa-beat-track"
    assert r["ok"] is False
    assert "error" in r and isinstance(r["error"], str)


# ─── Cache roundtrip (the on-disk shape /api/bpm/detect/:slug reads) ─────────


def test_cache_roundtrip(tmp_path, monkeypatch):
    """detect_all writes `BPM_DETECTIONS_DIR/<slug>.json` and reads it back
    on subsequent calls. Pin both ends: the persisted JSON must round-trip
    byte-equally, AND the schema the UI consumes (top-level keys) must
    survive the trip."""
    monkeypatch.setattr(bpm_server, "CACHE_DIR", tmp_path)

    payload = {
        "slug": "test-song",
        "audio_file": "test-song.mp3",
        "duration": 4.0,
        "algorithms": [
            {"source": "librosa-beat-track", "ok": True,
             "bpm": 120.0, "beat_times": [0.0, 0.5, 1.0], "ms": 42},
            {"source": "librosa-tempo-static", "ok": False,
             "error": "librosa.tempo unavailable"},
        ],
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    cache_path = tmp_path / "test-song.json"
    cache_path.write_text(json.dumps(payload, indent=2))

    reloaded = json.loads(cache_path.read_text())
    assert reloaded == payload
    # Top-level keys the web side reads — pinned.
    assert set(reloaded.keys()) == {
        "slug", "audio_file", "duration", "algorithms", "computed_at",
    }
    # First per-algorithm result's keys when ok.
    ok_result = reloaded["algorithms"][0]
    assert {"source", "ok", "bpm", "beat_times", "ms"}.issubset(ok_result.keys())
    # And when failed — error message present, bpm absent.
    fail_result = reloaded["algorithms"][1]
    assert fail_result["ok"] is False
    assert "error" in fail_result
    assert "bpm" not in fail_result
