"""Band-classification tests for the `drum-transients` CUE detector.

The detector makes three promises, and this file pins them.

1. It does not change WHICH events. Detection is librosa-onsets' path verbatim
   — same load, same stock `onset_detect` parameters — so the two detectors
   find the same hits. Only each hit's TIME moves, from the flux peak back to
   the attack, and only inside a bounded window: never more than 40 ms earlier
   or 10 ms later. An unbounded move is exactly how backtrack=True went wrong.

3. It puts each hit ON its attack. The fixture's hits start at known samples,
   so the error is measurable exactly: stock onset_detect is 8-33 ms late on
   it; the refined times must be within a few milliseconds.

2. It gets WHICH right on audio where the answer is not in doubt. The fixture
   is synthetic on purpose: a 60 Hz thump, a band-limited 250-2500 Hz crack and
   a 6-16 kHz hiss, struck at known times, with nothing else in the file. Real
   drums are a judgement call and would make this a taste test; these three are
   not. If a band edge or the scaling percentile is retuned and this fails, the
   retune has broken the basic case, whatever it did for the corpus.

Deliberately NOT asserted: accuracy on real music. Three bands cannot separate
a tom from a snare, and on a heavily saturated mix the labels are unreliable
(the phonk track in the shipped corpus classifies at roughly chance). Those
numbers live in the module comment, measured, rather than being frozen into an
assertion that would fail for the wrong reasons.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

import cue_extras_server as ce  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ce._LIBROSA_OK and ce._NUMPY_OK), reason="librosa / numpy not installed"
)

SR = 44100
HIT_TIMES = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)


def _kick(n, rng):
    """Short 60 Hz thump with a fast decay — energy only in the 20-120 Hz band."""
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * 60 * t) * np.exp(-t * 28.0)


def _snare(n, rng):
    """Noise crack shaped into the 250-2500 Hz band."""
    noise = rng.standard_normal(n)
    spec = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spec[(freqs < 250) | (freqs > 2500)] = 0
    t = np.arange(n) / SR
    return np.fft.irfft(spec, n) * np.exp(-t * 18.0)


def _hat(n, rng):
    """Bright hiss confined to 6-16 kHz — the band a 22.05 kHz load cannot see."""
    noise = rng.standard_normal(n)
    spec = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spec[(freqs < 6000) | (freqs > 16000)] = 0
    t = np.arange(n) / SR
    return np.fft.irfft(spec, n) * np.exp(-t * 60.0)


@pytest.fixture(scope="module")
def drum_wav(tmp_path_factory):
    """kick, snare, hat, kick, snare, hat at 0.5 s intervals."""
    soundfile = pytest.importorskip("soundfile")
    rng = np.random.default_rng(0)
    y = np.zeros(int(SR * 4.0), dtype=np.float64)
    voices = (_kick, _snare, _hat, _kick, _snare, _hat)
    hit_len = int(SR * 0.35)
    for start_s, voice in zip(HIT_TIMES, voices):
        start = int(start_s * SR)
        chunk = voice(hit_len, rng)
        peak = np.abs(chunk).max() or 1.0
        y[start:start + hit_len] += chunk / peak
    y /= np.abs(y).max()
    path = tmp_path_factory.mktemp("drums") / "drums.wav"
    soundfile.write(str(path), y, SR)
    return path


def _label_at(cues, when, tol=0.06):
    near = [c for c in cues if abs(c["time"] - when) < tol]
    assert near, f"no cue detected near {when}s (got {[round(c['time'],3) for c in cues]})"
    return max(near, key=lambda c: c["confidence"] or 0.0)["label"]


def test_same_events_as_librosa_onsets_each_moved_a_bounded_amount(drum_wav):
    """Promise 1: same hits as librosa-onsets; each time moves only in its window."""
    drums = ce.detect_drum_transients(drum_wav)
    onsets = ce.detect_librosa_onsets(drum_wav)
    assert drums["ok"] and onsets["ok"]
    d = [c["time"] for c in drums["cues"]]
    o = [c["time"] for c in onsets["cues"]]
    assert len(d) == len(o)
    for refined, stock in zip(d, o):
        assert -ce._DRUM_ATTACK_BACK_S - 1e-6 <= refined - stock <= ce._DRUM_ATTACK_FWD_S + 1e-6
    assert d == sorted(d)


def test_each_hit_lands_on_its_attack(drum_wav):
    """Promise 3: the cue sits on the sample the drum starts, within 5 ms.

    Stock onset_detect reports the hop-512 frame of the flux peak, 8-33 ms after
    these attacks — at ultra zoom, a cue drawn over the hit's decay.
    """
    cues = ce.detect_drum_transients(drum_wav)["cues"]
    for when in HIT_TIMES:
        nearest = min(cues, key=lambda c: abs(c["time"] - when))
        assert abs(nearest["time"] - when) < 0.005, (
            f"hit at {when}s located at {nearest['time']:.4f}s "
            f"({(nearest['time'] - when) * 1000:+.1f} ms)")


def test_each_band_gets_its_own_label(drum_wav):
    """Promise 2: an unambiguous kick/snare/hat is labelled as such."""
    result = ce.detect_drum_transients(drum_wav)
    assert result["ok"], result.get("error")
    cues = result["cues"]
    expected = ("kick", "snare", "hat", "kick", "snare", "hat")
    got = [_label_at(cues, t) for t in HIT_TIMES]
    assert got == list(expected), f"expected {list(expected)}, got {got}"


def test_labels_are_only_ever_the_three_bands(drum_wav):
    result = ce.detect_drum_transients(drum_wav)
    assert {c["label"] for c in result["cues"]} <= {"kick", "snare", "hat"}


def test_velocity_tracks_how_hard_the_same_drum_was_struck(tmp_path):
    """A kick at a quarter of the amplitude must read as a lower velocity.

    Velocity is per-drum by design, so this compares two kicks — never a kick
    against a hat, which is exactly the comparison velocity refuses to make.
    """
    soundfile = pytest.importorskip("soundfile")
    rng = np.random.default_rng(1)
    y = np.zeros(int(SR * 3.0), dtype=np.float64)
    hit_len = int(SR * 0.35)
    chunk = _kick(hit_len, rng)
    chunk = chunk / (np.abs(chunk).max() or 1.0)
    for start_s, gain in ((0.5, 1.0), (1.5, 0.25)):
        start = int(start_s * SR)
        y[start:start + hit_len] += chunk * gain
    path = tmp_path / "two_kicks.wav"
    soundfile.write(str(path), y, SR)

    cues = ce.detect_drum_transients(path)["cues"]
    loud = [c for c in cues if abs(c["time"] - 0.5) < 0.06]
    soft = [c for c in cues if abs(c["time"] - 1.5) < 0.06]
    assert loud and soft, [round(c["time"], 3) for c in cues]
    assert loud[0]["velocity"] > soft[0]["velocity"]
    assert loud[0]["levelDb"] > soft[0]["levelDb"]


def test_velocity_is_midi_shaped_and_level_is_relative(drum_wav):
    cues = ce.detect_drum_transients(drum_wav)["cues"]
    assert cues
    for c in cues:
        assert 1 <= c["velocity"] <= 127
        assert isinstance(c["velocity"], int)
        # levelDb is measured against the track's loudest hit, so nothing
        # can be above 0 dB and the loudest hit must be at it.
        assert c["levelDb"] <= 0.0
    assert max(c["levelDb"] for c in cues) == pytest.approx(0.0, abs=0.01)
    # The hardest hit of each drum anchors that drum's velocity scale at 127.
    for label in {c["label"] for c in cues}:
        assert max(c["velocity"] for c in cues if c["label"] == label) == 127


def test_registered_and_available():
    assert "drum-transients" in ce.ALGORITHMS
    assert ce.ALGORITHMS["drum-transients"]["available"]() is True


def test_empty_audio_reports_an_error_rather_than_raising(tmp_path):
    soundfile = pytest.importorskip("soundfile")
    path = tmp_path / "silent.wav"
    soundfile.write(str(path), np.zeros(0, dtype=np.float64), SR)
    result = ce.detect_drum_transients(path)
    assert result["ok"] is False
    assert result["cues"] == []


# ── The detector saying what its labels rest on ──────────────────────────────
#
# A wrong label is indistinguishable from a right one downstream: the groove
# renders identically either way, and the curator has no way to tell. The
# detector cannot know it guessed wrong, but it CAN describe the evidence it
# had. The shipped stems are the worked example — `edm-at-midnight` carries 23%
# of its energy in the hat band and lands kicks on beats 94% of the time, while
# `phonk-remix` rolls off at 4.7 kHz and carries 0.09% there, so every hit it
# called a hat was a classification of noise.


def _spectrum(shape_by_band, n_frames=100, n_fft=2048, sr=44100):
    """A synthetic power spectrogram with prescribed energy per drum band."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    S = np.zeros((len(freqs), n_frames))
    for lo, hi, level in shape_by_band:
        bins = np.where((freqs >= lo) & (freqs < hi))[0]
        if bins.size:
            S[bins, :] = level / bins.size
    return S, freqs


def test_a_normal_mix_raises_nothing():
    S, freqs = _spectrum([(20, 120, 40.0), (250, 2500, 30.0), (6000, 16000, 30.0)])
    report = ce._drum_band_report(S, freqs, [0.7] * 20)
    assert report["warnings"] == []


def test_an_empty_hat_band_says_the_hat_labels_are_guesses():
    # A band-limited stem: nothing at all above 6 kHz.
    S, freqs = _spectrum([(20, 120, 50.0), (250, 2500, 20.0)])
    report = ce._drum_band_report(S, freqs, [0.7] * 20)
    codes = [w["code"] for w in report["warnings"]]
    assert "empty-band:hat" in codes
    hat = next(w for w in report["warnings"] if w["code"] == "empty-band:hat")
    assert "guess" in hat["message"]
    # The message has to name the fact that produced it, or it cannot be acted on.
    assert "6000" in hat["message"] and "%" in hat["message"]


def test_one_band_swamping_the_rest_is_reported_even_when_no_band_is_empty():
    """The phonk case. Every band has something in it, so no band is 'empty' —
    but 80% of the stem is the 808, and the comparison that names a hit has
    almost nothing left to compare."""
    S, freqs = _spectrum([(20, 120, 800.0), (250, 2500, 60.0), (6000, 16000, 60.0)])
    report = ce._drum_band_report(S, freqs, [0.7] * 20)
    codes = [w["code"] for w in report["warnings"]]
    assert "one-band-dominates:kick" in codes
    assert not any(c.startswith("empty-band") for c in codes)


def test_labels_decided_by_a_hair_are_reported_as_near_chance():
    S, freqs = _spectrum([(20, 120, 40.0), (250, 2500, 30.0), (6000, 16000, 30.0)])
    report = ce._drum_band_report(S, freqs, [0.02] * 20)
    assert "labels-near-chance" in [w["code"] for w in report["warnings"]]


def test_the_report_measures_where_the_stem_rolls_off():
    S, freqs = _spectrum([(20, 120, 50.0), (250, 2500, 20.0)])
    # Everything is below 2.5 kHz, so the 99.5% rolloff must be too.
    assert report_rolloff(S, freqs) < 2600.0


def report_rolloff(S, freqs):
    return ce._drum_band_report(S, freqs, [0.7])["rolloffHz"]


def test_label_confidence_is_reported_per_hit_and_is_not_onset_strength(drum_wav):
    """Two different questions, two different numbers. A clipped 808 is
    unmistakably a hit and unnameable; reporting one number would have to
    choose which of those to lie about."""
    result = ce.detect_drum_transients(drum_wav)
    assert result["ok"] is True
    assert result["cues"], "fixture produced no hits"
    for c in result["cues"]:
        assert 0.0 <= c["labelConfidence"] <= 1.0
    # On a clean three-band fixture the labels are decided by a wide margin —
    # if this ever reads like a coin flip the classifier, not the test, moved.
    conf = sorted(c["labelConfidence"] for c in result["cues"])
    assert conf[len(conf) // 2] > 0.3
    assert "quality" in result and "bandShares" in result["quality"]
    assert result["warnings"] == []
