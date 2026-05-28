"""
LOL v04 Tempo Analyzer.

Detects BPM, beat grid, and tempo stability for synchronization.
"""

import numpy as np

from ..shared.models import AudioData, AudioFeatures, TempoResult


class TempoAnalyzer:
    """Analyze tempo and beat grid."""

    def analyze(self, audio: AudioData, features: AudioFeatures) -> TempoResult:
        """Analyze tempo and beat structure.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.

        Returns:
            TempoResult with BPM, beats, and interpretation.
        """
        bpm = features.tempo
        beat_frames = features.beat_frames

        beat_times_ms = [
            int(f * features.hop_length * 1000 / features.sr)
            for f in beat_frames
        ]

        if len(beat_times_ms) > 2:
            intervals = np.diff(beat_times_ms)
            expected_interval = 60000 / bpm
            deviation = np.std(intervals) / expected_interval if expected_interval > 0 else 1.0
            bpm_confidence = max(0, 1.0 - deviation)
        else:
            bpm_confidence = 0.5

        stability = self._calculate_stability(beat_times_ms, bpm)
        interpretation = self._generate_interpretation(bpm, bpm_confidence, stability, len(beat_times_ms))

        return TempoResult(
            bpm=round(bpm, 2),
            bpm_confidence=round(bpm_confidence, 3),
            beat_times_ms=beat_times_ms,
            tempo_stability=round(stability, 3),
            interpretation=interpretation,
        )

    def _calculate_stability(self, beat_times_ms: list[int], bpm: float) -> float:
        """Calculate how stable the tempo is throughout the track."""
        if len(beat_times_ms) < 10:
            return 0.5

        intervals = np.diff(beat_times_ms)
        window_size = min(8, len(intervals) // 4)
        if window_size < 2:
            return 0.5

        local_bpms = []
        for i in range(0, len(intervals) - window_size, window_size // 2):
            window = intervals[i:i + window_size]
            avg_interval = np.mean(window)
            if avg_interval > 0:
                local_bpm = 60000 / avg_interval
                local_bpms.append(local_bpm)

        if len(local_bpms) < 2:
            return 0.5

        cv = np.std(local_bpms) / np.mean(local_bpms)
        stability = max(0, 1.0 - cv * 5)
        return stability

    def _generate_interpretation(
        self,
        bpm: float,
        confidence: float,
        stability: float,
        beat_count: int
    ) -> str:
        """Generate semantic interpretation of tempo analysis."""
        if bpm < 90:
            tempo_desc = "slow"
            feel = "relaxed, downtempo groove"
        elif bpm < 110:
            tempo_desc = "moderate"
            feel = "steady, driving pulse"
        elif bpm < 130:
            tempo_desc = "upbeat"
            feel = "energetic, dance-floor ready"
        elif bpm < 150:
            tempo_desc = "fast"
            feel = "high-energy, intense drive"
        else:
            tempo_desc = "very fast"
            feel = "frenetic, hardcore intensity"

        if confidence > 0.9:
            conf_desc = "highly consistent"
        elif confidence > 0.7:
            conf_desc = "well-defined"
        elif confidence > 0.5:
            conf_desc = "moderately stable"
        else:
            conf_desc = "variable or complex"

        if stability > 0.9:
            stab_desc = "rock-solid throughout"
        elif stability > 0.7:
            stab_desc = "consistent with minor variations"
        elif stability > 0.5:
            stab_desc = "some tempo fluctuations"
        else:
            stab_desc = "significant tempo changes"

        return (
            f"{tempo_desc.capitalize()} {bpm:.1f} BPM ({conf_desc} beat grid). "
            f"Tempo is {stab_desc}. "
            f"Electronic production with {feel}. "
            f"{beat_count} beats detected across the track."
        )
