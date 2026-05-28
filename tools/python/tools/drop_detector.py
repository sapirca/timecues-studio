"""
LOL v04 Drop Detector.

Detects exact impact moments (drops) - the climactic release points.
"""

import numpy as np
from scipy.signal import find_peaks
from scipy.ndimage import uniform_filter1d
from dataclasses import dataclass

import librosa

from ..shared.models import AudioData, AudioFeatures, DropEvent


@dataclass
class DropDetectorResult:
    """Output from drop detector."""
    drops: list[DropEvent]
    primary_drop: DropEvent | None
    drop_count: int
    interpretation: str


class DropDetector:
    """Detect impact/drop moments in audio."""

    def __init__(self, min_gap_ms: int = 2500):
        """Args:
            min_gap_ms: Minimum gap between detected drops (lowered to 2500 for finer drop detection).
        """
        self.min_gap_ms = min_gap_ms

    def analyze(
        self,
        audio: AudioData,
        features: AudioFeatures,
        energy_curve: np.ndarray,
        breakdowns: list = None
    ) -> DropDetectorResult:
        """Detect drop moments.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.
            energy_curve: Pre-computed energy curve.

        Returns:
            DropDetectorResult with detected drops.
        """
        drops = []

        smooth_energy = uniform_filter1d(energy_curve, size=5)
        gradient = np.gradient(smooth_energy)

        # Also compute bass gradient for detecting bass-heavy drops
        # Use minimal smoothing (size=2) to preserve sharp transients
        low_freq_energy = self._compute_low_freq_energy(audio, features)
        bass_gradient = np.gradient(uniform_filter1d(low_freq_energy, size=2))

        # Find peaks in overall energy gradient
        energy_threshold = np.percentile(gradient, 75)  # Lowered to 75th percentile for better sensitivity
        energy_peak_frames, _ = find_peaks(
            gradient,
            height=energy_threshold,
            distance=int(self.min_gap_ms / (features.hop_length * 1000 / features.sr))
        )

        # Find peaks in bass gradient (for bass-heavy drops that might have lower overall energy)
        bass_threshold = np.percentile(bass_gradient, 77)  # Lowered to 77th percentile
        bass_peak_frames, _ = find_peaks(
            bass_gradient,
            height=bass_threshold,
            distance=int(self.min_gap_ms / (features.hop_length * 1000 / features.sr))
        )

        # Combine both sets of candidate frames (union)
        peak_frames = np.unique(np.concatenate([energy_peak_frames, bass_peak_frames]))

        for frame in peak_frames:
            timestamp_ms = int(features.frame_times_ms[frame])

            # Relaxed edge filter to 500ms to avoid excluding valid drops near start/end
            if timestamp_ms < 500 or timestamp_ms > audio.duration_ms - 500:
                continue

            # Check if this was detected via bass gradient (bass-heavy drop)
            is_bass_detected = frame in bass_peak_frames

            window_frames = int(2000 / (features.hop_length * 1000 / features.sr))
            start_frame = max(0, frame - window_frames)
            end_frame = min(len(energy_curve), frame + window_frames)

            energy_before = float(np.mean(energy_curve[start_frame:frame]))
            energy_after = float(np.mean(energy_curve[frame:end_frame]))

            # For bass validation, use shorter window to capture transient spikes
            if is_bass_detected:
                short_window_frames = int(500 / (features.hop_length * 1000 / features.sr))  # 500ms window
                bass_start = max(0, frame - short_window_frames)
                bass_end = min(len(low_freq_energy), frame + short_window_frames)
                bass_before = float(np.mean(low_freq_energy[bass_start:frame]))
                # Use PEAK instead of mean to detect transient bass hits
                bass_after = float(np.max(low_freq_energy[frame:bass_end]))
            else:
                bass_before = float(np.mean(low_freq_energy[start_frame:frame]))
                bass_after = float(np.mean(low_freq_energy[frame:end_frame]))

            bass_return = bass_after > bass_before * 1.5

            # Different validation for bass-heavy vs overall energy drops
            if is_bass_detected:
                # For bass drops: require strong bass peak
                if not bass_return or bass_after < 0.25:
                    continue
                # Also require reasonable overall energy to avoid breakdown regions
                # (unless breakdowns are provided for explicit filtering)
                if breakdowns is None and energy_after < 0.3:
                    continue
            else:
                # For overall energy drops: require high energy after and positive delta
                # When breakdowns not provided, use lower threshold to catch more candidates
                min_energy = 0.35 if breakdowns is None else 0.3
                if energy_after < min_energy or energy_after - energy_before < 0.05:
                    continue

            drop_type = self._classify_drop_type(
                energy_before, energy_after, bass_return, features, frame
            )
            pre_drop_type = self._classify_pre_drop(
                energy_curve, low_freq_energy, frame, window_frames
            )
            # Intensity formula: Must correlate with energy INCREASE
            # energy_delta < 0 → intensity < 0.4 (semantic requirement)
            energy_delta = energy_after - energy_before
            if energy_delta < 0:
                # Falling energy → low intensity (clamp to max 0.35)
                intensity = max(0.0, min(0.35, energy_after * 0.5))
            else:
                # Rising energy → scale with delta + absolute level
                intensity = max(0.0, min(1.0, energy_delta * 2.0 + energy_after * 0.5))
            interpretation = self._generate_drop_interpretation(
                drop_type, pre_drop_type, energy_before, energy_after, bass_return
            )

            drops.append(DropEvent(
                timestamp_ms=timestamp_ms,
                intensity=round(intensity, 3),
                drop_type=drop_type,
                pre_drop_type=pre_drop_type,
                energy_before=round(energy_before, 3),
                energy_after=round(energy_after, 3),
                bass_return=bass_return,
                interpretation=interpretation,
                priority=10,
            ))

        # Filter out drops that overlap with breakdown sections
        if breakdowns:
            drops = self._filter_drops_in_breakdowns(drops, breakdowns)

        drops.sort(key=lambda d: d.timestamp_ms)
        primary_drop = max(drops, key=lambda d: d.intensity) if drops else None
        interpretation = self._generate_overall_interpretation(drops, audio.duration_seconds)

        return DropDetectorResult(
            drops=drops,
            primary_drop=primary_drop,
            drop_count=len(drops),
            interpretation=interpretation,
        )

    def _compute_low_freq_energy(
        self,
        audio: AudioData,
        features: AudioFeatures,
        cutoff_hz: int = 200
    ) -> np.ndarray:
        """Compute energy in low frequency band."""
        stft = np.abs(librosa.stft(audio.y, hop_length=features.hop_length))
        freqs = librosa.fft_frequencies(sr=audio.sr)
        low_bins = freqs < cutoff_hz

        low_energy = np.sum(stft[low_bins, :], axis=0)
        if low_energy.max() > 0:
            low_energy = low_energy / low_energy.max()
        return low_energy

    def _filter_drops_in_breakdowns(
        self,
        drops: list,
        breakdowns: list
    ) -> list:
        """Filter out drops that fall within breakdown time ranges.

        Drops and breakdowns are semantically mutually exclusive:
        - Drops = high energy, impact, climax
        - Breakdowns = low energy, calm, breathing room

        Args:
            drops: List of DropEvent objects.
            breakdowns: List of BreakdownSection objects.

        Returns:
            Filtered list with drops outside breakdown ranges.
        """
        filtered = []
        for drop in drops:
            overlaps = any(
                bd.start_ms <= drop.timestamp_ms <= bd.end_ms
                for bd in breakdowns
            )
            if not overlaps:
                filtered.append(drop)
        return filtered

    def _classify_drop_type(
        self,
        energy_before: float,
        energy_after: float,
        bass_return: bool,
        features: AudioFeatures,
        frame: int
    ) -> str:
        """Classify the type of drop."""
        if bass_return and energy_after > 0.7:
            return "bass_return"
        elif energy_after - energy_before > 0.4:
            return "layered"
        elif bass_return:
            return "rhythmic"
        else:
            return "filter_open"

    def _classify_pre_drop(
        self,
        energy: np.ndarray,
        bass: np.ndarray,
        drop_frame: int,
        window_frames: int
    ) -> str:
        """Classify what happens before the drop."""
        start = max(0, drop_frame - window_frames * 2)
        pre_section = energy[start:drop_frame]
        bass_section = bass[start:drop_frame]

        if len(pre_section) < 10:
            return "unknown"

        avg_energy = np.mean(pre_section)
        energy_trend = np.polyfit(range(len(pre_section)), pre_section, 1)[0]
        avg_bass = np.mean(bass_section)

        if avg_energy < 0.2:
            return "silence"
        elif energy_trend > 0.001:
            return "riser"
        elif avg_bass < 0.3 and avg_energy > 0.3:
            return "filter_sweep"
        else:
            return "breakdown"

    def _generate_drop_interpretation(
        self,
        drop_type: str,
        pre_drop_type: str,
        energy_before: float,
        energy_after: float,
        bass_return: bool
    ) -> str:
        """Generate semantic interpretation of individual drop."""
        drop_descriptions = {
            "bass_return": "Massive bass explosion after absence",
            "layered": "Multi-element activation, full arrangement unleashed",
            "rhythmic": "Rhythmic elements multiply, percussion intensifies",
            "filter_open": "Filter opens wide, full spectrum restored",
        }
        pre_descriptions = {
            "silence": "complete silence",
            "riser": "tension riser buildup",
            "filter_sweep": "filter sweep anticipation",
            "breakdown": "sparse breakdown section",
            "unknown": "brief transition",
        }

        drop_desc = drop_descriptions.get(drop_type, "Impact moment")
        pre_desc = pre_descriptions.get(pre_drop_type, "transition")

        contrast = energy_after - energy_before
        if contrast > 0.5:
            contrast_desc = "Maximum sonic contrast"
        elif contrast > 0.3:
            contrast_desc = "Strong impact"
        else:
            contrast_desc = "Moderate transition"

        bass_note = " Bass frequencies slam back in." if bass_return else ""

        return f"{drop_desc} following {pre_desc}. {contrast_desc}.{bass_note}"

    def _generate_overall_interpretation(
        self,
        drops: list[DropEvent],
        duration_sec: float
    ) -> str:
        """Generate overall interpretation of drop analysis."""
        if not drops:
            return "No significant drops detected. Track may be ambient, continuous, or build-based without traditional drops."

        drops_per_min = len(drops) / (duration_sec / 60) if duration_sec > 0 else 0

        if len(drops) == 1:
            structure = "Single-drop structure with one climactic peak"
        elif len(drops) == 2:
            structure = "Two-drop structure, classic build-drop-build-drop format"
        elif len(drops) <= 4:
            structure = f"Multi-drop arrangement with {len(drops)} impact moments"
        else:
            structure = f"Frequent drops ({len(drops)} total), high-energy dance production"

        types = [d.drop_type for d in drops]
        if types.count("bass_return") > len(types) / 2:
            style = "Bass-focused drops dominate, heavy low-end character"
        elif types.count("layered") > len(types) / 2:
            style = "Layered drops with complex multi-element arrangements"
        else:
            style = "Varied drop styles throughout the track"

        avg_intensity = np.mean([d.intensity for d in drops])

        return f"{structure}. {style}. Average drop intensity {avg_intensity:.0%}. {drops_per_min:.1f} drops per minute."
