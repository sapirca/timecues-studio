#!/usr/bin/env python3
"""
Pure-librosa CUE-family extras server. Four lightweight detectors that
share one sidecar to keep the docker image count manageable:

  librosa-key       Krumhansl-Schmuckler key correlation against the 24
                    major/minor templates. Emits a single global-key cue
                    at t=0 + per-segment cues at every key change.
  autochord-chords  Chroma-template chord recognition via the `autochord`
                    pip package. One cue per chord transition, labelled
                    with the chord symbol (e.g. "Am", "G/B", "C:maj7").
  librosa-onsets    librosa.onset.onset_detect. One cue per transient
                    onset (kick hits, FX triggers, anything sharp).
  drum-transients   librosa-onsets' events, each labelled kick / snare / hat
                    and moved from the flux peak back to the attack itself.
                    Meant for the Demucs `drums` stem.

All four are pure DSP-ish — no pretrained neural-net weights, no GPU,
no special install. autochord is the only non-librosa pip dep here.

Endpoints
---------
  GET  /api/cue-extras/health              → server up + per-detector status
  GET  /api/cue-extras/algorithms          → [{ id, name, available, description }]
  GET  /api/cue-extras/detect/:slug/:algo  → cached result, or null
  POST /api/cue-extras/detect              { slug, algo, force? }
  POST /api/cue-extras/initialize          { algo } — no-op (warms imports)

Output schema (one shape for all three — every detector returns cues
that the boundary-style inspector can render as points-in-time)
-------------------------------------------------------------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "cues": [
      {
        "time":       float,       # seconds
        "label":      str,         # detector-specific
        "confidence": float | None # 0..1 when the detector exposes one
      }
    ],
    "key":         str | null,     # only set by librosa-key
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/cue-extras/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# autochord ships a legacy Keras-2 SavedModel that Keras 3 (bundled with
# TensorFlow 2.16+) refuses to load. The standard escape hatch is to keep
# tf-keras installed and flip this env var BEFORE the first `import
# tensorflow` so tf.keras resolves to the legacy package. Must be set
# before the `import autochord` below, which transitively imports TF.
#
# Only set it when tf_keras is actually importable: the Docker image pins
# tensorflow<2.16 (native Keras 2, no separate tf_keras), and forcing
# TF_USE_LEGACY_KERAS=1 there makes TF demand a tf_keras package that isn't
# installed — which silently breaks `import autochord`. Gate on availability
# so the env var helps the TF≥2.16 (bare-metal) case without sabotaging the
# pinned-TF Docker case.
try:
    import tf_keras  # noqa: F401
    os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
except ImportError:
    pass

warnings.filterwarnings("ignore")

PORT = 8014

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    find_audio, stem_audio, cache_name, CUE_EXTRAS_OUTPUTS_DIR as CACHE_DIR,
)
from server_common import cached_result, cors_headers, err as _common_err, now_iso, time_ms  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa
    import scipy.signal as _scipy_signal  # librosa's own dependency
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False

try:
    from energy_gate import gate_point_events
    _ENERGY_GATE_OK = True
except Exception:
    _ENERGY_GATE_OK = False

try:
    import autochord  # noqa: F401
    _AUTOCHORD_OK = True
except Exception:
    _AUTOCHORD_OK = False


def _err(algo: str, msg: str) -> dict:
    return _common_err(algo, msg, cues=[])


# ─── Detector: librosa Krumhansl-Schmuckler key ─────────────────────────────

# Krumhansl-Schmuckler probe-tone profiles. Each is the relative weight of
# the 12 pitch classes for a given key — correlating the song's chroma
# distribution against rotated versions of these picks the key.
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                      2.52, 5.19, 2.39, 3.66, 2.29, 2.88]) if _NUMPY_OK else None
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                      2.54, 4.75, 3.98, 2.69, 3.34, 3.17]) if _NUMPY_OK else None
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _ks_key_from_chroma(chroma_col: "np.ndarray") -> tuple[str, float]:
    """Return (key_name, correlation_score) for a single chroma vector.
    Iterates all 24 rotations (12 major + 12 minor)."""
    best_score = -2.0
    best_label = "C major"
    chroma_z = chroma_col - chroma_col.mean()
    chroma_n = np.linalg.norm(chroma_z) or 1e-9
    for i in range(12):
        for mode_name, profile in (("major", _KS_MAJOR), ("minor", _KS_MINOR)):
            rotated = np.roll(profile, i)
            rot_z = rotated - rotated.mean()
            rot_n = np.linalg.norm(rot_z) or 1e-9
            score = float(np.dot(chroma_z, rot_z) / (chroma_n * rot_n))
            if score > best_score:
                best_score = score
                best_label = f"{_NOTE_NAMES[i]} {mode_name}"
    return best_label, best_score


def detect_librosa_key(audio_path: Path) -> dict:
    algo = "librosa-key"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        # CENS (chroma energy normalized) is the recommended chroma flavour
        # for key detection — robust to dynamics and timbre.
        chroma = librosa.feature.chroma_cens(y=y, sr=sr)
        # Global key: average chroma across the whole track.
        global_chroma = chroma.mean(axis=1)
        global_key, global_score = _ks_key_from_chroma(global_chroma)
        duration = float(len(y) / sr)

        # Per-segment key change detection: walk a 10 s sliding window with
        # 5 s hop and emit a cue whenever the local key differs from the
        # previous window's. Coarse — caller can re-derive a finer grid
        # from the global cue itself if they want.
        hop_len = int(5.0 * (sr / 512))  # librosa chroma hop is 512 samples
        win_len = int(10.0 * (sr / 512))
        cues: list[dict] = []
        # Always emit a global-key cue at t=0 so downstream consumers see
        # at least one entry per song.
        cues.append({
            "time":       0.0,
            "label":      global_key,
            "confidence": max(0.0, min(1.0, global_score)),
        })
        prev_key = global_key
        if chroma.shape[1] >= win_len:
            for start in range(0, chroma.shape[1] - win_len + 1, hop_len):
                local_chroma = chroma[:, start : start + win_len].mean(axis=1)
                local_key, local_score = _ks_key_from_chroma(local_chroma)
                if local_key != prev_key and local_score > 0.5:
                    cue_time = float(start * 512 / sr)
                    cues.append({
                        "time":       cue_time,
                        "label":      local_key,
                        "confidence": max(0.0, min(1.0, local_score)),
                    })
                    prev_key = local_key

        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  duration,
            "key":       global_key,
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Detector: autochord chord recognition ──────────────────────────────────

def detect_autochord(audio_path: Path) -> dict:
    algo = "autochord-chords"
    if not _AUTOCHORD_OK:
        return _err(algo, "autochord not installed")
    if not _LIBROSA_OK:
        return _err(algo, "librosa not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        # autochord.recognize() returns a list of (start, end, chord_label).
        # It re-decodes the audio internally; we don't need to pre-load.
        chord_segments = autochord.recognize(str(audio_path))  # type: ignore[union-attr]
        cues: list[dict] = []
        prev = None
        for seg in chord_segments:
            start, _end, label = seg
            label = str(label).strip()
            # Skip silence / no-chord markers but keep them as a transition
            # signal so the cue list reflects "chord goes away here" too.
            if label == prev:
                continue
            cues.append({
                "time":       float(start),
                "label":      label or "N",
                "confidence": None,
            })
            prev = label

        # Duration: cheaper to derive from the last chord segment than to
        # re-decode the file.
        if chord_segments:
            duration = float(chord_segments[-1][1])
        else:
            duration = 0.0
        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  duration,
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Detector: librosa onset detector ───────────────────────────────────────

def detect_librosa_onsets(audio_path: Path) -> dict:
    algo = "librosa-onsets"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="frames")
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)
        # Strength curve (1 sample per onset frame) so we can attach a
        # confidence in [0, 1] proportional to peak prominence.
        env = librosa.onset.onset_strength(y=y, sr=sr)
        if len(env) > 0:
            env_max = float(env.max() or 1.0)
        else:
            env_max = 1.0
        cues: list[dict] = []
        for t, f in zip(onset_times, onset_frames):
            strength = float(env[min(int(f), len(env) - 1)] / env_max) if len(env) else None
            cues.append({
                "time":       float(t),
                "label":      "onset",
                "confidence": max(0.0, min(1.0, strength)) if strength is not None else None,
            })
        # Onset strength is normalized to the stem's own peak, so noise-floor
        # bleed in a near-silent stem peaks at confidence ~1.0. Drop onsets in
        # regions that are inaudible in absolute terms.
        gated_out = 0
        if _ENERGY_GATE_OK:
            cues, gated_out = gate_point_events(cues, y, sr)
        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  float(len(y) / sr),
            "gated_out": gated_out,
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Detector: per-band drum transients ─────────────────────────────────────
#
# What this adds over librosa-onsets is a LABEL for each hit and a better TIME
# for it — not a different set of hits. WHICH events exist is decided by
# librosa.onset.onset_detect with its stock parameters on a 22.05 kHz mono load,
# byte-for-byte the path librosa-onsets takes, so the two detectors always find
# the same hits. Each one is then classified kick / snare / hat by which part of
# the spectrum moved, and moved from the flux peak back to its attack (below).
#
# Three alternatives were tried on the shipped drums stems (2026-09-22) and
# dropped. Read the numbers with one caveat: they were scored against
# librosa.beat.beat_track, whose beats come from the same late hop-512 onset
# envelope, so that score favours late times and says nothing trustworthy about
# timing (see the note further down). What each finding rests on:
#
#   * backtrack=True walks each peak back to the previous energy minimum with no
#     bound. Measured directly, not against beats: it moved hits a median of
#     46 ms and up to 139 ms — a 32nd note or more, past the attack into the
#     previous decay. The bounded refinement below moves them ~20 ms.
#   * detecting at 44.1 kHz / hop 128 found about as many hits as the default
#     hop 512 (within 8% on each stem) for 8x the frames, and nothing showed the
#     extra hits were real. Its slightly lower on-beat score is the biased
#     metric, so it is no evidence either way on timing.
#   * per-band peak-picking — running the flux separately inside each band —
#     fired 6-7 "kicks" a second on four-on-the-floor tracks that have about 2:
#     a kick's own decay re-triggers the low band. That is a count, so the
#     beat-scoring caveat does not touch it.
#
# The sample rate is raised only where it genuinely matters: hats and cymbals
# live above 11 kHz, which a 22.05 kHz load has already thrown away, so the
# classifier and the attack refinement both read a second 44.1 kHz load.
#
# WHERE a hit is, though, is not left at the detector's frame. onset_detect
# reports the hop-512 frame where the flux PEAKS, which sits 20-30 ms after the
# drum actually starts: on the synthetic fixture the stock times are late by a
# mean of 19 ms (worst 33), and on the Alor drums stem every hit sat ~25 ms to
# the right of its own attack — at ultra zoom the cue drew over the hit's decay,
# not its start. Each event is therefore localised a second time, on its own
# (see _refine_attack_times): the EVENTS are still exactly librosa's, only the
# time of each one moves, and only inside a short bounded window. That bound is
# the whole difference from backtrack=True above, which is unbounded and walks
# into the previous subdivision. Result (2026-09-22): fixture mean error 2.0 ms,
# worst 3.6 ms; on the Alor stem snares/hats land within ~2 ms of the attack and
# kicks within ~6 ms.
#
# One trap for anyone re-measuring: scoring against librosa.beat.beat_track is
# circular for timing. Its beats are built from the same hop-512 onset envelope,
# so they share its late bias and "prefer" the unrefined times. Judge timing
# against audio whose attacks are known (the test fixture) or measured directly.
#
# This is a heuristic and its limits are real: three bands cannot separate a tom
# from a snare or a ride from a closed hat, and a kick and a hat struck together
# produce one onset and therefore one label — whichever band moved more. It
# answers "kick, snare, or cymbal-ish", which is what a cue lane uses.

# Detection: exactly librosa-onsets' load and parameters. Do not "improve"
# these without re-running tools/python/tests/test_drum_transients.py.
_DRUM_DETECT_SR = 22050

# Classification: a second, higher-rate view used only to read band energies.
_DRUM_LABEL_SR = 44100
_DRUM_LABEL_N_FFT = 2048
_DRUM_LABEL_HOP = 256
# Energy is read over this window starting at the onset — long enough to catch
# a snare's body, short enough not to swallow the next 16th at fast tempi.
_DRUM_LABEL_WIN_S = 0.040

# (label, lo_hz, hi_hz). Deliberately NOT adjacent: the gaps (120-250 Hz and
# 2.5-6 kHz) are where the three drums overlap most, and leaving them out buys
# more in separation than it costs in sensitivity. The snare band starts at
# 250 Hz rather than 150 because a kick's beater click reaches well up into the
# low mids — with the edge at 150 Hz the snare band swallowed kicks, and only a
# third as many were labelled correctly.
_DRUM_BANDS: tuple[tuple[str, float, float], ...] = (
    ("kick",    20.0,   120.0),
    ("snare",  250.0,  2500.0),
    ("hat",   6000.0, 16000.0),
)

# Percentile of each band's own energy used to put the three bands on a common
# scale before the argmax. Swept over {75, 90, 95} against the shipped corpus;
# 95 kept kick-on-beat agreement highest (94% / 91% on the two tracks with a
# clean grid) while still recovering roughly three times as many kicks as 90.
_DRUM_BAND_SCALE_PCT = 95


# Attack localisation (see _refine_attack_times). The search reaches back 40 ms
# — the detector's lag is one or two 23 ms hops — and 10 ms forward, never
# further. An attack is where the band's envelope first rises past this
# fraction of the way from the window's floor to the hit's peak; measuring from
# the floor rather than from zero is what lets a hat struck on a kick's tail be
# found at all (from zero, 8% of the Alor hits never dropped below threshold and
# stuck to the window edge).
_DRUM_ATTACK_BACK_S = 0.040
_DRUM_ATTACK_FWD_S = 0.010
_DRUM_ATTACK_FRAC = 0.2
# A kick's low band swells over a whole cycle of its fundamental; what is heard
# first is the beater click, which is broadband. Kicks are located from
# whichever of the two rises first.
_DRUM_CLICK_BAND = (1000.0, 16000.0)
# Envelopes are computed on a slice of the song around each hit, padded this
# much on both sides of the search window so the band-pass has settled (and the
# Hilbert transform's edge ripple has died out) before the part that is read.
# The slowest thing in play is the 20 Hz low edge of the kick band; 0.3 s is six
# of its cycles. Computing on the whole song instead gave the same times and
# cost ~540 MB per band for a 3-minute track — see _band_envelope.
_DRUM_ENV_PAD_S = 0.3


# Velocity floor. A hit this many dB below the hardest hit of its own drum is
# velocity 1; the hardest is 127. 40 dB is about the usable dynamic range of a
# struck drum in a mix — below that a hit is either a ghost note or bleed.
_DRUM_VELOCITY_FLOOR_DB = 40.0


# A stem whose hat band holds less than this share of its total energy cannot
# support a `hat` label: there is nothing up there to have detected. Measured
# against the shipped stems, where a normal mix sits at 1.4-23% and a
# band-limited one at 0.1%.
_DRUM_MIN_BAND_SHARE = 0.01
# One band holding more than this is a stem with no contrast left to classify
# on — a clipped 808 puts 81% below 120 Hz.
_DRUM_BAND_DOMINANCE = 0.75
# Below this median margin the labels are, on aggregate, guesses.
_DRUM_MIN_LABEL_CONF = 0.25


def _drum_band_report(S: "np.ndarray", freqs: "np.ndarray", label_conf: list) -> dict:
    """How well this audio supports band classification AT ALL.

    The detector cannot tell you it was wrong — it returns a label for every
    hit whatever the audio looks like, and a wrong label is indistinguishable
    from a right one downstream. What it CAN do is describe the evidence it had
    and say when there was none, which is the difference between a groove a
    curator can trust and one they cannot.

    The shipped stems make the case. `edm-at-midnight` carries 23% of its
    energy in the hat band and labels kicks onto beats 94% of the time;
    `phonk-remix` rolls off at 9 kHz and carries 0.1% there, so every hit it
    called a hat was a classification of noise — and nothing in the output
    said so.
    """
    total = float(S.sum()) or 1.0
    shares: dict[str, float] = {}
    for label, lo, hi in _DRUM_BANDS:
        bins = np.where((freqs >= lo) & (freqs < hi))[0]
        shares[label] = float(S[bins].sum()) / total if bins.size else 0.0

    per_freq = S.sum(axis=1)
    cumulative = np.cumsum(per_freq)
    hit = np.searchsorted(cumulative, 0.995 * cumulative[-1]) if cumulative[-1] > 0 else 0
    rolloff = float(freqs[min(int(hit), len(freqs) - 1)])

    conf = sorted(c for c in label_conf if c is not None)
    median_conf = float(conf[len(conf) // 2]) if conf else 0.0

    warnings: list[dict] = []
    for label, lo, hi in _DRUM_BANDS:
        if shares[label] < _DRUM_MIN_BAND_SHARE:
            warnings.append({
                "code": f"empty-band:{label}",
                "message": (
                    f"The {lo:.0f}-{hi:.0f} Hz band used to identify {label} holds "
                    f"{shares[label] * 100:.1f}% of this stem's energy"
                    + (f", which rolls off at {rolloff / 1000:.1f} kHz" if hi > rolloff else "")
                    + f". Any hit labelled {label} here is a guess."
                ),
            })
    loudest = max(shares, key=lambda k: shares[k]) if shares else None
    if loudest and shares[loudest] >= _DRUM_BAND_DOMINANCE:
        warnings.append({
            "code": f"one-band-dominates:{loudest}",
            "message": (
                f"{shares[loudest] * 100:.0f}% of this stem's energy is in the {loudest} "
                "band — a clipped 808, a heavy sub, or bleed. Hits are named by "
                "comparing bands, so there is little contrast left to name them by."
            ),
        })
    if conf and median_conf < _DRUM_MIN_LABEL_CONF:
        warnings.append({
            "code": "labels-near-chance",
            "message": (
                f"Half the hits were named on a margin of {median_conf:.2f} or less "
                "between the winning band and the runner-up. Treat kick/snare/hat "
                "here as unreliable."
            ),
        })
    return {
        "bandShares": {k: round(v, 4) for k, v in shares.items()},
        "rolloffHz": round(rolloff, 1),
        "medianLabelConfidence": round(median_conf, 4),
        "warnings": warnings,
    }


def _drum_band_profile(
    y: "np.ndarray", sr: int, times: "np.ndarray",
) -> tuple[list[tuple[str, int, float, float]], dict]:
    """Classify and measure each onset: (label, velocity, level_db, label_conf).

    Also returns a per-STEM report describing how well this audio supports
    band classification at all — see `_drum_band_report`.

    Classification: each band is scaled by its own high-percentile energy across
    the track before the comparison. Without that the kick band wins everything
    — low frequencies simply hold more energy than cymbals do, so an unscaled
    argmax labels the entire song "kick".

    The two loudness numbers answer two different questions, which is why both
    are reported rather than one being picked for the caller:

      * `velocity` (1-127, MIDI-shaped) is how hard THIS drum was struck,
        measured against the hardest hit of the SAME drum in the track. A
        full-force hi-hat is 127 even though it is far quieter than any kick.
        This is the one that means "ghost note vs. accent".
      * `level_db` is the hit's actual level, measured against the loudest hit
        anywhere in the track (so it is always <= 0). This is the one that is
        comparable ACROSS instruments — it is what says a kick is louder than
        a hat, which per-drum velocity deliberately throws away.
    """
    S = np.abs(librosa.stft(y, n_fft=_DRUM_LABEL_N_FFT, hop_length=_DRUM_LABEL_HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=_DRUM_LABEL_N_FFT)
    energies = []
    for _label, lo, hi in _DRUM_BANDS:
        bins = np.where((freqs >= lo) & (freqs < hi))[0]
        energies.append(S[bins].sum(axis=0) if bins.size else np.zeros(S.shape[1]))
    energies = np.asarray(energies)
    scale = np.percentile(energies, _DRUM_BAND_SCALE_PCT, axis=1, keepdims=True)
    scale[scale <= 0] = 1.0
    normalized = energies / scale

    fps = sr / _DRUM_LABEL_HOP
    width = max(1, int(_DRUM_LABEL_WIN_S * fps))
    n_frames = normalized.shape[1]

    # Pass 1: label each hit, and record the RAW (unscaled) energy of the band
    # it was assigned to. Velocity has to come off the real energy — the scaled
    # copy exists only to make the three bands argmax-comparable, and reading a
    # loudness off it would report every drum as equally hard-hit.
    band_index: list[int] = []
    raw_peak: list[float] = []
    label_conf: list[float] = []
    for t in times:
        start = min(int(round(float(t) * fps)), max(n_frames - 1, 0))
        window = normalized[:, start:start + width]
        profile = window.max(axis=1) if window.size else np.zeros(len(_DRUM_BANDS))
        idx = int(np.argmax(profile))
        raw_window = energies[idx, start:start + width]
        band_index.append(idx)
        raw_peak.append(float(raw_window.max()) if raw_window.size else 0.0)
        # How far the winning band beat the runner-up, as a fraction of the
        # winner. 1.0 = only one band held anything; 0.0 = a tie, i.e. the
        # argmax above picked between two equals and the label is a coin flip.
        # This is NOT the `confidence` the cue carries: that one is onset
        # strength, which says something was struck, not what struck it. A
        # clipped 808 smears across every band and scores high on one and low
        # on the other, which is the whole point of reporting them apart.
        ranked = np.sort(profile)[::-1]
        top = float(ranked[0]) if ranked.size else 0.0
        second = float(ranked[1]) if ranked.size > 1 else 0.0
        label_conf.append(round((top - second) / top, 4) if top > 0 else 0.0)

    peaks = np.asarray(raw_peak)
    indices = np.asarray(band_index)
    # Per-drum reference for velocity, track-wide reference for level.
    track_ref = float(peaks.max()) if peaks.size else 0.0
    band_ref = {}
    for idx in range(len(_DRUM_BANDS)):
        mine = peaks[indices == idx] if peaks.size else np.array([])
        band_ref[idx] = float(mine.max()) if mine.size else 0.0

    out: list[tuple[str, int, float, float]] = []
    for idx, peak, conf in zip(band_index, peaks, label_conf):
        label = _DRUM_BANDS[idx][0]
        # Power ratios -> dB is 10*log10; these are summed |STFT|^2 energies.
        ref_b = band_ref.get(idx, 0.0)
        if ref_b > 0 and peak > 0:
            db_in_drum = 10.0 * np.log10(peak / ref_b)
            frac = 1.0 + (db_in_drum / _DRUM_VELOCITY_FLOOR_DB)
            velocity = int(round(1.0 + 126.0 * max(0.0, min(1.0, frac))))
        else:
            velocity = 1
        if track_ref > 0 and peak > 0:
            level_db = float(round(10.0 * np.log10(peak / track_ref), 2))
        else:
            level_db = -120.0
        out.append((label, velocity, level_db, conf))
    return out, _drum_band_report(S, freqs, label_conf)


def _band_envelope(y: "np.ndarray", sr: int, lo: float, hi: float) -> "np.ndarray":
    """Amplitude envelope of one band, with no added delay.

    Called on a short slice around one hit, never on the whole song. The
    Hilbert transform is an FFT over its entire input as complex128, so on a
    whole 3-minute track (padded to 2^24 samples) it held ~540 MB per band at
    its peak, to read 50 ms around each hit. On a 0.65 s slice it is ~1 MB.

    sosfiltfilt runs the filter forwards and back, so its phase cancels — a
    one-pass filter would shift the envelope late by its group delay, which in
    the 20-120 Hz band is itself several milliseconds, the very error this is
    here to remove. The Hilbert magnitude is a true envelope: rectifying and
    smoothing instead leaves a ripple at twice the band's frequency, which in
    the kick band is slower than the attack being measured.
    """
    nyq = sr / 2.0
    hi = min(hi, nyq * 0.99)
    sos = _scipy_signal.butter(4, [lo / nyq, hi / nyq], btype="band", output="sos")
    band = _scipy_signal.sosfiltfilt(sos, y)
    n_fft = 1 << int(np.ceil(np.log2(max(len(band), 1))))  # pow-2: 10x faster
    return np.abs(_scipy_signal.hilbert(band, N=n_fft)[:len(band)])


def _refine_attack_times(
    y: "np.ndarray", sr: int, times: "np.ndarray", labels: list[str],
) -> list[float]:
    """Move each detected hit from its flux peak back to its attack.

    Per hit: take the envelope of the band the hit was labelled with, find the
    peak inside [t - 40 ms, t + 10 ms], and walk back from it to where the
    envelope was only _DRUM_ATTACK_FRAC of the way up from the window's floor.
    Using the hit's own band is what keeps a hat that lands on a kick's decay
    from being located on the kick.

    The window never reaches back past the previous detection (plus the forward
    reach), so a hit cannot claim its neighbour's attack and the output stays
    in order. When there is nothing to localise — a flat window — the
    detector's own time is kept.
    """
    bands = {label: (lo, hi) for label, lo, hi in _DRUM_BANDS}
    pad = int(_DRUM_ENV_PAD_S * sr)

    def attack_in(env: "np.ndarray", a: int, b: int) -> int | None:
        seg = env[a:b]
        if seg.size < 8:
            return None
        pk = int(np.argmax(seg))
        floor = float(seg[:pk + 1].min())
        peak = float(seg[pk])
        if peak <= floor:
            return None
        thr = floor + _DRUM_ATTACK_FRAC * (peak - floor)
        i = pk
        while i > 0 and seg[i] > thr:
            i -= 1
        return a + i

    out: list[float] = []
    prev = None
    n = len(y)
    for t, label in zip(times, labels):
        t = float(t)
        lo_t = t - _DRUM_ATTACK_BACK_S
        if prev is not None:
            lo_t = max(lo_t, prev + _DRUM_ATTACK_FWD_S)
        prev = t
        a = max(0, int(lo_t * sr))
        b = min(n, int((t + _DRUM_ATTACK_FWD_S) * sr))
        if b <= a:
            out.append(t)
            continue
        # Envelope of just this hit's neighbourhood; indices shift by s0.
        s0, s1 = max(0, a - pad), min(n, b + pad)
        seg = y[s0:s1]
        found = [attack_in(_band_envelope(seg, sr, *bands[label]), a - s0, b - s0)]
        if label == "kick":
            found.append(attack_in(_band_envelope(seg, sr, *_DRUM_CLICK_BAND), a - s0, b - s0))
        found = [f + s0 for f in found if f is not None]
        out.append(min(found) / sr if found else t)
    return out


def detect_drum_transients(audio_path: Path) -> dict:
    algo = "drum-transients"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=_DRUM_DETECT_SR, mono=True)
        if y.size == 0:
            return _err(algo, "empty audio")
        onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="frames")
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)
        env = librosa.onset.onset_strength(y=y, sr=sr)
        env_max = float(env.max() or 1.0) if len(env) else 1.0

        # Label on the detector's own times — the classifier's 40 ms window was
        # tuned against them — then move each hit to its attack.
        if len(onset_times):
            y_hi, sr_hi = librosa.load(str(audio_path), sr=_DRUM_LABEL_SR, mono=True)
            profile, report = _drum_band_profile(y_hi, sr_hi, onset_times)
            attack_times = _refine_attack_times(
                y_hi, sr_hi, onset_times, [p[0] for p in profile])
        else:
            profile, attack_times = [], []
            report = {"bandShares": {}, "rolloffHz": 0.0,
                      "medianLabelConfidence": 0.0, "warnings": []}
        cues: list[dict] = []
        for t, t_det, f, (label, velocity, level_db, label_conf) in zip(
                attack_times, onset_times, onset_frames, profile):
            strength = float(env[min(int(f), len(env) - 1)] / env_max) if len(env) else None
            cues.append({
                "time":       float(t),
                "_detected":  float(t_det),
                "label":      label,
                "confidence": max(0.0, min(1.0, strength)) if strength is not None else None,
                # How hard THIS drum was struck (1-127, against the same drum's
                # hardest hit). Distinct from `confidence`, which is how sure the
                # detector is that anything happened at all.
                "velocity":   velocity,
                # Actual level vs. the loudest hit in the track, in dB (<= 0).
                # Comparable across instruments; `velocity` deliberately is not.
                "levelDb":    level_db,
                # How sure the detector is of the LABEL, which is a different
                # question from `confidence` above and often a very different
                # number: a clipped 808 is unmistakably a hit (high confidence)
                # and unnameable (low labelConfidence).
                "labelConfidence": label_conf,
            })
        # Same audibility gate librosa-onsets uses: onset strength is relative to
        # the stem's own peak, so a drums stem that is mostly separation bleed
        # still peak-picks confidently. It decides on the DETECTOR's time, not
        # the refined one, so exactly the hits librosa-onsets keeps are kept:
        # gating the moved time shifts the gate's window and lets a hit or two
        # per track through that librosa-onsets drops.
        gated_out = 0
        if _ENERGY_GATE_OK:
            cues, gated_out = gate_point_events(cues, y, sr, time_key="_detected")
        for c in cues:
            del c["_detected"]
        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  float(len(y) / sr),
            "gated_out": gated_out,
            # What the labels rest on, and when they rest on nothing. A caller
            # that ignores this gets exactly what it got before.
            "quality":   report,
            "warnings":  report.get("warnings") or [],
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "librosa-key": {
        "name":        "librosa key (KS templates)",
        "description": "Krumhansl-Schmuckler key correlation. Global + per-segment key cues. Pure DSP.",
        "detect":      detect_librosa_key,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
    },
    "autochord-chords": {
        "name":        "autochord (chord recognition)",
        "description": "Chroma-template chord recognition. One cue per chord change. Pure DSP-ish (autochord package).",
        "detect":      detect_autochord,
        "available":   lambda: _AUTOCHORD_OK and _LIBROSA_OK,
    },
    "librosa-onsets": {
        "name":        "librosa onsets",
        "description": "Spectral-flux onset detection. One cue per transient. Pure DSP.",
        "detect":      detect_librosa_onsets,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
    },
    "drum-transients": {
        "name":        "drum transients (per-band)",
        "description": "Onsets located to the attack (within a few ms), one cue per hit, labelled kick / snare / hat. Run it on the drums stem. Pure DSP.",
        "detect":      detect_drum_transients,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
    },
}


def detect_one(slug: str, algo: str, stem: str = "mix", force: bool = False) -> dict:
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Per-stem runs cache under "<algo>__<stem>.json"; the full mix keeps the
    # bare "<algo>.json" name so existing caches stay valid.
    cache_path = cache_dir / f"{cache_name(algo, stem)}.json"
    hit = cached_result(cache_path, force)
    if hit is not None:
        return hit
    if stem and stem != "mix":
        audio_path = stem_audio(slug, stem)
        if audio_path is None:
            raise FileNotFoundError(f"no cached '{stem}' stem for slug: {slug}")
    else:
        audio_path = find_audio(slug)
        if audio_path is None:
            raise FileNotFoundError(f"audio not found for slug: {slug}")
    result = ALGORITHMS[algo]["detect"](audio_path)
    payload: dict = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "algorithm":   algo,
        "stem":        stem or "mix",
        "duration":    result.get("duration", 0.0),
        "cues":        result.get("cues", []),
        "gated_out":   result.get("gated_out", 0),
        "ok":          result.get("ok", False),
        "error":       result.get("error"),
        "ms":          result.get("ms", 0),
        "computed_at": now_iso(),
    }
    if "key" in result:
        payload["key"] = result["key"]
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/cue-extras/health":
            self._send(200, {
                "ok":         _LIBROSA_OK and _NUMPY_OK,
                "librosaOk":  _LIBROSA_OK,
                "numpyOk":    _NUMPY_OK,
                "autochordOk": _AUTOCHORD_OK,
            })
            return
        if path == "/api/cue-extras/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/cue-extras/detect/"):
            tail = path[len("/api/cue-extras/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/cue-extras/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            self._send(200, json.loads(cache_path.read_text()) if cache_path.exists() else None)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"})
            return
        if path == "/api/cue-extras/detect":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            stem = str(body.get("stem", "mix")).strip() or "mix"
            force = bool(body.get("force", False))
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            try:
                self._send(200, detect_one(slug, algo, stem=stem, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return
        if path == "/api/cue-extras/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            self._send(200, {"ok": ALGORITHMS[algo]["available"](), "algorithm": algo})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting CUE-extras server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  librosa={_LIBROSA_OK}  numpy={_NUMPY_OK}  autochord={_AUTOCHORD_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
