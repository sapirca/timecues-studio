"""
LOL v04 Buildup Detector.

Detects tension-building sections leading to drops or transitions.
"""

import numpy as np
from scipy.ndimage import uniform_filter1d
from dataclasses import dataclass

from ..shared.models import AudioData, AudioFeatures, BuildupSection


@dataclass
class BuildupDetectorResult:
    """Output from buildup detector."""
    buildups: list[BuildupSection]
    primary_buildup: BuildupSection | None
    buildup_count: int
    interpretation: str


class BuildupDetector:
    """Detect tension-building sections."""

    def __init__(self, min_duration_ms: int = 4000, min_tension_delta: float = 0.2):
        """Args:
            min_duration_ms: Minimum buildup duration.
            min_tension_delta: Minimum tension increase required.
        """
        self.min_duration_ms = min_duration_ms
        self.min_tension_delta = min_tension_delta

    def analyze(
        self,
        audio: AudioData,
        features: AudioFeatures,
        energy_curve: np.ndarray,
        tension_curve: np.ndarray
    ) -> BuildupDetectorResult:
        """Detect buildup sections.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.
            energy_curve: Pre-computed energy curve.
            tension_curve: Pre-computed tension curve.

        Returns:
            BuildupDetectorResult with detected buildups.
        """
        buildups = []

        smooth_tension = uniform_filter1d(tension_curve, size=10)
        gradient = np.gradient(smooth_tension)

        min_frames = int(self.min_duration_ms / (features.hop_length * 1000 / features.sr))

        in_buildup = False
        buildup_start = 0
        positive_count = 0
        positive_threshold = 0.001

        for i in range(len(gradient)):
            if gradient[i] > positive_threshold:
                if not in_buildup:
                    buildup_start = i
                    in_buildup = True
                positive_count += 1
            else:
                if in_buildup and positive_count >= min_frames:
                    buildup_section = self._analyze_buildup_region(
                        buildup_start, i,
                        smooth_tension, energy_curve,
                        features, audio
                    )
                    if buildup_section:
                        buildups.append(buildup_section)

                in_buildup = False
                positive_count = 0

        if in_buildup and positive_count >= min_frames:
            buildup_section = self._analyze_buildup_region(
                buildup_start, len(gradient) - 1,
                smooth_tension, energy_curve,
                features, audio
            )
            if buildup_section:
                buildups.append(buildup_section)

        buildups.sort(key=lambda b: b.start_ms)
        primary = max(buildups, key=lambda b: b.tension_peak - b.tension_start) if buildups else None
        interpretation = self._generate_overall_interpretation(buildups, audio.duration_seconds)

        return BuildupDetectorResult(
            buildups=buildups,
            primary_buildup=primary,
            buildup_count=len(buildups),
            interpretation=interpretation,
        )

    def _analyze_buildup_region(
        self,
        start_frame: int,
        end_frame: int,
        tension: np.ndarray,
        energy: np.ndarray,
        features: AudioFeatures,
        audio: AudioData
    ) -> BuildupSection | None:
        """Analyze a potential buildup region."""
        start_ms = int(features.frame_times_ms[start_frame])
        end_ms = int(features.frame_times_ms[min(end_frame, len(features.frame_times_ms) - 1)])
        duration_ms = end_ms - start_ms

        if duration_ms < self.min_duration_ms:
            return None

        tension_start = float(tension[start_frame])
        tension_peak = float(np.max(tension[start_frame:end_frame + 1]))

        if tension_peak - tension_start < self.min_tension_delta:
            return None

        mechanism = self._identify_mechanism(start_frame, end_frame, features, energy)
        resolves_to = self._determine_resolution(end_frame, tension, energy, features)
        interpretation = self._generate_interpretation(
            duration_ms, tension_start, tension_peak, mechanism, resolves_to
        )

        return BuildupSection(
            start_ms=start_ms,
            end_ms=end_ms,
            duration_ms=duration_ms,
            tension_start=round(tension_start, 3),
            tension_peak=round(tension_peak, 3),
            primary_mechanism=mechanism,
            resolves_to=resolves_to,
            interpretation=interpretation,
            priority=8,
        )

    def _identify_mechanism(
        self,
        start_frame: int,
        end_frame: int,
        features: AudioFeatures,
        energy: np.ndarray
    ) -> str:
        """Identify the primary buildup mechanism."""
        section = slice(start_frame, end_frame + 1)

        centroid = features.spectral_centroid[section]
        centroid_slope = np.polyfit(range(len(centroid)), centroid, 1)[0] if len(centroid) > 1 else 0

        bandwidth = features.spectral_bandwidth[section]
        bandwidth_slope = np.polyfit(range(len(bandwidth)), bandwidth, 1)[0] if len(bandwidth) > 1 else 0

        onset = features.onset_env[section]
        onset_slope = np.polyfit(range(len(onset)), onset, 1)[0] if len(onset) > 1 else 0

        energy_section = energy[section]
        energy_slope = np.polyfit(range(len(energy_section)), energy_section, 1)[0] if len(energy_section) > 1 else 0

        mechanisms = {
            "riser": centroid_slope,
            "filter_sweep": -bandwidth_slope,
            "rhythmic_accel": onset_slope,
            "crescendo": energy_slope,
        }

        return max(mechanisms, key=mechanisms.get)

    def _determine_resolution(
        self,
        end_frame: int,
        tension: np.ndarray,
        energy: np.ndarray,
        features: AudioFeatures
    ) -> str:
        """Determine what the buildup resolves to."""
        lookahead = min(50, len(tension) - end_frame - 1)
        if lookahead < 10:
            return "transition"

        post_start = end_frame + 1
        post_end = end_frame + lookahead

        tension_after = np.mean(tension[post_start:post_end])
        energy_after = np.mean(energy[post_start:post_end])
        energy_at_end = energy[end_frame]

        if energy_after > energy_at_end + 0.2:
            return "drop"
        elif energy_after < energy_at_end - 0.1:
            return "breakdown"
        else:
            return "transition"

    def _generate_interpretation(
        self,
        duration_ms: int,
        tension_start: float,
        tension_peak: float,
        mechanism: str,
        resolves_to: str
    ) -> str:
        """Generate semantic interpretation of buildup."""
        duration_sec = duration_ms / 1000

        mechanism_desc = {
            "riser": "pitch riser climbing upward",
            "filter_sweep": "filter narrowing then opening",
            "rhythmic_accel": "rhythm accelerating and intensifying",
            "crescendo": "volume swelling and crescendo",
        }
        resolution_desc = {
            "drop": "exploding into impact drop",
            "breakdown": "collapsing into breakdown",
            "transition": "shifting to next section",
        }

        tension_delta = tension_peak - tension_start
        if tension_delta > 0.5:
            intensity_desc = "Intensely climbing"
        elif tension_delta > 0.3:
            intensity_desc = "Steadily building"
        else:
            intensity_desc = "Gradually rising"

        # Emphasize delta/transition with action verbs
        delta_pct = tension_delta * 100
        return (
            f"{intensity_desc} {duration_sec:.1f}-second buildup via {mechanism_desc.get(mechanism, mechanism)}. "
            f"Tension escalating +{delta_pct:.0f}% (from {tension_start:.0%} → {tension_peak:.0%}), "
            f"then {resolution_desc.get(resolves_to, resolves_to)}."
        )

    def _generate_overall_interpretation(
        self,
        buildups: list[BuildupSection],
        duration_sec: float
    ) -> str:
        """Generate overall interpretation."""
        if not buildups:
            return "No significant buildups detected. Track may have continuous energy or ambient character without traditional tension-release structure."

        total_buildup_time = sum(b.duration_ms for b in buildups) / 1000
        pct_buildup = (total_buildup_time / duration_sec * 100) if duration_sec > 0 else 0

        mechanisms = [b.primary_mechanism for b in buildups]
        dominant = max(set(mechanisms), key=mechanisms.count)

        resolutions = [b.resolves_to for b in buildups]
        drop_count = resolutions.count("drop")

        return (
            f"{len(buildups)} buildup section(s) detected, comprising {pct_buildup:.0f}% of track. "
            f"Primary mechanism: {dominant}. "
            f"{drop_count} resolve to drops, {len(buildups) - drop_count} to other sections. "
            f"Clear tension-release architecture."
        )
