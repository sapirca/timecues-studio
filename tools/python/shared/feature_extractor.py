"""
LOL v04 Feature Extractor.

Extract all librosa features once and share across tools.
This avoids redundant computation and ensures consistency.
"""

import librosa
import numpy as np
from scipy.ndimage import uniform_filter1d

from .models import AudioData, AudioFeatures


def extract_features(audio: AudioData, hop_length: int = 512) -> AudioFeatures:
    """Extract all audio features needed by analysis tools.

    Args:
        audio: Loaded audio data.
        hop_length: Hop length for STFT (default 512 samples).

    Returns:
        AudioFeatures containing all extracted features.
    """
    y = audio.y
    sr = audio.sr

    # Compute STFT for spectral features
    stft = np.abs(librosa.stft(y, hop_length=hop_length))
    n_frames = stft.shape[1]

    # Frame times in milliseconds
    frame_times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)
    frame_times_ms = (frame_times * 1000).astype(int)

    # === Energy Features ===
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]

    # === Spectral Features ===
    spectral_centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop_length)[0]
    spectral_bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr, hop_length=hop_length)[0]
    spectral_rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, hop_length=hop_length)[0]
    spectral_flatness = librosa.feature.spectral_flatness(y=y, hop_length=hop_length)[0]

    # Spectral flux (rate of spectral change)
    spectral_flux = np.zeros(n_frames)
    spectral_flux[1:] = np.sqrt(np.sum(np.diff(stft, axis=1) ** 2, axis=0))

    # === Harmonic Features ===
    chromagram = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop_length)

    # === Timbral Features ===
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=hop_length, n_mfcc=13)

    # === Rhythm Features ===
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop_length, units='frames')

    # Tempo and beats
    # Get all tempo estimates without aggregation for octave robustness
    tempo_candidates = librosa.feature.tempo(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop_length,
        aggregate=None  # Get all estimates
    )

    # Ensure array
    if not isinstance(tempo_candidates, np.ndarray):
        tempo_candidates = np.array([tempo_candidates])

    # Apply octave correction: For each candidate, consider 0.5x, 1x, 2x, 3x variants
    all_candidates = []
    for t in tempo_candidates:
        all_candidates.extend([t / 3.0, t * 0.5, t, t * 1.5, t * 2.0, t * 3.0])

    # Filter to EDM range [90-180 BPM]
    edm_candidates = [t for t in all_candidates if 90 <= t <= 180]

    # Pick median of EDM-range candidates (robust to outliers)
    if edm_candidates:
        tempo = float(np.median(edm_candidates))
    else:
        # Fallback to relaxed range [60-200]
        relaxed_candidates = [t for t in all_candidates if 60 <= t <= 200]
        tempo = float(np.median(relaxed_candidates)) if relaxed_candidates else 120.0

    # Get beat frames using beat_track with the selected tempo as prior
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop_length,
        start_bpm=tempo,
        tightness=100
    )

    return AudioFeatures(
        rms=rms,
        spectral_centroid=spectral_centroid,
        spectral_bandwidth=spectral_bandwidth,
        spectral_flux=spectral_flux,
        spectral_flatness=spectral_flatness,
        spectral_rolloff=spectral_rolloff,
        chromagram=chromagram,
        mfcc=mfcc,
        onset_env=onset_env,
        onset_frames=onset_frames,
        tempo=tempo,
        beat_frames=beat_frames,
        sr=sr,
        hop_length=hop_length,
        n_frames=n_frames,
        frame_times_ms=frame_times_ms,
    )


def compute_energy_curve(features: AudioFeatures, smooth_frames: int = 40) -> np.ndarray:
    """Compute composite energy curve from multiple features.

    Energy = 40% RMS + 25% bandwidth + 20% onset density + 15% flux

    Args:
        features: Pre-extracted audio features.
        smooth_frames: Smoothing window size (increased to 40 for monotone edge-case robustness).

    Returns:
        Normalized energy curve (0.0-1.0).
    """
    rms_norm = _normalize(features.rms)
    bandwidth_norm = _normalize(features.spectral_bandwidth)
    onset_norm = _normalize(features.onset_env)
    flux_norm = _normalize(features.spectral_flux)

    energy = (
        0.40 * rms_norm +
        0.25 * bandwidth_norm +
        0.20 * onset_norm +
        0.15 * flux_norm
    )

    if smooth_frames > 1:
        energy = uniform_filter1d(energy, size=smooth_frames)

    # Check if signal is near-constant (e.g., monotone edge-case)
    # If variance is very low, skip final normalization to avoid amplifying noise
    if np.std(energy) < 0.05:
        # Already normalized components, just clamp to [0,1]
        return np.clip(energy, 0.0, 1.0)
    else:
        return _normalize(energy)


def compute_tension_curve(
    features: AudioFeatures,
    energy_curve: np.ndarray,
    smooth_frames: int = 20
) -> np.ndarray:
    """Compute tension curve INDEPENDENT of energy.

    Tension indicators:
    - Rising spectral centroid (pitch trending up)
    - Narrowing bandwidth (filter sweep closing)
    - Chromagram entropy (harmonic instability)
    - Activity vs volume divergence

    Args:
        features: Pre-extracted audio features.
        energy_curve: Pre-computed energy curve.
        smooth_frames: Smoothing window size.

    Returns:
        Normalized tension curve (0.0-1.0).
    """
    n_frames = features.n_frames

    # 1. Spectral centroid slope (rising = tension)
    centroid_norm = _normalize(features.spectral_centroid)
    centroid_slope = np.gradient(centroid_norm)
    centroid_slope_pos = np.maximum(centroid_slope, 0)

    # 2. Bandwidth narrowing (closing filter = tension)
    bandwidth_norm = _normalize(features.spectral_bandwidth)
    bandwidth_slope = np.gradient(bandwidth_norm)
    bandwidth_narrow = np.maximum(-bandwidth_slope, 0)

    # 3. Chromagram entropy (harmonic instability)
    chroma_entropy = np.zeros(n_frames)
    for i in range(n_frames):
        chroma_frame = features.chromagram[:, i]
        chroma_frame = chroma_frame / (chroma_frame.sum() + 1e-10)
        entropy = -np.sum(chroma_frame * np.log2(chroma_frame + 1e-10))
        chroma_entropy[i] = entropy
    chroma_entropy_norm = _normalize(chroma_entropy)

    # 4. Activity vs volume divergence (high activity + low volume = tension)
    activity = _normalize(features.onset_env)
    volume = _normalize(features.rms)
    activity_volume_gap = np.maximum(activity - volume, 0)

    # Combine tension indicators
    tension = (
        0.30 * _normalize(centroid_slope_pos) +
        0.25 * _normalize(bandwidth_narrow) +
        0.25 * chroma_entropy_norm +
        0.20 * activity_volume_gap
    )

    if smooth_frames > 1:
        tension = uniform_filter1d(tension, size=smooth_frames)

    return _normalize(tension)


def _normalize(arr: np.ndarray) -> np.ndarray:
    """Normalize array to 0-1 range."""
    min_val = arr.min()
    max_val = arr.max()
    if max_val - min_val < 1e-10:
        return np.zeros_like(arr)
    return (arr - min_val) / (max_val - min_val)
