"""Tests for the beat-list → grid-segment fitter.

The cases here are the three things that look identical in a flat list of
beat times and mean completely different things musically: a tempo change,
a phase shift at an unchanged tempo, and a tracker dropout across a
breakdown. Getting the last one wrong is what makes naive grid-fitters
unusable on electronic music, so it gets the most coverage.
"""

from __future__ import annotations

import sys
from pathlib import Path

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from beat_segments import fit_segments, summarize  # noqa: E402


def beats_at(bpm: float, count: int, start: float = 0.0) -> "list[float]":
    """`count` perfectly regular beats at `bpm`, starting at `start`."""
    step = 60.0 / bpm
    return [start + i * step for i in range(count)]


def downbeats_of(beats: "list[float]", per_bar: int = 4, offset: int = 0) -> "list[float]":
    """Every `per_bar`-th beat, i.e. what a tracker labels as a downbeat."""
    return [t for i, t in enumerate(beats) if (i - offset) % per_bar == 0 and i >= offset]


# ─── The easy case: nothing changes ─────────────────────────────────────────

def test_constant_tempo_is_one_segment():
    beats = beats_at(138, 240)
    segments = fit_segments(beats, downbeats_of(beats))
    assert len(segments) == 1
    assert segments[0]["bpm"] == 138.0
    assert segments[0]["time_signature"] == "4/4"
    assert segments[0]["reason"] == "opening"


def test_too_few_beats_yields_nothing():
    assert fit_segments([]) == []
    assert fit_segments([1.0]) == []


def test_duration_extends_the_last_segment_past_the_final_beat():
    beats = beats_at(120, 60)              # last beat at 29.5s
    segments = fit_segments(beats, downbeats_of(beats), duration=32.0)
    assert segments[-1]["end"] == 32.0


# ─── Tempo change ───────────────────────────────────────────────────────────

def test_sustained_tempo_change_cuts_a_segment():
    first = beats_at(120, 64)
    second = beats_at(140, 64, start=first[-1] + 60.0 / 140)
    beats = first + second
    segments = fit_segments(beats, downbeats_of(beats))

    assert len(segments) == 2
    assert segments[0]["bpm"] == 120.0
    assert segments[1]["bpm"] == 140.0
    assert segments[1]["reason"] == "tempo"
    assert summarize(segments)["tempo_changes"] == 1


def test_a_single_stray_beat_is_not_a_tempo_change():
    """One mislocated beat is tracker jitter; four in a row is a new tempo.
    Without the sustain requirement this fires on every song."""
    beats = beats_at(128, 96)
    beats[40] += 0.09          # ~19% of a beat out of place, then recovers
    segments = fit_segments(beats, downbeats_of(beats))
    assert all(s["reason"] != "tempo" for s in segments[1:])


# ─── Phase shift at an unchanged tempo — the electronic-music case ──────────

def test_phase_shift_at_constant_tempo_cuts_without_changing_bpm():
    """A track cut and reassembled after rendering: same clock throughout,
    but the downbeat lands somewhere it shouldn't. Two segments, one BPM."""
    step = 60.0 / 138
    first = beats_at(138, 64)
    # Resume a third of a beat late — not a whole number of beats, so this
    # is a real re-anchor rather than a dropout.
    second = beats_at(138, 64, start=first[-1] + step * 1.34)
    beats = first + second
    downs = downbeats_of(first) + downbeats_of(second)

    segments = fit_segments(beats, downs)
    assert len(segments) == 2
    assert segments[0]["bpm"] == segments[1]["bpm"] == 138.0
    assert segments[1]["reason"] == "shift"

    stats = summarize(segments)
    assert stats["tempo_changes"] == 0
    assert stats["phase_shifts"] == 1
    assert stats["constant_tempo"] is True


def test_segment_start_snaps_to_the_segments_own_downbeat():
    """`start` IS bar 1 beat 1 in the grid model, so a segment anchored on
    beat 3 would be wrong in precisely the way this module exists to fix."""
    step = 60.0 / 138
    first = beats_at(138, 64)
    second = beats_at(138, 64, start=first[-1] + step * 1.34)
    beats = first + second
    # The tracker's first downbeat in segment two is its THIRD beat.
    downs = downbeats_of(first) + downbeats_of(second, offset=2)

    segments = fit_segments(beats, downs)
    assert len(segments) == 2
    assert abs(segments[1]["start"] - second[2]) < 1e-6


# ─── Dropout: the case a naive fitter gets wrong ───────────────────────────

def test_breakdown_with_no_beats_is_bridged_not_cut():
    """32 beats of silence, then the ORIGINAL grid resumes exactly. The gap
    is huge and means nothing — one segment, not three."""
    step = 60.0 / 138
    first = beats_at(138, 64)
    second = beats_at(138, 64, start=first[-1] + step * 32)
    beats = first + second
    segments = fit_segments(beats, downbeats_of(first) + downbeats_of(second))

    assert len(segments) == 1
    assert segments[0]["bpm"] == 138.0


def test_dropout_that_resumes_off_grid_is_a_shift():
    """Same silent gap, but the music comes back half a beat off. That IS a
    re-anchor and must be cut."""
    step = 60.0 / 138
    first = beats_at(138, 64)
    second = beats_at(138, 64, start=first[-1] + step * 32.5)
    beats = first + second
    segments = fit_segments(beats, downbeats_of(first) + downbeats_of(second))

    assert len(segments) == 2
    assert segments[1]["reason"] == "shift"


def test_dropout_longer_than_the_bridging_limit_is_a_shift():
    """Past ~16 bars the "same grid resumed" claim rests on too little
    evidence: a long passage can land near a beat multiple by chance."""
    step = 60.0 / 138
    first = beats_at(138, 64)
    second = beats_at(138, 64, start=first[-1] + step * 96)
    beats = first + second
    segments = fit_segments(beats, downbeats_of(first) + downbeats_of(second))
    assert len(segments) == 2


# ─── Meter ─────────────────────────────────────────────────────────────────

def test_three_four_is_read_from_the_downbeat_spacing():
    beats = beats_at(150, 120)
    segments = fit_segments(beats, downbeats_of(beats, per_bar=3))
    assert segments[0]["time_signature"] == "3/4"


def test_meter_is_none_without_two_full_bars():
    """An honest unknown beats a confident 4/4 read off one downbeat — the
    caller renders whatever we return."""
    beats = beats_at(138, 40)
    segments = fit_segments(beats, [beats[0]])
    assert segments[0]["time_signature"] is None


def test_inconsistent_downbeats_give_no_meter():
    beats = beats_at(138, 96)
    downs = [beats[0], beats[3], beats[9], beats[12], beats[20], beats[27]]
    segments = fit_segments(beats, downs)
    assert segments[0]["time_signature"] is None


# ─── Noise suppression ─────────────────────────────────────────────────────

def test_segments_shorter_than_the_floor_are_absorbed():
    """Two stumbles a second apart must not produce a segment table with
    more noise than song."""
    step = 60.0 / 138
    beats = beats_at(138, 128)
    # Two off-grid displacements close together, each big enough to cut.
    beats = beats[:60] + [t + step * 0.4 for t in beats[60:62]] + beats[62:]
    segments = fit_segments(beats, downbeats_of(beats), min_segment_seconds=4.0)
    for seg in segments:
        assert seg["end"] - seg["start"] >= 4.0


def test_unsorted_and_duplicate_beats_are_tolerated():
    beats = beats_at(128, 64)
    scrambled = [beats[5]] + beats + [beats[5]]
    segments = fit_segments(scrambled, downbeats_of(beats))
    assert len(segments) == 1
    assert segments[0]["bpm"] == 128.0


# ─── Artifacts the real corpus exposed ─────────────────────────────────────
#
# Every case below was found by running the fitter over data/songs, not by
# imagining what a tracker might do. The synthetic tests above all passed
# while the fitter was emitting 96 segments for a track with none.

def quantize(times: "list[float]", frame: float = 0.02) -> "list[float]":
    """Snap times to a tracker's frame grid. Beat This! runs at 50 fps, so
    every timestamp it emits is a multiple of 20 ms."""
    return [round(t / frame) * frame for t in times]


def test_frame_quantization_does_not_look_like_a_phase_shift():
    """A steady 125 BPM track on a 20 ms grid comes back as intervals of
    0.48, 0.48, 0.48, 0.48, 0.50 — a 4% swing that is the frame grid, not the
    music. Read literally it cuts a segment every fifth beat."""
    beats = quantize(beats_at(124, 480))
    segments = fit_segments(beats, downbeats_of(beats))
    assert len(segments) == 1
    assert segments[0]["reason"] == "opening"


def test_sparse_intro_beats_are_folded_in_not_dropped():
    """Isolated beats before the drums arrive have no interval to read a
    tempo from. Dropping them leaves the first seconds outside every segment,
    which reads on screen as a grid that starts late."""
    step = 60.0 / 128
    intro = [0.5, 3.0, 5.5]                       # three beats, seconds apart
    body = beats_at(128, 200, start=8.0)
    segments = fit_segments(intro + body, downbeats_of(body))

    assert len(segments) == 1
    # Coverage reaches back to the first beat the tracker actually found.
    assert segments[0]["start"] <= body[0] + step
    assert segments[0]["beats"] == len(intro) + len(body)


def test_implausible_tempo_is_absorbed_into_its_neighbour():
    """A burst of quadruple-triggered onsets during a fill fits at ~428 BPM.
    That is not a section of the song."""
    step = 60.0 / 100
    first = beats_at(100, 120)
    burst = [first[-1] + 0.14 * i for i in range(1, 8)]     # ~428 BPM
    rest = beats_at(100, 120, start=burst[-1] + step)
    segments = fit_segments(first + burst + rest, downbeats_of(first) + downbeats_of(rest))

    for seg in segments:
        assert 40.0 <= seg["bpm"] <= 220.0


def test_a_track_with_no_pulse_at_all_is_left_honest():
    """Spoken word: every fitted tempo is implausible and there is nothing
    sound to merge into. An honest mess beats one fabricated segment
    spanning three minutes of speech."""
    beats = [0.7, 25.9, 47.5, 60.9, 61.7, 90.2]
    segments = fit_segments(beats)
    assert segments                       # not silently emptied
    assert any(seg["bpm"] < 40.0 for seg in segments)


def test_half_time_flip_merges_and_the_longer_side_wins():
    """A tracker that counts 65 through the verse and 130 through the chorus
    has changed its mind about which pulse to count, not found a tempo
    change. Both readings describe one grid."""
    half = beats_at(65, 20)                       # short side
    full = beats_at(130, 160, start=half[-1] + 60.0 / 130)
    segments = fit_segments(half + full, downbeats_of(half) + downbeats_of(full))

    assert len(segments) == 1
    assert abs(segments[0]["bpm"] - 130) < 1      # the side with more beats
    # A level flip is sustained for as long as it lasts, so it arrives as a
    # 'tempo' cut, not a 'shift'. Restricting the merge to 'shift' would mean
    # it never fires on the case it exists for.
    assert summarize(segments)["tempo_changes"] == 0


def test_a_real_tempo_change_is_not_mistaken_for_an_octave():
    """100 → 180 is a ratio of 1.8. Widening the octave test far enough to
    swallow a sloppy 2.2x would start eating changes like this one, which is
    the worse failure: visibly noisy beats silently wrong."""
    first = beats_at(100, 80)
    second = beats_at(180, 120, start=first[-1] + 60.0 / 180)
    segments = fit_segments(first + second, downbeats_of(first) + downbeats_of(second))

    assert len(segments) == 2
    assert segments[1]["reason"] == "tempo"
    assert abs(segments[1]["bpm"] - 180) < 1


# ─── Stem-based detectors ──────────────────────────────────────────────────

def test_a_stem_detectors_beats_fit_like_any_other():
    """The fitter is detector-agnostic on purpose: Beat Transformer reads
    Demucs stems rather than the mix, but it hands over the same two lists as
    every other tracker, so nothing in the fit knows or cares."""
    beats = quantize(beats_at(123, 400))
    segments = fit_segments(beats, downbeats_of(beats))
    assert len(segments) == 1
    assert segments[0]["time_signature"] == "4/4"
