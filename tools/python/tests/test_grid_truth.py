"""Tests for expanding curated grids into ground-truth beat times.

A bug here is expensive in a way a bug in a detector is not: a wrong
reference makes every tracker look broken at once, and the report is
persuasive because four independent models "agree" they failed. Both of the
real bugs this file pins down were found exactly that way — the whole corpus
scoring ~0.4 until the reference was fixed.
"""

from __future__ import annotations

import sys
from pathlib import Path

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from grid_truth import (  # noqa: E402
    beats_per_bar, expand, is_trustworthy, segments_are_active,
)


def test_beats_per_bar_covers_the_uis_table_and_falls_back():
    assert beats_per_bar("4/4") == 4
    assert beats_per_bar("3/4") == 3
    assert beats_per_bar("5/4") == 5
    assert beats_per_bar("7/8") == 7
    assert beats_per_bar("12/8") == 12
    assert beats_per_bar("9/8") == 9          # not in the table, parsed
    assert beats_per_bar(None) == 4
    assert beats_per_bar("nonsense") == 4


def test_a_steady_grid_expands_to_evenly_spaced_beats():
    info = {"bpm": 120, "gridOffset": 0.5, "timeSignature": "4/4"}
    beats, downbeats = expand(info, duration=10.0)

    assert beats[0] == 0.5
    assert abs(beats[1] - 1.0) < 1e-9         # 120 BPM → 0.5 s
    assert beats[-1] < 10.0
    # Every 4th beat is a downbeat.
    assert downbeats == beats[::4]


def test_the_offset_is_bar_one_not_time_zero():
    """Nothing is emitted before gridOffset — the grid starts where the
    curator put it, and inventing beats before it would score a tracker
    against a downbeat nobody placed."""
    info = {"bpm": 120, "gridOffset": 2.0, "timeSignature": "4/4"}
    beats, _ = expand(info, duration=5.0)
    assert min(beats) == 2.0


def test_five_four_puts_downbeats_five_beats_apart():
    info = {"bpm": 60, "gridOffset": 0.0, "timeSignature": "5/4"}
    _, downbeats = expand(info, duration=20.0)
    assert [round(d, 6) for d in downbeats] == [0.0, 5.0, 10.0, 15.0]


# ─── Segments ──────────────────────────────────────────────────────────────

def _mapped(segments):
    return {
        "bpm": 120, "gridOffset": 0.0, "timeSignature": "4/4",
        "gridMode": "mapped", "gridSegments": segments,
    }


def test_each_segment_restarts_the_bar_count():
    """A split MEANS the count restarts, so the segment's own start is a
    downbeat by definition — the single thing a fitted segment must get
    right."""
    info = _mapped([{"id": "a", "start": 10.0, "bpm": 140, "timeSignature": "4/4"}])
    beats, downbeats = expand(info, duration=20.0)

    assert 10.0 in downbeats
    # Second segment runs at 140 BPM → 0.428571 s per beat.
    after = [b for b in beats if b >= 10.0]
    assert abs((after[1] - after[0]) - 60.0 / 140) < 1e-9


def test_the_outgoing_segment_is_cut_not_rounded_up():
    """A bar that got three and a half of its four beats is the normal
    outcome. Completing it would invent a beat past the split."""
    info = _mapped([{"id": "a", "start": 3.25, "bpm": 120, "timeSignature": "4/4"}])
    beats, _ = expand(info, duration=8.0)
    before = [b for b in beats if b < 3.25]
    assert max(before) < 3.25
    # No beat is emitted twice at the join.
    assert len(beats) == len(set(round(b, 9) for b in beats))


def test_splits_before_the_opening_are_ignored():
    info = _mapped([{"id": "a", "start": -5.0, "bpm": 200, "timeSignature": "4/4"}])
    beats, _ = expand(info, duration=4.0)
    assert abs((beats[1] - beats[0]) - 0.5) < 1e-9   # still the opening's 120


def test_segments_are_inert_outside_mapped_mode():
    """The real bug: toast3d_peter_the_wolf stores 20 segments with gridMode
    'static'. The app draws one steady grid; reading the segments anyway
    produced a reference no tracker could match."""
    static = {
        "bpm": 120, "gridOffset": 0.0, "timeSignature": "4/4",
        "gridMode": "static",
        "gridSegments": [{"id": "a", "start": 10.0, "bpm": 200, "timeSignature": "3/4"}],
    }
    assert segments_are_active(static) is False
    beats, _ = expand(static, duration=20.0)
    # Uniform 120 BPM throughout — the 200 BPM split never applies.
    gaps = {round(b - a, 9) for a, b in zip(beats, beats[1:])}
    assert gaps == {0.5}


def test_segments_apply_under_manual_on_a_mapped_base():
    info = {
        "bpm": 120, "gridOffset": 0.0, "timeSignature": "4/4",
        "gridMode": "manual", "manualBaseGridMode": "mapped",
        "gridSegments": [{"id": "a", "start": 10.0, "bpm": 140, "timeSignature": "4/4"}],
    }
    assert segments_are_active(info) is True


# ─── Refusing what we cannot model ─────────────────────────────────────────

def test_an_untouched_grid_is_refused():
    ok, why = is_trustworthy({"bpm": 120, "gridOffset": 0, "timeSignature": "4/4"})
    assert ok is False
    assert "default" in why


def test_a_hand_placed_grid_is_refused():
    """Per-beat overrides are the whole point of Hand-placed mode and are not
    expanded here, so scoring against the rule would ignore every correction
    the curator made by hand."""
    ok, why = is_trustworthy({
        "bpm": 145, "gridOffset": 0.036, "timeSignature": "4/4",
        "beatOverrides": {"128": 55.3},
    })
    assert ok is False
    assert "Hand-placed" in why


def test_a_drifting_grid_with_anchors_is_refused():
    ok, why = is_trustworthy({
        "bpm": 100, "gridOffset": 0.2, "timeSignature": "4/4",
        "gridMode": "dynamic", "tempoAnchors": [{"timestamp": 30.0, "bpm": 104}],
    })
    assert ok is False
    assert "Drifting" in why


def test_a_curated_grid_is_accepted():
    ok, why = is_trustworthy({"bpm": 124, "gridOffset": 0.07, "timeSignature": "4/4"})
    assert ok is True
    assert why == ""


def test_a_typed_in_tempo_at_offset_zero_is_accepted_with_a_caveat():
    """The beats are plausible; the PHASE probably was never aligned, and
    phase is most of what we measure — so it is scored but flagged."""
    ok, why = is_trustworthy({"bpm": 123, "gridOffset": 0, "timeSignature": "4/4"})
    assert ok is True
    assert "offset is exactly 0" in why
