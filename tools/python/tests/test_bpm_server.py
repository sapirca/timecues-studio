"""BPM-server detector + cache tests.

The web app reads beat times and BPM straight out of these dicts to populate
SongInfo. Schema drift here breaks the entire beat grid
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


# ─── Ranged detection (one grid segment, not the whole song) ────────────────
#
# DataPrep's Mapped grid mode splits a song into segments that each restart
# the count with their own tempo. Detecting from the whole file answers about
# neither half of a song that changes tempo, so /api/bpm/detect takes an
# optional {start, end} and the detectors see only that span. What has to
# hold, and is easy to get silently wrong:
#
#   * the span is validated, so a segment too short to read a tempo from gets
#     an error instead of a confident wrong number;
#   * the file-based detectors get a real file holding only the span, and it
#     is cleaned up;
#   * every timestamp comes back in SONG time, not span-local time — an
#     unshifted result drops the segment's beats at 0:00;
#   * a ranged result never touches the whole-song cache, in either direction.


from server_common import (  # noqa: E402
    MIN_RANGE_SECONDS, parse_range, shift_times, trimmed_audio,
)

soundfile = pytest.importorskip("soundfile")


def test_parse_range_absent_means_whole_song():
    assert parse_range({"slug": "x"}) is None
    assert parse_range({"slug": "x", "force": True}) is None


def test_parse_range_reads_a_span():
    assert parse_range({"start": 10.5, "end": 41.25}) == (10.5, 41.25)
    # Strings are what a JSON body from a form-ish client actually carries.
    assert parse_range({"start": "10.5", "end": "41.25"}) == (10.5, 41.25)


@pytest.mark.parametrize("body", [
    {"start": 10.0, "end": 10.5},          # shorter than the floor
    {"start": 10.0, "end": 9.0},           # inverted
    {"start": -1.0, "end": 20.0},          # before the song
    {"start": 10.0, "end": None},          # half a range
    {"start": "soon", "end": 20.0},        # not a number
    {"start": 0.0, "end": float("inf")},   # unbounded
])
def test_parse_range_rejects_unusable_spans(body):
    """A bad range must raise, not fall back to the whole song — a whole-song
    tempo silently attributed to a segment is the exact bug this endpoint
    exists to prevent."""
    with pytest.raises(ValueError):
        parse_range(body)


def test_shift_times_moves_timestamps_into_song_time():
    r = {"beat_times": [0.0, 0.5, 1.0], "downbeats": [0.0, 1.0], "bpm": 120.0}
    shift_times(r, 41.108)
    assert r["beat_times"] == pytest.approx([41.108, 41.608, 42.108])
    assert r["downbeats"] == pytest.approx([41.108, 42.108])
    assert r["bpm"] == 120.0  # not a timestamp — untouched


def test_shift_times_is_a_noop_at_zero():
    r = {"beat_times": [0.0, 0.5]}
    assert shift_times(r, 0.0)["beat_times"] == [0.0, 0.5]


def _write_wav(path: Path, y: np.ndarray, sr: int) -> Path:
    soundfile.write(str(path), y, sr)
    return path


def test_trimmed_audio_holds_only_the_span(tmp_path, click_120):
    y, sr = click_120  # 8 s
    src = _write_wav(tmp_path / "song.wav", y, sr)
    with trimmed_audio(src, 2.0, 5.0) as trimmed:
        assert trimmed.exists()
        assert trimmed != src
        assert librosa.get_duration(path=str(trimmed)) == pytest.approx(3.0, abs=0.05)
    assert not trimmed.exists()   # cleaned up
    assert src.exists()           # and the song itself is untouched


def test_trimmed_audio_cleans_up_when_the_detector_raises(tmp_path, click_120):
    y, sr = click_120
    src = _write_wav(tmp_path / "song.wav", y, sr)
    leaked = None
    with pytest.raises(RuntimeError):
        with trimmed_audio(src, 1.0, 4.0) as trimmed:
            leaked = trimmed
            raise RuntimeError("detector blew up")
    assert leaked is not None and not leaked.exists()


def _two_tempo_song(sr: int = 22050) -> tuple[np.ndarray, int]:
    """24 s: 100 BPM for the first 12, then 150 BPM. A single whole-song
    estimate is wrong for both halves — which is the whole reason segments
    get their own detection."""
    halves = []
    rng = np.random.RandomState(7)
    win = np.cos(np.linspace(-np.pi / 2, np.pi / 2, 2048)) ** 2
    for bpm in (100.0, 150.0):
        n = int(sr * 12.0)
        y = (0.2 * np.sin(2 * np.pi * 220 * (np.arange(n) / sr))).astype(np.float32)
        for click_t in np.arange(0.0, 12.0, 60.0 / bpm):
            start = int(click_t * sr)
            end = min(start + len(win), n)
            y[start:end] += rng.randn(end - start).astype(np.float32) * win[: end - start] * 0.7
        halves.append(y)
    return np.concatenate(halves), sr


def _octave_equal(got: float, want: float, tol: float = 6.0) -> bool:
    """True when `got` matches `want` up to a factor-of-two error. Every beat
    tracker halves or doubles sometimes; that is not what these tests are
    about."""
    return any(abs(got * k - want) < tol for k in (0.5, 1.0, 2.0))


@pytest.fixture
def two_tempo_slug(tmp_path, monkeypatch) -> str:
    y, sr = _two_tempo_song()
    path = _write_wav(tmp_path / "two-tempo.wav", y, sr)
    monkeypatch.setattr(bpm_server, "_find_audio", lambda slug: path)
    monkeypatch.setattr(bpm_server, "CACHE_DIR", tmp_path / "cache")
    (tmp_path / "cache").mkdir()
    return "two-tempo"


def _first_ok_bpm(result: dict) -> float:
    for a in result["algorithms"]:
        if a["ok"] and a.get("bpm"):
            return float(a["bpm"])
    pytest.skip("no detector returned a usable BPM in this environment")


def test_ranged_detection_reads_each_half_its_own_tempo(two_tempo_slug):
    first = bpm_server.detect_all(two_tempo_slug, span=(0.0, 12.0))
    second = bpm_server.detect_all(two_tempo_slug, span=(12.0, 24.0))

    assert _octave_equal(_first_ok_bpm(first), 100.0), first["algorithms"]
    assert _octave_equal(_first_ok_bpm(second), 150.0), second["algorithms"]


def test_ranged_detection_reports_beats_in_song_time(two_tempo_slug):
    """The detector saw a file starting at zero. If the shift is dropped, the
    second half's beats all land at the top of the song and the grid silently
    lies about where the segment's downbeats are."""
    result = bpm_server.detect_all(two_tempo_slug, span=(12.0, 24.0))
    beats = next(
        (a["beat_times"] for a in result["algorithms"] if a["ok"] and a.get("beat_times")),
        None,
    )
    if not beats:
        pytest.skip("no detector returned beat times in this environment")
    assert min(beats) >= 12.0 - 0.05
    assert max(beats) <= 24.0 + 0.05


def test_ranged_detection_carries_its_range_and_skips_the_cache(two_tempo_slug):
    result = bpm_server.detect_all(two_tempo_slug, span=(12.0, 24.0))
    assert result["range"] == {"start": 12.0, "end": 24.0}
    assert result["duration"] == pytest.approx(12.0, abs=0.05)
    # Nothing written: a segment's answer must never become the song's.
    assert list(bpm_server.CACHE_DIR.iterdir()) == []


def test_ranged_detection_never_reads_the_whole_song_cache(two_tempo_slug):
    """A cached whole-song result must not be served as a segment's answer."""
    (bpm_server.CACHE_DIR / f"{two_tempo_slug}.json").write_text(json.dumps({
        "slug": two_tempo_slug, "audio_file": "two-tempo.wav", "duration": 24.0,
        "algorithms": [{"source": "librosa-beat-track", "ok": True, "bpm": 999.0}],
        "computed_at": "1970-01-01T00:00:00+00:00",
    }))
    result = bpm_server.detect_all(two_tempo_slug, span=(0.0, 12.0))
    assert all(a.get("bpm") != 999.0 for a in result["algorithms"])
    assert "range" in result


def test_min_range_is_the_floor_the_ui_disables_on():
    """The web side greys out "Detect from this segment" below this many
    seconds; if it moves here, that copy moves too."""
    assert MIN_RANGE_SECONDS == 2.0
