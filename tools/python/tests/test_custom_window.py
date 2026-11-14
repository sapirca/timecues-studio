"""Window runs: a detector run on one highlighted range, folded back in.

The audio-free half — the time shift out of range-local time and the
merge/replace fold with its review re-keying. The context cutting is covered
by running a real detector on a real song (see custom_runner.run_window).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_runner import _shift_item, merge_window_items, remap_review  # noqa: E402


def cue(t, label="kick"):
    return {"time_ms": t, "label": label}


def times(items):
    return [(it.get("time_ms", it.get("start_ms")), it.get("label")) for it in items]


# ─── Shift into song time ────────────────────────────────────────────────────


def test_shift_moves_instants_not_lengths():
    span = {"start_ms": 100, "duration_ms": 400, "label": "x"}
    assert _shift_item(span, 60_000) == {"start_ms": 60_100, "duration_ms": 400, "label": "x"}
    hit = {"time_ms": 5, "decay_ms": 80, "candidates": [3, 9]}
    assert _shift_item(hit, 1_000) == {"time_ms": 1_005, "decay_ms": 80, "candidates": [1_003, 1_009]}


def test_shift_moves_lyric_ends_and_riff_items():
    lyric = {"time_ms": 10, "end_ms": 50, "text": "la"}
    assert _shift_item(lyric, 100)["end_ms"] == 150
    # A riff item is in seconds, as stored; its occurrences are plays, not times.
    riff = {"start": 1.0, "end": 3.0, "sequence": [{"type": "a", "lengthSteps": 16}], "repeatCount": 2,
            "occurrences": [{"index": 1, "event": "drop", "missing": [{"start": 0}]}]}
    moved = _shift_item(riff, 500)
    assert (moved["start"], moved["end"], moved["occurrences"]) == (1.5, 3.5, riff["occurrences"])


# ─── Merge / replace ─────────────────────────────────────────────────────────


BASE = [cue(1_000), cue(10_000), cue(12_000, "snare"), cue(30_000)]


def test_replace_swaps_only_the_window():
    out, _, stats = merge_window_items(BASE, [cue(11_000), cue(14_000, "hat")], 9_000, 20_000, "replace", "cue")
    assert times(out) == [(1_000, "kick"), (11_000, "kick"), (14_000, "hat"), (30_000, "kick")]
    assert stats == {"added": 2, "removed": 2, "duplicates": 0}


def test_merge_keeps_everything_and_adds_the_new():
    out, _, stats = merge_window_items(BASE, [cue(11_000), cue(14_000, "hat")], 9_000, 20_000, "merge", "cue")
    assert times(out) == [(1_000, "kick"), (10_000, "kick"), (11_000, "kick"),
                          (12_000, "snare"), (14_000, "hat"), (30_000, "kick")]
    assert stats == {"added": 2, "removed": 0, "duplicates": 0}


def test_merge_does_not_double_a_hit_heard_a_few_ms_off():
    # The window run re-hears the kick at 10 s, 9 ms late — the same hit.
    out, _, stats = merge_window_items(BASE, [cue(10_009), cue(12_005, "kick")], 9_000, 20_000, "merge", "cue")
    assert stats["duplicates"] == 1
    # Same instant, different drum: a kick with the snare is two hits.
    assert (12_005, "kick") in times(out)
    assert (10_009, "kick") not in times(out)


def test_items_outside_the_window_are_never_added():
    out, _, stats = merge_window_items(BASE, [cue(8_999), cue(20_000)], 9_000, 20_000, "merge", "cue")
    assert out == BASE and stats["added"] == 0


def test_span_starting_before_the_window_survives_replace():
    spans = [{"start_ms": 5_000, "duration_ms": 8_000, "label": "a"},
             {"start_ms": 10_000, "duration_ms": 1_000, "label": "b"}]
    out, _, _ = merge_window_items(spans, [], 9_000, 20_000, "replace", "span")
    assert [s["label"] for s in out] == ["a"]


def test_unknown_mode_is_refused():
    with pytest.raises(ValueError):
        merge_window_items(BASE, [], 0, 1, "overwrite", "cue")


# ─── Review decisions follow their items ─────────────────────────────────────


def test_reviews_follow_items_to_new_indices_and_die_with_replaced_ones():
    review = {"0:1000": "accepted", "1:10000": "rejected", "3:30000": "accepted"}
    out, remap, _ = merge_window_items(BASE, [cue(500, "hat"), cue(11_000)], 0, 11_500, "replace", "cue")
    # 1 s and 10 s were inside the window and replaced; 12 s and 30 s moved.
    assert times(out) == [(500, "hat"), (11_000, "kick"), (12_000, "snare"), (30_000, "kick")]
    assert remap_review(review, BASE, out, remap, "cue") == {"3:30000": "accepted"}


def test_reviews_survive_a_merge_at_shifted_indices():
    review = {"1:10000": "rejected", "2:12000": "accepted"}
    out, remap, _ = merge_window_items(BASE, [cue(5_000, "hat")], 0, 20_000, "merge", "cue")
    assert remap_review(review, BASE, out, remap, "cue") == {"2:10000": "rejected", "3:12000": "accepted"}


def test_replace_hands_a_decision_to_the_same_hit_heard_again():
    review = {"1:10000": "rejected", "2:12000": "accepted"}
    # 10 s kick re-heard 6 ms late (inherits ✗); the 12 s snare is gone.
    out, remap, _ = merge_window_items(BASE, [cue(10_006)], 9_000, 20_000, "replace", "cue")
    assert remap_review(review, BASE, out, remap, "cue") == {"1:10006": "rejected"}


# ─── A run narrowed to some parts ────────────────────────────────────────────


def span(t, label):
    return {"start_ms": t, "duration_ms": 4_000, "label": label}


def test_replace_of_one_part_leaves_the_other_parts_alone():
    base = [span(10_000, "Kick · Beat · 4 bars"), span(10_000, "Bass · 1/2 beat · 4 bars"),
            span(14_000, "Bassline · Beat · 4 bars")]
    out, _, stats = merge_window_items(base, [span(10_000, "Bass · Beat · 8 bars")],
                                       9_000, 20_000, "replace", "span", ["Bass"])
    assert times(out) == [(10_000, "Kick · Beat · 4 bars"), (10_000, "Bass · Beat · 8 bars"),
                          (14_000, "Bassline · Beat · 4 bars")]
    assert stats == {"added": 1, "removed": 1, "duplicates": 0}


def test_a_narrowed_run_adds_only_its_own_parts():
    out, _, stats = merge_window_items([], [span(10_000, "Kick · Beat · 4 bars")],
                                       9_000, 20_000, "merge", "span", ["Bass"])
    assert out == [] and stats["added"] == 0
