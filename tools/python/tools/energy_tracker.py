"""
LOL v04 Energy Tracker.

Tracks continuous energy curve and identifies significant energy events.
"""

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import find_peaks

from ..shared.models import AudioData, AudioFeatures, EnergyResult, TimeCue


class EnergyTracker:
    """Track energy levels and detect energy events."""

    def __init__(self, sample_interval_ms: int = 100):
        self.sample_interval_ms = sample_interval_ms

    def analyze(
        self,
        audio: AudioData,
        features: AudioFeatures,
        energy_curve: np.ndarray
    ) -> EnergyResult:
        """Analyze energy patterns.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.
            energy_curve: Pre-computed energy curve (from feature_extractor).

        Returns:
            EnergyResult with curve, events, and interpretation.
        """
        resampled_curve = self._resample_curve(
            energy_curve,
            features.frame_times_ms,
            audio.duration_ms,
            self.sample_interval_ms
        )

        average_energy = float(np.mean(resampled_curve))
        peak_energy = float(np.max(resampled_curve))

        events = self._detect_events(energy_curve, features.frame_times_ms)

        interpretation = self._generate_interpretation(
            average_energy, peak_energy, len(events), audio.duration_seconds
        )

        return EnergyResult(
            energy_curve=resampled_curve.tolist(),
            sample_interval_ms=self.sample_interval_ms,
            average_energy=round(average_energy, 3),
            peak_energy=round(peak_energy, 3),
            energy_events=events,
            interpretation=interpretation,
        )

    def _resample_curve(
        self,
        curve: np.ndarray,
        frame_times_ms: np.ndarray,
        duration_ms: int,
        interval_ms: int
    ) -> np.ndarray:
        """Resample curve to fixed time intervals."""
        target_times = np.arange(0, duration_ms, interval_ms)
        resampled = np.interp(target_times, frame_times_ms, curve)
        return resampled

    def _detect_events(
        self,
        energy: np.ndarray,
        frame_times_ms: np.ndarray
    ) -> list[TimeCue]:
        """Detect significant energy events."""
        events = []

        smooth_energy = uniform_filter1d(energy, size=5)
        gradient = np.gradient(smooth_energy)

        spike_threshold = np.percentile(gradient, 95)
        spike_frames, _ = find_peaks(gradient, height=spike_threshold, distance=20)

        for frame in spike_frames:
            if frame < len(frame_times_ms):
                timestamp_ms = int(frame_times_ms[frame])
                intensity = float(energy[frame])

                if intensity > 0.8:
                    spike_type = "energy surge to peak"
                elif intensity > 0.5:
                    spike_type = "significant energy increase"
                else:
                    spike_type = "moderate energy bump"

                events.append(TimeCue(
                    timestamp_ms=timestamp_ms,
                    cue_type="energy_spike",
                    intensity=intensity,
                    interpretation=f"Sudden {spike_type}. Sonic elements multiply or intensify.",
                    priority=5,
                ))

        high_threshold = np.percentile(energy, 75)
        in_high_zone = False
        zone_start = 0

        for i, e in enumerate(energy):
            if e > high_threshold and not in_high_zone:
                in_high_zone = True
                zone_start = i
            elif e <= high_threshold and in_high_zone:
                in_high_zone = False
                zone_duration = i - zone_start
                if zone_duration > 50:
                    timestamp_ms = int(frame_times_ms[zone_start])
                    avg_energy = float(np.mean(energy[zone_start:i]))
                    events.append(TimeCue(
                        timestamp_ms=timestamp_ms,
                        cue_type="high_energy_zone",
                        intensity=avg_energy,
                        interpretation="Sustained high-energy section. Full arrangement active, maximum sonic density.",
                        priority=4,
                    ))

        return sorted(events, key=lambda e: e.timestamp_ms)

    def _generate_interpretation(
        self,
        avg_energy: float,
        peak_energy: float,
        event_count: int,
        duration_sec: float
    ) -> str:
        """Generate semantic interpretation of energy analysis."""
        if avg_energy > 0.7:
            profile = "consistently high-energy"
            feel = "relentless drive, sustained intensity"
        elif avg_energy > 0.5:
            profile = "moderately energetic"
            feel = "balanced dynamics with active sections"
        elif avg_energy > 0.3:
            profile = "dynamic with contrasts"
            feel = "clear distinction between peaks and valleys"
        else:
            profile = "restrained energy"
            feel = "atmospheric, minimal, or ambient sections dominant"

        dynamic_range = peak_energy - avg_energy
        if dynamic_range > 0.4:
            dynamics = "Wide dynamic range with dramatic peaks"
        elif dynamic_range > 0.2:
            dynamics = "Moderate dynamic variation"
        else:
            dynamics = "Compressed dynamics, consistently loud"

        events_per_min = event_count / (duration_sec / 60) if duration_sec > 0 else 0

        return (
            f"Track has {profile} character ({feel}). "
            f"Average energy {avg_energy:.0%}, peak {peak_energy:.0%}. "
            f"{dynamics}. "
            f"{event_count} significant energy events detected ({events_per_min:.1f} per minute)."
        )
