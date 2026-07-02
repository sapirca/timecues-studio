#!/usr/bin/env python3
"""
MIR Feature Server — MIRtoolbox-parity feature extraction.

Goal
----
Reproduce, in Python, the practically-used surface of MIRtoolbox
(Lartillot & Toiviainen, Jyväskylä). Where a Python library already covers
a feature we delegate to it; where nothing does we implement it directly.

Engines
-------
  librosa     — spectral, MFCC, chroma, tempo/beats, onsets, SSM, novelty
  scipy       — peak picking, signal helpers
  pyloudnorm  — EBU R128 / BS.1770 integrated LUFS (pure Python, multiarch)
  custom      — HCDF (Harte & Sandler 2006), pulse clarity, fluctuation
                pattern, beat spectrum, low-energy ratio, spectral
                irregularity, Plomp-Levelt roughness, Krumhansl key
  essentia    — OPTIONAL, NOT in the default docker image (no reliable
                arm64 wheel). Pip-install locally to unlock danceability,
                dynamic_complexity, inharmonicity, alt key/tempo. Every
                other feature in this module works without it.

Endpoints
---------
  GET  /api/mir/health             → engine availability + feature list
  GET  /api/mir/features/:slug     → cached result, or null
  POST /api/mir/extract            { slug, force?, sections? }

Cache
-----
  data/algorithm-outputs/mir-features/<slug>.json   (gitignored)

CLI
---
  python tools/python/mir_server.py            # start server on :8007
  python tools/python/mir_server.py <slug>     # one-shot extract to stdout
  python tools/python/mir_server.py --all      # batch every known slug

Feature categories (mapped to MIRtoolbox)
------------------------------------------
  dynamics  : rms_global, rms_curve, low_energy_ratio, dynamic_range_db,
              attack_time_mean, attack_slope_mean
  spectral  : centroid_hz, brightness_1500, rolloff_85, spread_hz,
              skewness, kurtosis, flatness, flux, entropy, irregularity
  timbre    : mfcc_mean[13], mfcc_std[13], zero_crossing_rate,
              roughness, inharmonicity
  tonal     : chroma_mean[12], key, mode, key_strength, key_clarity,
              tonal_centroid_curve_summary, hcdf_mean, hcdf_peak_rate
  rhythm    : tempo_bpm, beat_times, onset_times, event_density,
              pulse_clarity, beat_spectrum_summary, fluctuation_peak_hz
  structure : ssm_compactness, novelty_curve_summary,
              segment_boundaries_sec, segment_count
  highlevel : danceability, dynamic_complexity, loudness_lufs (essentia)
"""

from __future__ import annotations

import json
import math
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

warnings.filterwarnings("ignore")

PORT = 8007

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    REPO_ROOT,
    find_audio,
    list_song_slugs,
    safe_segment,
    MIR_FEATURES_DIR as CACHE_DIR,
    SPAN_OUTPUTS_DIR,
)

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── Optional imports (each engine is independent) ───────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa  # type: ignore
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False
    librosa = None  # type: ignore

try:
    import scipy.signal as scisig  # type: ignore
    import scipy.stats as scistats  # type: ignore
    _SCIPY_OK = True
except ImportError:
    _SCIPY_OK = False

try:
    import essentia.standard as es  # type: ignore
    _ESSENTIA_OK = True
except Exception:
    # essentia is NOT in the default docker image (no reliable arm64 wheel).
    # Power users can `pip install essentia` locally to unlock danceability,
    # dynamic_complexity, and inharmonicity. Without it those three are skipped
    # — every other feature still runs.
    _ESSENTIA_OK = False
    es = None  # type: ignore

try:
    import pyloudnorm  # type: ignore
    _PYLOUDNORM_OK = True
except ImportError:
    _PYLOUDNORM_OK = False
    pyloudnorm = None  # type: ignore


# Feature extraction defaults (match MIRtoolbox conventions where reasonable).
SR = 22050
HOP = 512
N_FFT = 2048
BRIGHTNESS_CUTOFF_HZ = 1500.0  # mirbrightness default
ROLLOFF_PCT = 0.85             # mirrolloff default


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _f(x: Any) -> float:
    """Coerce numpy scalar / array-of-one to plain float (JSON safe)."""
    try:
        if hasattr(x, "item"):
            return float(x.item())
        if hasattr(x, "__len__") and len(x) == 1:
            return float(x[0])
        return float(x)
    except Exception:
        return float("nan")


def _safe(fn: Callable[[], Any], errors: list[dict], name: str) -> Any:
    """Run a feature extractor, collecting exceptions into `errors` rather than
    aborting the whole extraction. Returns None on failure."""
    try:
        return fn()
    except Exception as e:
        errors.append({"feature": name, "error": f"{type(e).__name__}: {e}"})
        return None


def _summary(arr) -> dict:
    """Compact stats for a 1-D time series."""
    if arr is None or not hasattr(arr, "__len__") or len(arr) == 0:
        return {"mean": None, "std": None, "min": None, "max": None, "median": None}
    a = np.asarray(arr, dtype=float)
    a = a[np.isfinite(a)]
    if len(a) == 0:
        return {"mean": None, "std": None, "min": None, "max": None, "median": None}
    return {
        "mean":   _f(np.mean(a)),
        "std":    _f(np.std(a)),
        "min":    _f(np.min(a)),
        "max":    _f(np.max(a)),
        "median": _f(np.median(a)),
    }


# ─── DYNAMICS (mirrms, mirenvelope, mirlowenergy, mirattacktime/slope) ───────

def _feat_dynamics(y, sr, errors):
    out: dict = {}
    if not _LIBROSA_OK:
        return out

    rms = _safe(lambda: librosa.feature.rms(y=y, hop_length=HOP)[0], errors, "rms_curve")
    if rms is not None:
        out["rms_global"]   = _f(np.sqrt(np.mean(y.astype(float) ** 2)))
        out["rms_summary"]  = _summary(rms)
        # mirlowenergy: fraction of frames below the mean RMS.
        mean_rms = float(np.mean(rms))
        out["low_energy_ratio"] = _f(np.mean(rms < mean_rms))
        # Dynamic range in dB between robust max/min frame energies.
        rms_safe = rms[rms > 1e-8]
        if len(rms_safe) > 1:
            out["dynamic_range_db"] = _f(
                20.0 * math.log10(np.percentile(rms_safe, 95) /
                                  max(np.percentile(rms_safe, 5), 1e-8))
            )

    # mirattacktime / mirattackslope — derived from onset envelope around onsets.
    def _attacks():
        env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
        onsets = librosa.onset.onset_detect(
            onset_envelope=env, sr=sr, hop_length=HOP, units="frames")
        if len(onsets) < 2:
            return None
        # Attack region = window before each onset until envelope minimum.
        times, slopes = [], []
        for f in onsets:
            lo = max(0, f - 20)
            window = env[lo:f + 1]
            if len(window) < 3:
                continue
            start = int(np.argmin(window))
            peak  = int(np.argmax(window))
            if peak <= start:
                continue
            n_frames = peak - start
            attack_t = librosa.frames_to_time(n_frames, sr=sr, hop_length=HOP)
            rise = window[peak] - window[start]
            if attack_t > 0:
                times.append(float(attack_t))
                slopes.append(float(rise / attack_t))
        if not times:
            return None
        return {"time_mean": _f(np.mean(times)), "slope_mean": _f(np.mean(slopes)),
                "count": len(times)}

    attacks = _safe(_attacks, errors, "attacks")
    if attacks:
        out["attacks"] = attacks
    return out


# ─── SPECTRAL (mirspectrum, mircentroid, mirbrightness, mirrolloff, ...) ─────

def _feat_spectral(y, sr, errors):
    out: dict = {}
    if not _LIBROSA_OK:
        return out

    S = _safe(lambda: np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP)),
              errors, "stft")
    if S is None:
        return out

    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)

    out["centroid_hz"] = _summary(_safe(
        lambda: librosa.feature.spectral_centroid(S=S, sr=sr)[0],
        errors, "centroid"))

    out["rolloff_85_hz"] = _summary(_safe(
        lambda: librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=ROLLOFF_PCT)[0],
        errors, "rolloff"))

    out["spread_hz"] = _summary(_safe(
        lambda: librosa.feature.spectral_bandwidth(S=S, sr=sr)[0],
        errors, "spread"))

    out["flatness"] = _summary(_safe(
        lambda: librosa.feature.spectral_flatness(S=S)[0],
        errors, "flatness"))

    out["flux"] = _summary(_safe(
        lambda: librosa.onset.onset_strength(S=librosa.amplitude_to_db(S, ref=np.max), sr=sr),
        errors, "flux"))

    # mirbrightness — proportion of spectral energy above a cutoff.
    def _brightness():
        mask = freqs >= BRIGHTNESS_CUTOFF_HZ
        total = np.sum(S, axis=0) + 1e-12
        above = np.sum(S[mask, :], axis=0)
        return above / total
    out["brightness_1500"] = _summary(_safe(_brightness, errors, "brightness"))

    # Higher moments of the magnitude spectrum (frame-wise then summarised).
    def _moments():
        norm = S / (np.sum(S, axis=0, keepdims=True) + 1e-12)
        f = freqs[:, None]
        mean = np.sum(f * norm, axis=0)
        var  = np.sum(((f - mean) ** 2) * norm, axis=0)
        std  = np.sqrt(var + 1e-12)
        skew = np.sum(((f - mean) ** 3) * norm, axis=0) / (std ** 3 + 1e-12)
        kurt = np.sum(((f - mean) ** 4) * norm, axis=0) / (std ** 4 + 1e-12) - 3.0
        return skew, kurt
    moments = _safe(_moments, errors, "moments")
    if moments is not None:
        skew, kurt = moments
        out["skewness"] = _summary(skew)
        out["kurtosis"] = _summary(kurt)

    # mirentropy — Shannon entropy of the normalised spectrum per frame.
    def _entropy():
        norm = S / (np.sum(S, axis=0, keepdims=True) + 1e-12)
        return -np.sum(norm * np.log2(norm + 1e-12), axis=0)
    out["entropy"] = _summary(_safe(_entropy, errors, "entropy"))

    # Krimphoff irregularity (mirregularity): sum |a_k - (a_{k-1}+a_k+a_{k+1})/3|
    def _irregularity():
        # Compute on per-frame magnitude peaks; cheap proxy uses raw bins.
        diff = np.abs(S[1:-1] - (S[:-2] + S[1:-1] + S[2:]) / 3.0)
        return np.sum(diff, axis=0) / (np.sum(S[1:-1], axis=0) + 1e-12)
    out["irregularity"] = _summary(_safe(_irregularity, errors, "irregularity"))

    return out


# ─── TIMBRE (mirmfcc, mirzerocross, mirroughness, mirinharmonicity) ──────────

def _feat_timbre(y, sr, errors):
    out: dict = {}
    if _LIBROSA_OK:
        mfcc = _safe(
            lambda: librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=HOP),
            errors, "mfcc")
        if mfcc is not None:
            out["mfcc_mean"] = [_f(x) for x in np.mean(mfcc, axis=1)]
            out["mfcc_std"]  = [_f(x) for x in np.std(mfcc, axis=1)]

        zcr = _safe(
            lambda: librosa.feature.zero_crossing_rate(y, hop_length=HOP)[0],
            errors, "zcr")
        if zcr is not None:
            out["zero_crossing_rate"] = _summary(zcr)

    # Roughness — sensory dissonance via Plomp-Levelt 1965 + Sethares 1993.
    # Pure NumPy on librosa's spectral peaks, no essentia dependency.
    def _roughness_plomp_levelt():
        if not _LIBROSA_OK:
            return None
        # Extract per-frame peaks; cap to top 10 per frame for speed.
        S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
        freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
        vals = []
        n_frames = S.shape[1]
        # Subsample frames for speed — roughness is slow-moving.
        stride = max(1, n_frames // 200)
        for t in range(0, n_frames, stride):
            mag = S[:, t]
            if not _SCIPY_OK:
                # Cheap fallback: top-k bins.
                idx = np.argpartition(mag, -10)[-10:]
            else:
                idx, _ = scisig.find_peaks(mag, height=float(mag.max()) * 0.1)
                if len(idx) == 0:
                    continue
                if len(idx) > 10:
                    idx = idx[np.argsort(mag[idx])[-10:]]
            f_peaks = freqs[idx]
            a_peaks = mag[idx]
            # Plomp-Levelt curve (Sethares' analytic form).
            #   D(f1, f2) = a1*a2 * (exp(-b1*x) - exp(-b2*x)),
            #   x = |f2 - f1| * s,  s = 0.24 / (0.0207*fmin + 18.96),
            #   b1, b2 = 3.5, 5.75
            total = 0.0
            for i in range(len(f_peaks)):
                for j in range(i + 1, len(f_peaks)):
                    f_min = min(f_peaks[i], f_peaks[j])
                    if f_min <= 0:
                        continue
                    s = 0.24 / (0.0207 * f_min + 18.96)
                    x = abs(f_peaks[j] - f_peaks[i]) * s
                    diss = (math.exp(-3.5 * x) - math.exp(-5.75 * x))
                    total += float(a_peaks[i] * a_peaks[j] * diss)
            vals.append(total)
        if not vals:
            return None
        return _summary(np.asarray(vals))

    rough = _safe(_roughness_plomp_levelt, errors, "roughness")
    if rough is not None:
        out["roughness"] = rough

    # Inharmonicity — only essentia exposes a ready algorithm for it.
    def _inharm():
        if not _ESSENTIA_OK:
            return None
        peaks_alg  = es.SpectralPeaks(orderBy="magnitude")
        harm_alg   = es.HarmonicPeaks()
        inh_alg    = es.Inharmonicity()
        pitch_alg  = es.PitchYinFFT()
        spec_alg   = es.Spectrum()
        win_alg    = es.Windowing(type="hann")
        vals = []
        y32 = y.astype(np.float32)
        for frame in es.FrameGenerator(y32, frameSize=2048, hopSize=1024,
                                       startFromZero=True):
            spec = spec_alg(win_alg(frame))
            pitch, _conf = pitch_alg(spec)
            if pitch <= 0:
                continue
            freqs_p, mags_p = peaks_alg(spec)
            if len(freqs_p) < 2:
                continue
            try:
                h_freqs, h_mags = harm_alg(freqs_p, mags_p, pitch)
            except Exception:
                continue
            if len(h_freqs) < 2:
                continue
            vals.append(float(inh_alg(h_freqs, h_mags)))
        if not vals:
            return None
        return _summary(np.asarray(vals))

    inh = _safe(_inharm, errors, "inharmonicity")
    if inh is not None:
        out["inharmonicity"] = inh

    return out


# ─── TONAL (mirchromagram, mirkey/mirmode, mirtonalcentroid, mirhcdf) ────────

# Krumhansl-Schmuckler key profiles (major / minor), normalised.
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52,
                      5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54,
                      4.75, 3.98, 2.69, 3.34, 3.17])
_PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F",
                "F#", "G", "G#", "A", "A#", "B"]


def _krumhansl_key(chroma_mean):
    """Return (best_key, best_mode, correlation, full_24_corrs)."""
    corrs = []
    for shift in range(12):
        rot = np.roll(chroma_mean, -shift)
        cM = float(np.corrcoef(rot, _KS_MAJOR)[0, 1])
        cm = float(np.corrcoef(rot, _KS_MINOR)[0, 1])
        corrs.append((shift, "major", cM))
        corrs.append((shift, "minor", cm))
    corrs.sort(key=lambda t: t[2], reverse=True)
    shift, mode, c = corrs[0]
    return _PITCH_NAMES[shift], mode, c, corrs


def _tonal_centroid(chroma):
    """Harte et al. 2006: 12-bin chroma → 6-D tonal centroid trajectory."""
    # Reference projection matrix Φ as in the original paper.
    pi = math.pi
    phi = np.zeros((6, 12))
    for n in range(12):
        phi[0, n] = math.sin(n * 7 * pi / 6)        # fifths circle x
        phi[1, n] = math.cos(n * 7 * pi / 6)        # fifths circle y
        phi[2, n] = math.sin(n * 3 * pi / 2)        # minor-thirds x
        phi[3, n] = math.cos(n * 3 * pi / 2)        # minor-thirds y
        phi[4, n] = 0.5 * math.sin(n * 2 * pi / 3)  # major-thirds x
        phi[5, n] = 0.5 * math.cos(n * 2 * pi / 3)  # major-thirds y
    norms = np.sum(chroma, axis=0, keepdims=True) + 1e-12
    return phi @ (chroma / norms)


def _feat_tonal(y, sr, errors):
    out: dict = {}
    if not _LIBROSA_OK:
        return out

    # Use CQT-based chroma if possible — better for tonal analysis than STFT chroma.
    chroma = _safe(
        lambda: librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP),
        errors, "chroma")
    if chroma is None:
        return out

    chroma_mean = np.mean(chroma, axis=1)
    out["chroma_mean"] = [_f(x) for x in chroma_mean]

    # Krumhansl key estimation.
    def _key():
        name, mode, corr, all_corrs = _krumhansl_key(chroma_mean)
        # mirkeystrength returns the full 24-value correlation vector.
        # Order: C-major, C#-major, ..., B-major, C-minor, ..., B-minor.
        majors = [c for (s, m, c) in sorted(all_corrs) if m == "major"]
        minors = [c for (s, m, c) in sorted(all_corrs) if m == "minor"]
        # Clarity = best minus second-best (used by MIRtoolbox).
        top2 = sorted([c for _, _, c in all_corrs], reverse=True)[:2]
        clarity = top2[0] - top2[1] if len(top2) == 2 else 0.0
        return {
            "key":          name,
            "mode":         mode,
            "correlation":  _f(corr),
            "clarity":      _f(clarity),
            "strength":     {"major": [_f(c) for c in majors],
                             "minor": [_f(c) for c in minors]},
        }
    key_info = _safe(_key, errors, "key")
    if key_info:
        out.update(key_info)

    # Tonal centroid trajectory + HCDF.
    def _hcdf():
        tc = _tonal_centroid(chroma)        # shape (6, T)
        # HCDF = euclidean norm of the centroid derivative.
        deltas = np.diff(tc, axis=1)
        flux = np.sqrt(np.sum(deltas ** 2, axis=0))
        # Mean & peak rate (peaks/sec) — useful summary for boundary work.
        hop_dur = HOP / sr
        if _SCIPY_OK and len(flux) > 5:
            # Adaptive threshold = mean + 1 std; min peak distance ~0.5 s.
            min_dist = max(1, int(0.5 / hop_dur))
            peaks, _ = scisig.find_peaks(
                flux, height=float(np.mean(flux) + np.std(flux)),
                distance=min_dist)
            peak_times = (peaks * hop_dur).tolist()
        else:
            peak_times = []
        return {
            "hcdf_mean":      _f(np.mean(flux)),
            "hcdf_std":       _f(np.std(flux)),
            "hcdf_peak_rate": _f(len(peak_times) / (len(flux) * hop_dur + 1e-9)),
            "hcdf_peak_times": [_f(t) for t in peak_times[:200]],   # cap for cache size
            "tonal_centroid_range": [_f(np.min(tc)), _f(np.max(tc))],
        }

    hcdf = _safe(_hcdf, errors, "hcdf")
    if hcdf:
        out.update(hcdf)

    return out


# ─── RHYTHM (mirtempo, mironsets, mirpulseclarity, mireventdensity, ...) ─────

def _feat_rhythm(y, sr, errors):
    out: dict = {}
    if not _LIBROSA_OK:
        return out

    onset_env = _safe(
        lambda: librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP),
        errors, "onset_env")

    # Tempo + beat times.
    def _tempo():
        tempo, beats = librosa.beat.beat_track(
            y=y, sr=sr, hop_length=HOP, onset_envelope=onset_env)
        beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=HOP).tolist()
        return _f(tempo), beat_times
    tempo_result = _safe(_tempo, errors, "tempo")
    if tempo_result is not None:
        out["tempo_bpm"], out["beat_times"] = tempo_result

    # Onsets + event density.
    def _onsets():
        frames = librosa.onset.onset_detect(
            onset_envelope=onset_env, sr=sr, hop_length=HOP, units="frames")
        times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP)
        return times.tolist()
    onset_times = _safe(_onsets, errors, "onsets")
    if onset_times is not None:
        out["onset_times"]   = onset_times
        out["onset_count"]   = len(onset_times)
        out["event_density"] = _f(len(onset_times) / (len(y) / sr + 1e-9))

    # Pulse clarity (mirpulseclarity): autocorrelation peak / autocorr at lag 0.
    def _pulse_clarity():
        if onset_env is None or len(onset_env) < 32:
            return None
        ac = librosa.autocorrelate(onset_env, max_size=onset_env.size // 2)
        if len(ac) < 4 or ac[0] <= 0:
            return None
        # Ignore zero-lag; peak in the lag region of plausible tempos (~40–200 bpm).
        hop_dur   = HOP / sr
        lag_min   = max(1, int(60.0 / 200.0 / hop_dur))
        lag_max   = min(len(ac) - 1, int(60.0 / 40.0 / hop_dur))
        if lag_max <= lag_min:
            return None
        slice_ = ac[lag_min:lag_max]
        return _f(float(np.max(slice_)) / float(ac[0]))
    pulse = _safe(_pulse_clarity, errors, "pulse_clarity")
    if pulse is not None:
        out["pulse_clarity"] = pulse

    # Beat spectrum (Foote 2001) — autocorrelation of the SSM-row diagonals.
    # Cheap proxy: autocorr of the onset envelope, summarised.
    def _beat_spectrum():
        if onset_env is None or len(onset_env) < 32:
            return None
        ac = librosa.autocorrelate(onset_env, max_size=min(onset_env.size, 1024))
        if len(ac) < 4 or ac[0] <= 0:
            return None
        ac = ac / ac[0]
        # Strongest periodicities (skip zero-lag).
        return {"summary": _summary(ac[1:]),
                "first_peak_lag": _f(int(np.argmax(ac[1:])) + 1)}
    bspec = _safe(_beat_spectrum, errors, "beat_spectrum")
    if bspec is not None:
        out["beat_spectrum"] = bspec

    # Fluctuation pattern (Pampalk) — modulation spectrum across mel bands.
    def _fluctuation():
        mel = librosa.feature.melspectrogram(y=y, sr=sr, hop_length=HOP, n_mels=40)
        mel_db = librosa.power_to_db(mel)
        # Modulation spectrum: FFT along time for each band.
        mod = np.abs(np.fft.rfft(mel_db - mel_db.mean(axis=1, keepdims=True),
                                 axis=1))
        # Frequency axis of the modulation spectrum (in Hz).
        hop_dur = HOP / sr
        mod_freqs = np.fft.rfftfreq(mel_db.shape[1], d=hop_dur)
        agg = mod.mean(axis=0)
        # Restrict to 0–10 Hz fluctuations (covers up to ~600 bpm).
        mask = mod_freqs <= 10.0
        if not np.any(mask):
            return None
        idx_max = int(np.argmax(agg[mask]))
        return {"peak_hz":    _f(mod_freqs[mask][idx_max]),
                "peak_power": _f(agg[mask][idx_max]),
                "mean_power": _f(np.mean(agg[mask]))}
    fluct = _safe(_fluctuation, errors, "fluctuation")
    if fluct is not None:
        out["fluctuation"] = fluct

    return out


# ─── STRUCTURE (mirsimatrix, mirnovelty, mirsegment) ─────────────────────────

def _feat_structure(y, sr, errors):
    out: dict = {}
    if not _LIBROSA_OK:
        return out

    # Self-similarity matrix on chroma + MFCC stack (richer than chroma alone).
    def _ssm():
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
        mfcc   = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP, n_mfcc=13)
        # Smooth + downsample for tractable matrix size (~250 frames).
        T = chroma.shape[1]
        ds = max(1, T // 250)
        chroma_d = librosa.util.sync(chroma, range(0, T, ds), aggregate=np.mean)
        mfcc_d   = librosa.util.sync(mfcc,   range(0, T, ds), aggregate=np.mean)
        feats = np.vstack([
            librosa.util.normalize(chroma_d, axis=0),
            librosa.util.normalize(mfcc_d,   axis=0),
        ])
        # Cosine similarity → SSM in [-1, 1].
        feats_n = feats / (np.linalg.norm(feats, axis=0, keepdims=True) + 1e-9)
        ssm = feats_n.T @ feats_n
        hop_dur = HOP / sr * ds
        return ssm, hop_dur

    ssm_result = _safe(_ssm, errors, "ssm")
    if ssm_result is None:
        return out
    ssm, eff_hop = ssm_result
    # Compactness: how diagonal the SSM is, i.e. how repetitive the piece.
    diag_mean = float(np.mean(np.diag(ssm)))
    off_mean  = float(np.mean(ssm - np.diag(np.diag(ssm))))
    out["ssm_compactness"] = _f(diag_mean - off_mean)
    out["ssm_size"]        = int(ssm.shape[0])

    # Foote checkerboard novelty.
    def _novelty(L=32):
        K = np.zeros((L, L))
        half = L // 2
        K[:half, :half] = 1
        K[half:, half:] = 1
        K[:half, half:] = -1
        K[half:, :half] = -1
        K *= np.outer(np.hanning(L), np.hanning(L))
        nov = np.zeros(ssm.shape[0])
        for i in range(half, ssm.shape[0] - half):
            patch = ssm[i - half:i + half, i - half:i + half]
            nov[i] = float(np.sum(patch * K))
        # Normalise to [0, 1].
        if nov.max() > nov.min():
            nov = (nov - nov.min()) / (nov.max() - nov.min())
        return nov

    nov = _safe(_novelty, errors, "novelty")
    if nov is None:
        return out
    out["novelty_summary"] = _summary(nov)

    # Peak picking → segment boundaries.
    def _boundaries():
        if not _SCIPY_OK:
            return []
        min_dist = max(1, int(8.0 / eff_hop))  # ≥ 8 s between boundaries
        peaks, _ = scisig.find_peaks(nov, distance=min_dist,
                                     height=float(np.mean(nov) + 0.5 * np.std(nov)))
        # Convert frame indices → seconds.
        return [(0.0 if p == 0 else _f(p * eff_hop)) for p in peaks]

    bounds = _safe(_boundaries, errors, "segment_boundaries")
    if bounds is not None:
        # Always include 0 and duration as the outer boundaries.
        duration = len(y) / sr
        full = sorted({0.0, *bounds, _f(duration)})
        out["segment_boundaries_sec"] = full
        out["segment_count"]          = max(0, len(full) - 1)

    return out


# ─── EXPERIMENTAL feature surfaces (read sidecar caches) ─────────────────────


def _jdcnet_pitch_feature(slug: str) -> dict | None:
    """Surface JDCNet's 722-class voiced-pitch contour as an `mir_server`
    feature so custom detectors can read `ctx.features["jdcnet_pitch"]`.

    The contour is produced by the SPAN sidecar (span_server.py + jdcnet_torch.py)
    and persisted to ``data/algorithm-outputs/span/<slug>/jdcnet-voicing.pitch.json``
    as ``{frame_sec, hz: [hz_per_frame]}`` — class 0 frames decode to 0 Hz
    (non-voice). The shape is deliberately stable across reads so downstream
    consumers don't have to re-decode the 722-bin softmax.

    Returns the same dict augmented with summary stats (count, voiced ratio,
    min/max/median voiced Hz), or None when the sidecar hasn't been run yet.
    """
    pitch_path = SPAN_OUTPUTS_DIR / slug / "jdcnet-voicing.pitch.json"
    if not pitch_path.exists():
        return None
    try:
        raw = json.loads(pitch_path.read_text())
    except Exception:
        return None
    hz = raw.get("hz")
    frame_sec = raw.get("frame_sec")
    if not isinstance(hz, list) or not isinstance(frame_sec, (int, float)):
        return None
    if _NUMPY_OK and hz:
        arr = np.asarray(hz, dtype=float)
        voiced = arr[arr > 0]
        summary: dict = {
            "frames":       int(arr.size),
            "voiced_ratio": _f(voiced.size / max(arr.size, 1)),
        }
        if voiced.size > 0:
            summary["voiced_hz"] = {
                "min":    _f(np.min(voiced)),
                "max":    _f(np.max(voiced)),
                "median": _f(np.median(voiced)),
            }
    else:
        voiced_count = sum(1 for v in hz if v > 0)
        summary = {
            "frames":       len(hz),
            "voiced_ratio": _f(voiced_count / max(len(hz), 1)),
        }
    return {
        "frame_sec": float(frame_sec),
        "hz":        hz,
        "summary":   summary,
    }


# ─── HIGH-LEVEL (essentia-only) ──────────────────────────────────────────────

def _feat_highlevel(audio_path: Path, y, sr, errors):
    """Features that need a heavier engine. LUFS uses pyloudnorm (pure
    Python, always available in the default image). danceability /
    dynamic_complexity / inharmonicity / alt key+tempo only run when
    essentia is installed locally — not in the default docker image."""
    out: dict = {}

    # LUFS (EBU R128, BS.1770) via pyloudnorm — pure Python, runs everywhere.
    def _loudness_pyln():
        if not _PYLOUDNORM_OK:
            return None
        meter = pyloudnorm.Meter(sr)  # BS.1770 K-weighted, 400 ms blocks
        return _f(meter.integrated_loudness(y.astype(float)))
    lufs = _safe(_loudness_pyln, errors, "loudness_lufs")
    if lufs is not None:
        out["loudness_lufs"] = lufs

    if not _ESSENTIA_OK:
        return out

    y32 = y.astype(np.float32) if y is not None else None

    def _dance():
        # Essentia's Danceability needs the un-resampled mono signal.
        loader = es.MonoLoader(filename=str(audio_path), sampleRate=sr)
        sig    = loader()
        score, _ = es.Danceability()(sig)
        return _f(score)
    d = _safe(_dance, errors, "danceability")
    if d is not None:
        out["danceability"] = d

    def _dyn_complexity():
        loader = es.MonoLoader(filename=str(audio_path), sampleRate=sr)
        sig    = loader()
        dc, _loudness = es.DynamicComplexity()(sig)
        return _f(dc)
    dc = _safe(_dyn_complexity, errors, "dynamic_complexity")
    if dc is not None:
        out["dynamic_complexity"] = dc

    def _bpm_es():
        loader = es.MonoLoader(filename=str(audio_path), sampleRate=sr)
        sig    = loader()
        bpm, beats, _, _, _ = es.RhythmExtractor2013(method="multifeature")(sig)
        return {"bpm": _f(bpm), "beat_count": int(len(beats))}
    bpm_es = _safe(_bpm_es, errors, "bpm_essentia")
    if bpm_es is not None:
        out["bpm_essentia"] = bpm_es

    def _key_es():
        loader = es.MonoLoader(filename=str(audio_path), sampleRate=sr)
        sig    = loader()
        key, scale, strength = es.KeyExtractor()(sig)
        return {"key": str(key), "scale": str(scale), "strength": _f(strength)}
    key_es = _safe(_key_es, errors, "key_essentia")
    if key_es is not None:
        out["key_essentia"] = key_es

    return out


# ─── Orchestration ───────────────────────────────────────────────────────────

_SECTIONS = {
    "dynamics":  _feat_dynamics,
    "spectral":  _feat_spectral,
    "timbre":    _feat_timbre,
    "tonal":     _feat_tonal,
    "rhythm":    _feat_rhythm,
    "structure": _feat_structure,
}


def extract(slug: str, force: bool = False,
            sections: list[str] | None = None) -> dict:
    """Run every feature section for `slug` and cache the result."""
    cache_path = CACHE_DIR / f"{slug}.json"
    if cache_path.exists() and not force and not sections:
        return json.loads(cache_path.read_text())

    if not _LIBROSA_OK:
        raise RuntimeError("librosa is required but not installed")

    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    y, sr = librosa.load(str(audio_path), sr=SR, mono=True)
    duration = len(y) / sr

    errors: list[dict] = []
    features: dict = {}
    todo = list(_SECTIONS.items()) if not sections else [
        (k, v) for k, v in _SECTIONS.items() if k in sections
    ]
    for name, fn in todo:
        features[name] = fn(y, sr, errors)

    if not sections or "highlevel" in (sections or []):
        features["highlevel"] = _feat_highlevel(audio_path, y, sr, errors)

    # Experimental: surface JDCNet's pitch contour (computed by the SPAN
    # sidecar) under features.tonal["jdcnet_pitch"] when its sidecar JSON
    # is present on disk. Skips silently when the sidecar hasn't run.
    if not sections or "tonal" in (sections or []):
        jdc = _safe(lambda: _jdcnet_pitch_feature(slug), errors, "jdcnet_pitch")
        if jdc is not None:
            tonal = features.setdefault("tonal", {})
            tonal["jdcnet_pitch"] = jdc

    result = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    _f(duration),
        "sample_rate": SR,
        "hop_length":  HOP,
        "engines":     {"librosa":    _LIBROSA_OK,
                        "scipy":      _SCIPY_OK,
                        "pyloudnorm": _PYLOUDNORM_OK,
                        "essentia":   _ESSENTIA_OK},
        "features":    features,
        "errors":      errors,
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    if not sections:  # only cache full extractions
        try:
            cache_path.write_text(json.dumps(result, indent=2))
        except Exception:
            pass
    return result


# ─── HTTP handler ────────────────────────────────────────────────────────────

def _cors():
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


# ─── Route handlers ──────────────────────────────────────────────────────────
# Shared by the standalone server below and the consolidated dsp_server.py.
# Each returns (status_code, body) or None when the path isn't a mir route.

def handle_get(full_path: str):
    path = full_path.split("?")[0]
    if path == "/api/mir/health":
        return 200, {
            "ok":            _LIBROSA_OK,
            "librosaOk":     _LIBROSA_OK,
            "scipyOk":       _SCIPY_OK,
            "pyloudnormOk":  _PYLOUDNORM_OK,
            "essentiaOk":    _ESSENTIA_OK,
            "sections":      list(_SECTIONS.keys()) + ["highlevel"],
        }
    if path.startswith("/api/mir/features/"):
        slug = path[len("/api/mir/features/"):]
        cache_path = CACHE_DIR / f"{slug}.json"
        if cache_path.exists():
            return 200, json.loads(cache_path.read_text())
        return 200, None
    return None


def handle_post(full_path: str, body: dict):
    path = full_path.split("?")[0]
    if path == "/api/mir/extract":
        slug     = safe_segment(str(body.get("slug", "")).strip())
        force    = bool(body.get("force", False))
        sections = body.get("sections") or None
        if not slug:
            return 400, {"error": "invalid or missing slug"}
        try:
            return 200, extract(slug, force=force, sections=sections)
        except FileNotFoundError as e:
            return 404, {"error": str(e)}
        except Exception as e:
            return 500, {"error": f"extraction failed: {type(e).__name__}: {e}"}
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        self._send(*(handle_get(self.path) or (404, {"error": "not found"})))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"}); return
        self._send(*(handle_post(self.path, body) or (404, {"error": "not found"})))


# ─── Entrypoint ──────────────────────────────────────────────────────────────

def _serve():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting MIR server on http://{host}:{PORT}", file=sys.stderr)
    print(
        f"  librosa={_LIBROSA_OK}  scipy={_SCIPY_OK}  "
        f"pyloudnorm={_PYLOUDNORM_OK}  essentia={_ESSENTIA_OK}",
        file=sys.stderr,
    )
    HTTPServer((host, PORT), Handler).serve_forever()


def _cli(argv: list[str]):
    if "--all" in argv:
        for slug in list_song_slugs():
            print(f"[mir] {slug} …", file=sys.stderr)
            try:
                extract(slug, force=True)
            except Exception as e:
                print(f"[mir]   FAILED: {type(e).__name__}: {e}", file=sys.stderr)
        return
    slug = argv[0]
    result = extract(slug, force=True)
    json.dump(result, sys.stdout, indent=2)


def main():
    argv = sys.argv[1:]
    if argv and not argv[0].startswith("-"):
        _cli(argv); return
    if "--all" in argv:
        _cli(argv); return
    try:
        _serve()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
