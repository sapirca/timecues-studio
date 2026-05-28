"""
LOL v04 Section Classifier.

Segments track into structural sections (intro, verse, buildup, drop, breakdown, outro).
"""

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import find_peaks
from dataclasses import dataclass

from ..shared.models import AudioData, AudioFeatures, Section


@dataclass
class SectionClassifierResult:
    """Output from section classifier."""
    sections: list[Section]
    section_count: int
    structure_pattern: str
    interpretation: str


class SectionClassifier:
    """Classify structural sections of a track."""

    def __init__(self, min_section_ms: int = 8000):
        """Args:
            min_section_ms: Minimum section duration.
        """
        self.min_section_ms = min_section_ms

    def analyze(
        self,
        audio: AudioData,
        features: AudioFeatures,
        energy_curve: np.ndarray
    ) -> SectionClassifierResult:
        """Classify structural sections.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.
            energy_curve: Pre-computed energy curve.

        Returns:
            SectionClassifierResult with classified sections.
        """
        boundaries_frames = self._find_boundaries(features, energy_curve)

        boundaries_ms = [int(features.frame_times_ms[f]) for f in boundaries_frames]
        boundaries_ms = [0] + boundaries_ms + [audio.duration_ms]

        sections = []
        for i in range(len(boundaries_ms) - 1):
            start_ms = boundaries_ms[i]
            end_ms = boundaries_ms[i + 1]

            if end_ms - start_ms < self.min_section_ms:
                continue

            section = self._classify_section(
                start_ms, end_ms,
                i, len(boundaries_ms) - 2,
                features, energy_curve, audio
            )
            sections.append(section)

        sections = self._merge_similar_sections(sections)
        pattern = "-".join(s.section_type for s in sections)
        interpretation = self._generate_overall_interpretation(sections, pattern, audio.duration_seconds)

        return SectionClassifierResult(
            sections=sections,
            section_count=len(sections),
            structure_pattern=pattern,
            interpretation=interpretation,
        )

    def _find_boundaries(
        self,
        features: AudioFeatures,
        energy: np.ndarray
    ) -> list[int]:
        """Find section boundaries based on energy and spectral changes."""
        smooth_energy = uniform_filter1d(energy, size=20)
        gradient = np.abs(np.gradient(smooth_energy))

        flux = features.spectral_flux
        flux_norm = flux / flux.max() if flux.max() > 0 else flux
        smooth_flux = uniform_filter1d(flux_norm, size=20)

        change_signal = 0.6 * gradient + 0.4 * smooth_flux

        min_distance = int(self.min_section_ms / (features.hop_length * 1000 / features.sr))
        threshold = np.percentile(change_signal, 90)

        peaks, _ = find_peaks(change_signal, height=threshold, distance=min_distance)
        return peaks.tolist()

    def _classify_section(
        self,
        start_ms: int,
        end_ms: int,
        section_idx: int,
        total_sections: int,
        features: AudioFeatures,
        energy: np.ndarray,
        audio: AudioData
    ) -> Section:
        """Classify a single section."""
        ms_to_frame = features.sr / features.hop_length / 1000
        start_frame = int(start_ms * ms_to_frame)
        end_frame = min(int(end_ms * ms_to_frame), len(energy) - 1)
        section = slice(start_frame, end_frame + 1)

        avg_energy = float(np.mean(energy[section]))
        energy_trend = np.polyfit(range(end_frame - start_frame + 1), energy[section], 1)[0]

        position = start_ms / audio.duration_ms
        is_start = position < 0.1
        is_end = (audio.duration_ms - end_ms) < audio.duration_ms * 0.1

        section_type = self._determine_section_type(
            avg_energy, energy_trend, is_start, is_end, section_idx, total_sections
        )

        if avg_energy > 0.75:
            energy_level = "peak"
        elif avg_energy > 0.5:
            energy_level = "high"
        elif avg_energy > 0.25:
            energy_level = "medium"
        else:
            energy_level = "low"

        interpretation = self._generate_section_interpretation(
            section_type, energy_level, end_ms - start_ms, energy_trend
        )

        return Section(
            start_ms=start_ms,
            end_ms=end_ms,
            section_type=section_type,
            energy_level=energy_level,
            interpretation=interpretation,
            priority=6,
        )

    def _determine_section_type(
        self,
        avg_energy: float,
        energy_trend: float,
        is_start: bool,
        is_end: bool,
        section_idx: int,
        total_sections: int
    ) -> str:
        """Determine section type based on metrics and position.

        High-energy sections (drops) are never intro/outro — this handles radio edits
        that begin immediately with the main drop instead of a low-energy intro.
        For all other energy levels, position wins: first section = intro, last = outro.
        """
        # High energy is a drop regardless of position (radio edits start here)
        if avg_energy > 0.7:
            return "drop"

        # Position takes priority over buildup/breakdown/bridge for first/last sections
        if is_start:
            return "intro"
        if is_end:
            return "outro"

        if avg_energy < 0.35:
            if energy_trend > 0.001:
                return "buildup"
            else:
                return "breakdown"
        elif energy_trend > 0.002:
            return "buildup"
        else:
            return "bridge"

    def _merge_similar_sections(self, sections: list[Section]) -> list[Section]:
        """Merge adjacent sections of the same type."""
        if not sections:
            return sections

        merged = [sections[0]]

        for section in sections[1:]:
            if section.section_type == merged[-1].section_type:
                prev = merged[-1]
                merged[-1] = Section(
                    start_ms=prev.start_ms,
                    end_ms=section.end_ms,
                    section_type=prev.section_type,
                    energy_level=prev.energy_level,
                    interpretation=prev.interpretation,
                    priority=prev.priority,
                )
            else:
                merged.append(section)

        return merged

    def _generate_section_interpretation(
        self,
        section_type: str,
        energy_level: str,
        duration_ms: int,
        energy_trend: float
    ) -> str:
        """Generate interpretation for a section."""
        duration_sec = duration_ms / 1000

        type_desc = {
            "intro": "Opening section establishing mood",
            "bridge": "Mid-energy groove section between drops",
            "buildup": "Tension accumulation toward peak",
            "drop": "Peak energy, full arrangement unleashed",
            "breakdown": "Sparse atmospheric passage",
            "outro": "Closing section, energy dissipating",
        }

        trend_desc = ""
        if energy_trend > 0.002:
            trend_desc = ", energy rising"
        elif energy_trend < -0.002:
            trend_desc = ", energy falling"

        return (
            f"{type_desc.get(section_type, 'Musical section')}. "
            f"{energy_level.capitalize()} energy, {duration_sec:.0f} seconds{trend_desc}."
        )

    def _generate_overall_interpretation(
        self,
        sections: list[Section],
        pattern: str,
        duration_sec: float
    ) -> str:
        """Generate overall interpretation of track structure."""
        if not sections:
            return "Unable to determine clear section structure. Track may be continuous or ambient."

        types = [s.section_type for s in sections]
        drop_count = types.count("drop")
        breakdown_count = types.count("breakdown")
        buildup_count = types.count("buildup")

        if drop_count >= 2 and buildup_count >= 2:
            structure = "Classic EDM structure with multiple build-drop cycles"
        elif drop_count == 1:
            structure = "Single-peak structure building to one main climax"
        elif breakdown_count > drop_count:
            structure = "Atmospheric structure with emphasis on sparse sections"
        else:
            structure = "Flowing structure with gradual transitions"

        return (
            f"{len(sections)} distinct sections identified. "
            f"{structure}. "
            f"Pattern: {pattern}. "
            f"Contains {drop_count} peak section(s), {breakdown_count} breakdown(s), {buildup_count} buildup(s)."
        )
