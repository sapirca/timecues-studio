"""
LOL v04 Tension Analyzer.

Analyzes tension independently of energy. Key insight: tension != energy.
A buildup can be quiet but tense (filter sweep, rising pitch).
"""

import numpy as np
from scipy.ndimage import uniform_filter1d

from ..shared.models import AudioData, AudioFeatures, TensionResult


class TensionAnalyzer:
    """Analyze tension patterns independent of energy."""

    def __init__(self, sample_interval_ms: int = 100):
        self.sample_interval_ms = sample_interval_ms

    def analyze(
        self,
        audio: AudioData,
        features: AudioFeatures,
        energy_curve: np.ndarray,
        tension_curve: np.ndarray
    ) -> TensionResult:
        """Analyze tension patterns.

        Args:
            audio: Loaded audio data.
            features: Pre-extracted features.
            energy_curve: Pre-computed energy curve.
            tension_curve: Pre-computed tension curve.

        Returns:
            TensionResult with curve, correlation, and interpretation.
        """
        resampled_tension = self._resample_curve(
            tension_curve, features.frame_times_ms, audio.duration_ms, self.sample_interval_ms
        )
        resampled_energy = self._resample_curve(
            energy_curve, features.frame_times_ms, audio.duration_ms, self.sample_interval_ms
        )

        average_tension = float(np.mean(resampled_tension))
        peak_tension = float(np.max(resampled_tension))

        correlation = float(np.corrcoef(resampled_tension, resampled_energy)[0, 1])

        quiet_tense = self._find_quiet_tense_moments(
            tension_curve, energy_curve, features.frame_times_ms
        )

        interpretation = self._generate_interpretation(
            average_tension, peak_tension, correlation, len(quiet_tense)
        )

        return TensionResult(
            tension_curve=resampled_tension.tolist(),
            sample_interval_ms=self.sample_interval_ms,
            average_tension=round(average_tension, 3),
            peak_tension=round(peak_tension, 3),
            tension_energy_correlation=round(correlation, 3),
            quiet_tense_moments=quiet_tense,
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

    def _find_quiet_tense_moments(
        self,
        tension: np.ndarray,
        energy: np.ndarray,
        frame_times_ms: np.ndarray,
        tension_threshold: float = 0.6,
        energy_threshold: float = 0.4
    ) -> list[int]:
        """Find moments where tension is high but energy is low."""
        quiet_tense_ms = []

        smooth_tension = uniform_filter1d(tension, size=10)
        smooth_energy = uniform_filter1d(energy, size=10)

        for i in range(len(tension)):
            if smooth_tension[i] > tension_threshold and smooth_energy[i] < energy_threshold:
                timestamp_ms = int(frame_times_ms[i])
                if not quiet_tense_ms or timestamp_ms - quiet_tense_ms[-1] > 2000:
                    quiet_tense_ms.append(timestamp_ms)

        return quiet_tense_ms

    def _generate_interpretation(
        self,
        avg_tension: float,
        peak_tension: float,
        correlation: float,
        quiet_tense_count: int
    ) -> str:
        """Generate semantic interpretation of tension analysis."""
        if avg_tension > 0.6:
            profile = "persistently tense"
            feel = "sustained anticipation throughout"
        elif avg_tension > 0.4:
            profile = "moderately tense"
            feel = "clear tension-release cycles"
        elif avg_tension > 0.2:
            profile = "relaxed with tension moments"
            feel = "occasional suspenseful passages"
        else:
            profile = "low tension"
            feel = "calm, resolved, or ambient character"

        if correlation > 0.8:
            rel = "Tension closely follows energy - loud sections are tense, quiet sections are calm"
        elif correlation > 0.5:
            rel = "Moderate tension-energy coupling with some independent variation"
        elif correlation > 0.2:
            rel = "Tension often diverges from energy - quiet but tense moments present"
        else:
            rel = "Tension operates independently of energy - sophisticated dynamics"

        if quiet_tense_count > 5:
            qt_desc = f"Multiple ({quiet_tense_count}) quiet-but-tense moments - powerful anticipation building"
        elif quiet_tense_count > 0:
            qt_desc = f"{quiet_tense_count} quiet-tense moment(s) - subtle buildup techniques"
        else:
            qt_desc = "No significant quiet-tense divergence detected"

        return (
            f"Track is {profile} ({feel}). "
            f"Average tension {avg_tension:.0%}, peak {peak_tension:.0%}. "
            f"{rel}. "
            f"{qt_desc}."
        )
