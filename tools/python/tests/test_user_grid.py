"""grid_truth.user_grid — the grid exactly as the app draws it — and the
DetectionContext grid helpers that read it.

Every detector cuts at these beats, so a lane lands on the lines the annotator
sees. The app's own grid code (web-app/src/utils/beatGrid.ts, gridSegments.ts)
is the reference; these pin the three places it differs from a plain
`offset + n * period`: the pickup before bar 1, tempo splits, and hand-placed
beats in Manual mode.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_api import DetectionContext  # noqa: E402
from grid_truth import user_grid  # noqa: E402


def test_no_bpm_is_no_grid():
    assert user_grid({"bpm": 0}, 10.0) == ([], [])
    assert user_grid(None, 10.0) == ([], [])


def test_pickup_beats_run_before_bar_one():
    # 120 BPM, bar 1 at 1.25 s: beats at 0.25 and 0.75 are the pickup.
    beats, downs = user_grid({"bpm": 120, "gridOffset": 1.25, "timeSignature": "4/4"}, 4.0)
    assert beats[:4] == pytest.approx([0.25, 0.75, 1.25, 1.75])
    # Bar 1 is a downbeat; so is the bar line four beats before it, if it
    # falls in the song — here it would be at -0.75, so it does not.
    assert downs[:2] == pytest.approx([1.25, 3.25])


def test_overrides_apply_only_in_manual_mode():
    info = {"bpm": 120, "gridOffset": 0.0, "timeSignature": "4/4", "beatOverrides": {"2": 1.1}}
    static, _ = user_grid({**info, "gridMode": "static"}, 3.0)
    manual, _ = user_grid({**info, "gridMode": "manual"}, 3.0)
    assert static[2] == pytest.approx(1.0)
    assert manual[2] == pytest.approx(1.1)


def test_splits_apply_in_mapped_mode_and_restart_the_bar():
    info = {"bpm": 120, "gridOffset": 0.0, "timeSignature": "4/4",
            "gridSegments": [{"id": "s1", "start": 2.25, "bpm": 60, "timeSignature": "3/4"}]}
    static, _ = user_grid({**info, "gridMode": "static"}, 6.0)
    beats, downs = user_grid({**info, "gridMode": "mapped"}, 6.0)
    assert static[5] == pytest.approx(2.5)          # splits are inert outside Mapped
    assert beats[:6] == pytest.approx([0.0, 0.5, 1.0, 1.5, 2.0, 2.25])
    assert beats[6:8] == pytest.approx([3.25, 4.25])
    assert 2.25 in [round(d, 6) for d in downs]      # a split starts its own bar 1


def test_segment_scoped_override_keys():
    info = {"bpm": 120, "gridOffset": 0.0, "timeSignature": "4/4", "gridMode": "manual",
            "manualBaseGridMode": "mapped",
            "gridSegments": [{"id": "s1", "start": 2.0, "bpm": 60, "timeSignature": "4/4"}],
            "beatOverrides": {"s1:1": 3.1}}
    beats, _ = user_grid(info, 5.0)
    assert 3.1 in [round(b, 6) for b in beats]
    assert 3.0 not in [round(b, 6) for b in beats]


def _ctx(beats_ms, offset_ms=0, bpm=120.0):
    return DetectionContext(
        audio=np.zeros(10, dtype=np.float32), sr=22050, duration_ms=10_000, stems={},
        features=None, energy_curve=np.zeros(1), tension_curve=np.zeros(1), bpm=bpm,
        beat_times_ms=beats_ms, grid_offset_ms=offset_ms, grid_source="user")


def test_ctx_helpers_follow_a_tempo_split():
    # 120 BPM up to 2 s, then 60 BPM.
    beats = [0, 500, 1000, 1500, 2000, 3000, 4000, 5000]
    ctx = _ctx(beats)
    assert ctx.bpm_at(700) == pytest.approx(120.0)
    assert ctx.bpm_at(3500) == pytest.approx(60.0)
    assert ctx.snap_to_beat_ms(2400) == 2000
    assert ctx.snap_to_beat_ms(2600) == 3000
    assert ctx.beat_index_at(3500) == 5


def test_ctx_beat_index_is_negative_in_the_pickup():
    ctx = _ctx([250, 750, 1250, 1750, 2250], offset_ms=1250)
    assert ctx.beat_index_at(1300) == 0
    assert ctx.beat_index_at(800) == -1
    assert ctx.snap_to_beat_ms(20) == 250


def test_ctx_snap_follows_a_hand_placed_beat():
    ctx = _ctx([0, 500, 1100, 1500, 2000])
    assert ctx.snap_to_beat_ms(1050) == 1100
