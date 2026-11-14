"""Behaviour tests for the `call_response_ssm` SPAN detector.

Synthetic, so the answer in each case is not in doubt. The vocals state a
one-bar phrase every other bar, drawn from three phrases X, Y and Z, and rest
in between; the guitar may enter in the rest.

1. The guitar answers X and only X. That is a recurring question with an
   answer, and every statement of X must be found.
2. The guitar answers every phrase. That is antiphony — `call_response`
   finds it — and says nothing about X in particular, so this lane must stay
   silent. This is the case the first version of the null got wrong.
3. The guitar answers a random third of the phrases, the same density as (1)
   with no consistent question. Silent.
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

CallResponseSsm = pytest.importorskip("custom.visualizer.call_response_ssm").CallResponseSsm
from generators.bar_grid import beat_grid  # noqa: E402
from generators.call_response_ssm import within_stem_spans  # noqa: E402
from custom_api import DetectionContext  # noqa: E402
from shared.models import AudioFeatures  # noqa: E402

SR = 22050
BPM = 120.0
BEATS_PER_BAR = 4
BAR = int(60.0 / BPM * BEATS_PER_BAR * SR)
N_BARS = 48
PHRASES = {"X": (220, 330, 277, 440), "Y": (262, 196, 247, 330), "Z": (294, 370, 220, 262)}


def _tone(freq: float, n: int) -> np.ndarray:
    t = np.arange(n) / SR
    y = 0.5 * np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(4 * np.pi * freq * t)
    r = int(0.01 * SR)
    y[:r] *= np.linspace(0.0, 1.0, r)
    y[-r:] *= np.linspace(1.0, 0.0, r)
    return y


def _phrase(notes) -> np.ndarray:
    return np.concatenate([_tone(f, BAR // 4) for f in notes])


def _sequence() -> list[str]:
    rng = np.random.default_rng(1)
    return [str(rng.choice(["X", "Y", "Z"])) for _ in range(N_BARS // 2)]


def _context(stems: dict, n_bars: int = N_BARS, beat_times_ms=None) -> DetectionContext:
    length = n_bars * BAR
    duration_ms = int(length / SR * 1000)
    n_frames = length // 512 + 1
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
    if beat_times_ms is None:
        beat_times_ms = [int(i * beat_ms) for i in range(n_bars * BEATS_PER_BAR + 1)]
    return DetectionContext(
        audio=np.sum(list(stems.values()), axis=0), sr=SR, duration_ms=duration_ms,
        stems=stems, features=features,
        energy_curve=np.zeros(duration_ms // 100 + 1, dtype=np.float32),
        tension_curve=np.zeros(duration_ms // 100 + 1, dtype=np.float32),
        bpm=BPM, beat_times_ms=beat_times_ms,
        slug="synthetic", grid_offset_ms=0, time_signature="4/4",
        beats_per_bar=BEATS_PER_BAR, grid_mode="static",
    )


def _ctx(answers) -> DetectionContext:
    """Vocals ask on even bars; the guitar enters on the odd bar after phrase k
    when answers(k, name, rng) — with a different note each time, because an
    answer does not have to resemble itself."""
    rng = np.random.default_rng(2)
    vocals = np.zeros(N_BARS * BAR)
    guitar = np.zeros(N_BARS * BAR)
    for k, name in enumerate(_sequence()):
        vocals[2 * k * BAR:(2 * k + 1) * BAR] = _phrase(PHRASES[name])
        if answers(k, name, rng):
            guitar[(2 * k + 1) * BAR:(2 * k + 2) * BAR] = _tone(660 + 40 * rng.integers(0, 5), BAR)
    noise = np.random.default_rng(0).normal(0, 1e-4, N_BARS * BAR)
    stems = {"vocals": (vocals + noise).astype(np.float32),
             "guitar": (guitar + noise).astype(np.float32)}
    return _context(stems)


def _bar(ms: int) -> int:
    return int(round(ms / (BAR / SR * 1000)))


def test_finds_every_statement_of_the_answered_phrase():
    spans = CallResponseSsm().detect(_ctx(lambda k, name, rng: name == "X"))
    calls = sorted(_bar(s.start_ms) for s in spans if s.label.startswith("call"))
    responses = sorted(_bar(s.start_ms) for s in spans if s.label.startswith("response"))
    x_bars = [2 * k for k, name in enumerate(_sequence()) if name == "X"]
    assert calls == x_bars
    assert responses == [b + 1 for b in x_bars]
    assert all("(vocals" in s.label for s in spans if s.label.startswith("call"))
    assert all("(guitar" in s.label for s in spans if s.label.startswith("response"))


def test_silent_when_every_phrase_is_answered():
    assert CallResponseSsm().detect(_ctx(lambda k, name, rng: True)) == []


def test_silent_when_answers_follow_no_particular_phrase():
    assert CallResponseSsm().detect(_ctx(lambda k, name, rng: rng.random() < 0.34)) == []


# ── Within one stem ───────────────────────────────────────────────────────
# One continuous stem, bar by bar: nobody yields, so only the checkerboard in
# its own SSM can show an exchange.

WITHIN_BARS = 32


def _choir(notes) -> np.ndarray:
    """The same notes as _phrase, sung by "more voices": a detuned stack with
    a brighter spectrum — a different texture, not a different line."""
    q = BAR // 4
    t = np.arange(q) / SR
    out = []
    for f in notes:
        y = sum(0.25 * np.sin(2 * np.pi * f * d * t) for d in (0.99, 1.0, 1.01))
        y += sum(0.15 * np.sin(2 * np.pi * f * h * t) for h in (3, 4, 5))
        r = int(0.01 * SR)
        y[:r] *= np.linspace(0.0, 1.0, r)
        y[-r:] *= np.linspace(1.0, 0.0, r)
        out.append(y)
    return np.concatenate(out)


def _one_stem(bars: list[np.ndarray], key: str = "other") -> DetectionContext:
    y = np.concatenate(bars) + np.random.default_rng(0).normal(0, 1e-4, len(bars) * BAR)
    return _context({key: y.astype(np.float32)}, n_bars=len(bars))


def _within(ctx, key="other"):
    return within_stem_spans(ctx, key)


def test_within_finds_two_phrases_trading():
    bars = [_phrase(PHRASES["X" if i % 2 == 0 else "Y"]) for i in range(WITHIN_BARS)]
    spans = _within(_one_stem(bars))
    assert spans, "Q A Q A for 32 bars must be found"
    covered = sum(s.duration_ms for s in spans) / (WITHIN_BARS * BAR / SR * 1000)
    assert covered > 0.8
    labels = [s.label.split(" ")[0] for s in sorted(spans, key=lambda s: s.start_ms)]
    assert all(a != b for a, b in zip(labels, labels[1:])), "call and response must alternate"


def test_within_finds_a_lead_answered_by_voices_on_the_same_notes():
    notes = PHRASES["X"]
    bars = [_phrase(notes) if i % 2 == 0 else _choir(notes) for i in range(WITHIN_BARS)]
    assert _within(_one_stem(bars, "vocals"), "vocals")


def test_within_silent_on_one_phrase_repeated():
    bars = [_phrase(PHRASES["X"]) for _ in range(WITHIN_BARS)]
    assert _within(_one_stem(bars)) == []


def test_within_silent_on_phrases_in_no_order():
    rng = np.random.default_rng(3)
    bars = [_phrase(PHRASES[str(rng.choice(["X", "Y", "Z"]))]) for _ in range(WITHIN_BARS)]
    assert _within(_one_stem(bars)) == []


def test_within_silent_on_a_three_part_section_repeated():
    """Three different 4-bar parts, A B C, repeated: a section, not an
    exchange. No turn length makes it return every other turn. (Two parts,
    A B A B, would be found — see within_stem_spans for why that cannot be
    told apart from a question and its answer.)"""
    rng = np.random.default_rng(4)
    section = [_phrase(rng.choice([196, 220, 247, 262, 294, 330, 370, 392], 4)) for _ in range(12)]
    assert _within(_one_stem(section * 3)) == []

