"""
LOL v04 Breakdown Detector.

Detects sparse/atmospheric sections - the "breathing room" moments.
"""

import numpy as np
from scipy.ndimage import uniform_filter1d
from dataclasses import dataclass

from ..shared.models import AudioData, AudioFeatures, BreakdownSection


@dataclass
class BreakdownDetectorResult:
    """Output from breakdown detector."""
    breakdowns: list[BreakdownSection]
    breakdown_count: int
    total_breakdown_time_ms: int
    interpretation: str


class BreakdownDetector:
    """Detect sparse/atmospheric breakdown sections."""

    def __init__(self, min_duration_ms: int = 4000, energy_threshold: float = 0.4):
        """Args:
            min_duration_ms: Minimum breakdown duration.
            energy_threshold: Energy level below which is considered sparse.
        """
        self.min_duration_ms = min_duration_ms
        self.energy_threshold = energy_threshold

    @staticmethod
    def _map_energy_to_category(energy: float) -> str:
        """Map numeric energy (0.0-1.0) to categorical string.

        Args:
            energy: Numeric energy level.

        Returns:
            Category: "very_low", "low", "medium", or "high".
        """
        if energy < 0.3:
            return "very_low"
        elif energy < 0.5:
            return "low"
        elif energy < 0.7:
            return "medium"
        else:
            return "high"

    def analyze(
        self,
        audio: AudioData,
        features: AudioFeatures,
        energy_curve: np.ndarray
    ) -> BreakdownDetectorResult:
        """Detect breakdown sections.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.
            energy_curve: Pre-computed energy curve.

        Returns:
            BreakdownDetectorResult with detected breakdowns.
        """
        breakdowns = []

        smooth_energy = uniform_filter1d(energy_curve, size=10)
        hollowness = self._compute_hollowness(features)

        min_frames = int(self.min_duration_ms / (features.hop_length * 1000 / features.sr))

        in_breakdown = False
        breakdown_start = 0
        low_count = 0

        for i in range(len(smooth_energy)):
            is_low = smooth_energy[i] < self.energy_threshold

            if is_low:
                if not in_breakdown:
                    breakdown_start = i
                    in_breakdown = True
                low_count += 1
            else:
                if in_breakdown and low_count >= min_frames:
                    breakdown_section = self._analyze_breakdown_region(
                        breakdown_start, i,
                        smooth_energy, hollowness,
                        features, audio
                    )
                    if breakdown_section:
                        breakdowns.append(breakdown_section)

                in_breakdown = False
                low_count = 0

        if in_breakdown and low_count >= min_frames:
            breakdown_section = self._analyze_breakdown_region(
                breakdown_start, len(smooth_energy) - 1,
                smooth_energy, hollowness,
                features, audio
            )
            if breakdown_section:
                breakdowns.append(breakdown_section)

        breakdowns.sort(key=lambda b: b.start_ms)
        total_time_ms = sum(b.duration_ms for b in breakdowns)
        interpretation = self._generate_overall_interpretation(
            breakdowns, total_time_ms, audio.duration_ms
        )

        return BreakdownDetectorResult(
            breakdowns=breakdowns,
            breakdown_count=len(breakdowns),
            total_breakdown_time_ms=total_time_ms,
            interpretation=interpretation,
        )

    def _compute_hollowness(self, features: AudioFeatures) -> np.ndarray:
        """Compute hollowness (spectral sparsity).

        Hollowness = low spectral flatness + low bandwidth + low onset density.
        """
        flatness = features.spectral_flatness
        flatness_norm = flatness / flatness.max() if flatness.max() > 0 else flatness

        bandwidth = features.spectral_bandwidth
        bandwidth_norm = bandwidth / bandwidth.max() if bandwidth.max() > 0 else bandwidth

        onset = features.onset_env
        onset_norm = onset / onset.max() if onset.max() > 0 else onset

        fullness = 0.4 * bandwidth_norm + 0.3 * onset_norm + 0.3 * (1 - flatness_norm)
        hollowness = 1 - fullness

        hollowness = uniform_filter1d(hollowness, size=10)
        return hollowness

    def _analyze_breakdown_region(
        self,
        start_frame: int,
        end_frame: int,
        energy: np.ndarray,
        hollowness: np.ndarray,
        features: AudioFeatures,
        audio: AudioData
    ) -> BreakdownSection | None:
        """Analyze a potential breakdown region."""
        start_ms = int(features.frame_times_ms[start_frame])
        end_ms = int(features.frame_times_ms[min(end_frame, len(features.frame_times_ms) - 1)])
        duration_ms = end_ms - start_ms

        if duration_ms < self.min_duration_ms:
            return None

        section = slice(start_frame, end_frame + 1)
        avg_hollowness = float(np.mean(hollowness[section]))
        avg_energy = float(np.mean(energy[section]))

        emotional_quality = self._classify_emotional_quality(
            section, features, avg_energy, avg_hollowness
        )
        interpretation = self._generate_interpretation(
            duration_ms, avg_hollowness, avg_energy, emotional_quality
        )

        return BreakdownSection(
            start_ms=start_ms,
            end_ms=end_ms,
            duration_ms=duration_ms,
            hollowness=round(avg_hollowness, 3),
            energy_level=self._map_energy_to_category(avg_energy),
            emotional_quality=emotional_quality,
            interpretation=interpretation,
            priority=7,
        )

    def _classify_emotional_quality(
        self,
        section: slice,
        features: AudioFeatures,
        energy: float,
        hollowness: float
    ) -> str:
        """Classify the emotional quality of the breakdown."""
        centroid = np.mean(features.spectral_centroid[section])
        centroid_normalized = centroid / (features.sr / 2)

        chroma = features.chromagram[:, section]
        chroma_variation = np.std(chroma)

        if hollowness > 0.7 and energy < 0.2:
            return "ethereal"
        elif centroid_normalized < 0.3 and chroma_variation < 0.1:
            return "melancholic"
        elif hollowness > 0.5 and chroma_variation > 0.15:
            return "suspenseful"
        else:
            return "peaceful"

    def _generate_interpretation(
        self,
        duration_ms: int,
        hollowness: float,
        energy: float,
        emotional_quality: str
    ) -> str:
        """Generate semantic interpretation of breakdown."""
        duration_sec = duration_ms / 1000

        quality_desc = {
            "ethereal": "Ethereal void with floating, ambient textures",
            "melancholic": "Melancholic atmosphere, sparse and introspective",
            "suspenseful": "Suspenseful breathing room, anticipation without resolution",
            "peaceful": "Peaceful reduction, stripped arrangement providing rest",
        }

        if hollowness > 0.7:
            density = "Very sparse"
        elif hollowness > 0.5:
            density = "Sparse"
        else:
            density = "Moderately reduced"

        return (
            f"{density} {duration_sec:.1f}-second breakdown. "
            f"{quality_desc.get(emotional_quality, 'Atmospheric section')}. "
            f"Energy at {energy:.0%}, hollowness {hollowness:.0%}."
        )

    def _generate_overall_interpretation(
        self,
        breakdowns: list[BreakdownSection],
        total_time_ms: int,
        duration_ms: int
    ) -> str:
        """Generate overall interpretation."""
        if not breakdowns:
            return "No significant breakdowns detected. Track maintains consistent density throughout, possibly continuous high-energy production."

        pct_breakdown = (total_time_ms / duration_ms * 100) if duration_ms > 0 else 0

        qualities = [b.emotional_quality for b in breakdowns]
        dominant_quality = max(set(qualities), key=qualities.count)

        avg_hollowness = np.mean([b.hollowness for b in breakdowns])

        return (
            f"{len(breakdowns)} breakdown section(s) detected, comprising {pct_breakdown:.0f}% of track. "
            f"Dominant character: {dominant_quality}. "
            f"Average hollowness {avg_hollowness:.0%}. "
            f"Track uses sparse sections for contrast and breathing room."
        )
