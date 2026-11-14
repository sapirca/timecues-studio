"""Behaviour tests for the `section_repeats` SPAN detector.

Synthetic, so the answer is not in doubt. The melodic part plays four 8-bar
sections, each its own two-bar chord loop: X, Y, X again, Z.

1. X's two plays are one repeated section, and nothing else repeats.
2. The second X can carry a new top line (a variant). Strict leaves it
   alone; Loose calls it a return and marks it with a prime.
3. Loosening only ever adds repeats.
4. A stem that is silent all song gives no spans.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

pytest.importorskip("librosa", reason="librosa not installed")

SectionRepeats = pytest.importorskip("custom.visualizer.section_repeats").SectionRepeats
from custom_api import DetectionContext  # noqa: E402
from shared.models import AudioFeatures  # noqa: E402

SR = 22050
BPM = 120.0
BEATS_PER_BAR = 4
BAR = int(60.0 / BPM * BEATS_PER_BAR * SR)
SECTION_BARS = 8
# Two chords per section, a bar each, as root frequencies of a triad.
LOOPS = {"X": (220.0, 174.6), "Y": (261.6, 196.0), "Z": (146.8, 329.6)}
FORM = ("X", "Y", "X", "Z")


def _chord(root: float, n: int) -> np.ndarray:
    t = np.arange(n) / SR
    y = sum(np.sin(2 * np.pi * root * r * t) for r in (1.0, 1.26, 1.5)) / 3
    r = int(0.01 * SR)
    y[:r] *= np.linspace(0, 1, r)
    y[-r:] *= np.linspace(1, 0, r)
    return 0.4 * y


def _melodic(variant_top: bool) -> np.ndarray:
    out = []
    for k, name in enumerate(FORM):
        a, b = LOOPS[name]
        for bar in range(SECTION_BARS):
            y = _chord(a if bar % 2 == 0 else b, BAR)
            if variant_top and k == 2:        # the second X, with a new line on top
                t = np.arange(BAR) / SR
                y = y + 0.25 * np.sin(2 * np.pi * (880.0 if bar % 2 else 1175.0) * t)
            out.append(y)
    return np.concatenate(out)


def _kick(n_bars: int) -> np.ndarray:
    y = np.zeros(n_bars * BAR)
    beat = BAR // BEATS_PER_BAR
    t = np.arange(int(0.08 * SR)) / SR
    hit = np.sin(2 * np.pi * 60 * t) * np.exp(-t * 40)
    for i in range(n_bars * BEATS_PER_BAR):
        y[i * beat:i * beat + len(hit)] += hit
    return y


def _context(stems: dict, stem: str | None, strictness: int) -> DetectionContext:
    n = len(next(iter(stems.values())))
    duration_ms = int(n / SR * 1000)
    n_frames = n // 512 + 1
    z = np.zeros(n_frames, dtype=np.float32)
    features = AudioFeatures(
        rms=z, spectral_centroid=z, spectral_bandwidth=z, spectral_flux=z,
        spectral_flatness=z, spectral_rolloff=z,
        chromagram=np.zeros((12, n_frames), dtype=np.float32),
        mfcc=np.zeros((13, n_frames), dtype=np.float32),
        onset_env=z, onset_frames=np.array([], dtype=np.int64), tempo=BPM,
        beat_frames=np.array([], dtype=np.int64),
        sr=SR, hop_length=512, n_frames=n_frames, frame_times_ms=z,
    )
    beat_ms = 60000.0 / BPM
    n_bars = n // BAR
    return DetectionContext(
        audio=np.sum(list(stems.values()), axis=0).astype(np.float32), sr=SR,
        duration_ms=duration_ms, stems=stems, features=features,
        energy_curve=np.zeros(duration_ms // 100 + 1, dtype=np.float32),
        tension_curve=np.zeros(duration_ms // 100 + 1, dtype=np.float32),
        bpm=BPM, beat_times_ms=[int(i * beat_ms) for i in range(n_bars * BEATS_PER_BAR + 1)],
        slug="synthetic", grid_offset_ms=0, time_signature="4/4",
        beats_per_bar=BEATS_PER_BAR, grid_mode="static",
        strictness=strictness, stem=stem,
    )


def _stems(variant_top: bool = False) -> dict:
    melodic = _melodic(variant_top)
    noise = np.random.default_rng(0).normal(0, 1e-4, len(melodic))
    return {"other": (melodic + noise).astype(np.float32),
            "drums": (_kick(len(melodic) // BAR) + noise).astype(np.float32),
            "bass": noise.astype(np.float32),
            "vocals": noise.astype(np.float32)}


def _run(stems, stem, strictness):
    return SectionRepeats().detect(_context(stems, stem, strictness))


def _section_of(span) -> int:
    """Which of the four sections a span sits in, by its middle."""
    mid_bar = (span.start_ms + span.duration_ms / 2) / (BAR / SR * 1000)
    return int(mid_bar // SECTION_BARS)


def _letters(spans) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for s in spans:
        out.setdefault(s.label.split(" ")[0].rstrip("′"), []).append(_section_of(s))
    return out


def test_the_returning_section_is_found_and_nothing_else():
    spans = _run(_stems(), "other", 50)
    assert _letters(spans) == {"A": [0, 2]}
    first, second = sorted(spans, key=lambda s: s.start_ms)
    assert "↔" in first.label and "′" not in second.label


def test_a_variant_is_a_repeat_only_when_loose():
    stems = _stems(variant_top=True)
    assert _run(stems, "other", 0) == []
    loose = _run(stems, "other", 100)
    assert _letters(loose) == {"A": [0, 2]}
    assert any("′" in s.label for s in loose)


def test_loosening_only_adds_repeats():
    stems = _stems(variant_top=True)
    found = [sum(s.duration_ms for s in _run(stems, "other", lvl)) for lvl in (0, 50, 100)]
    assert found == sorted(found)


def test_a_silent_stem_gives_nothing():
    assert _run(_stems(), "vocals", 100) == []



def test_a_wandering_section_is_not_a_repeat_of_everything():
    """Arabian Nights, as the matrix saw it: a steady intro (self-match 0.7),
    a contrasting section, then one that changes every bar (self-match 0.27)
    and matches the intro at 0.27 — only its bass agrees. Measured against
    the weaker self-match that is "as alike as it is to itself", and the
    intro was reported as repeating there. It is not a repeat."""
    from generators.section_repeats import find_repeats
    rng = np.random.default_rng(4)
    n = 24
    S = np.zeros((n, n))
    steady, other, wander = slice(0, 8), slice(8, 16), slice(16, 24)
    S[steady, steady] = 0.7
    S[other, other] = 0.7
    S[wander, wander] = rng.uniform(0.0, 0.54, (8, 8))       # mean 0.27
    S[steady, wander] = S[wander, steady] = 0.27
    np.fill_diagonal(S, 1.0)
    bar_s = np.arange(n) * 2.0
    repeats, _ = find_repeats(S, bar_s, n * 2.0, 50)
    assert repeats == []
