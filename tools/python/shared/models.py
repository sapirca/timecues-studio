"""
LOL v04 Data Models.

All models follow the "Semantic Standard" with mandatory `interpretation` field
that describes sonic meaning, never visual instructions.
"""

from dataclasses import dataclass
from typing import Optional
import numpy as np


@dataclass
class AudioData:
    """Loaded audio data."""
    y: np.ndarray              # Mono audio time series
    sr: int                    # Sample rate (22050 Hz default)
    duration_seconds: float
    duration_ms: int
    file_path: str


@dataclass
class AudioFeatures:
    """Pre-extracted audio features shared across tools."""
    # Energy features
    rms: np.ndarray

    # Spectral features
    spectral_centroid: np.ndarray
    spectral_bandwidth: np.ndarray
    spectral_flux: np.ndarray
    spectral_flatness: np.ndarray
    spectral_rolloff: np.ndarray

    # Harmonic features
    chromagram: np.ndarray

    # Timbral features
    mfcc: np.ndarray

    # Rhythm features
    onset_env: np.ndarray
    onset_frames: np.ndarray
    tempo: float
    beat_frames: np.ndarray

    # Metadata
    sr: int
    hop_length: int
    n_frames: int
    frame_times_ms: np.ndarray


@dataclass
class TimeCue:
    """Single cue point for light show."""
    timestamp_ms: int
    cue_type: str              # "drop" | "buildup" | "breakdown" | "section" | etc.
    intensity: float           # 0.0-1.0
    interpretation: str        # REQUIRED: Describes sonic meaning
    priority: int              # 1-10 for filtering

    def to_dict(self) -> dict:
        return {
            "timestamp_ms": self.timestamp_ms,
            "cue_type": self.cue_type,
            "intensity": self.intensity,
            "interpretation": self.interpretation,
            "priority": self.priority,
        }


@dataclass
class DropEvent:
    """Detected drop/impact moment."""
    timestamp_ms: int
    intensity: float           # 0.0-1.0
    drop_type: str             # "bass_return" | "filter_open" | "rhythmic" | "layered"
    pre_drop_type: str         # "silence" | "riser" | "filter_sweep" | "breakdown"
    energy_before: float
    energy_after: float
    bass_return: bool
    interpretation: str
    priority: int = 10         # Drops are highest priority

    def to_cue(self) -> TimeCue:
        return TimeCue(
            timestamp_ms=self.timestamp_ms,
            cue_type="drop",
            intensity=self.intensity,
            interpretation=self.interpretation,
            priority=self.priority,
        )


@dataclass
class BuildupSection:
    """Detected tension-building section."""
    start_ms: int
    end_ms: int
    duration_ms: int
    tension_start: float
    tension_peak: float
    primary_mechanism: str     # "riser" | "filter_sweep" | "rhythmic_accel" | "crescendo"
    resolves_to: str           # "drop" | "breakdown" | "transition"
    interpretation: str
    priority: int = 8

    def to_cue(self) -> TimeCue:
        return TimeCue(
            timestamp_ms=self.start_ms,
            cue_type="buildup",
            intensity=(self.tension_peak - self.tension_start),
            interpretation=self.interpretation,
            priority=self.priority,
        )


@dataclass
class BreakdownSection:
    """Detected sparse/atmospheric section."""
    start_ms: int
    end_ms: int
    duration_ms: int
    hollowness: float          # 0.0-1.0
    energy_level: str          # "very_low" | "low" | "medium" | "high"
    emotional_quality: str     # "ethereal" | "melancholic" | "suspenseful" | "peaceful"
    interpretation: str
    priority: int = 7

    def to_cue(self) -> TimeCue:
        return TimeCue(
            timestamp_ms=self.start_ms,
            cue_type="breakdown",
            intensity=self.hollowness,
            interpretation=self.interpretation,
            priority=self.priority,
        )


@dataclass
class Section:
    """Structural section of the track."""
    start_ms: int
    end_ms: int
    section_type: str          # "intro" | "bridge" | "buildup" | "drop" | "breakdown" | "outro"
    energy_level: str          # "low" | "medium" | "high" | "peak"
    interpretation: str
    priority: int = 6

    def to_cue(self) -> TimeCue:
        return TimeCue(
            timestamp_ms=self.start_ms,
            cue_type="section",
            intensity={"low": 0.25, "medium": 0.5, "high": 0.75, "peak": 1.0}.get(self.energy_level, 0.5),
            interpretation=self.interpretation,
            priority=self.priority,
        )


@dataclass
class TempoResult:
    """Output from tempo analyzer."""
    bpm: float
    bpm_confidence: float
    beat_times_ms: list[int]
    tempo_stability: float     # 0.0-1.0
    interpretation: str


@dataclass
class EnergyResult:
    """Output from energy tracker."""
    energy_curve: list[float]
    sample_interval_ms: int
    average_energy: float
    peak_energy: float
    energy_events: list[TimeCue]
    interpretation: str


@dataclass
class TensionResult:
    """Output from tension analyzer."""
    tension_curve: list[float]
    sample_interval_ms: int
    average_tension: float
    peak_tension: float
    tension_energy_correlation: float
    quiet_tense_moments: list[int]  # Timestamps where tension >> energy
    interpretation: str


@dataclass
class AnalysisResult:
    """Complete analysis output from all tools."""
    # Metadata
    source_file: str
    track_duration_ms: int
    bpm: float

    # Detected events
    drops: list[DropEvent]
    buildups: list[BuildupSection]
    breakdowns: list[BreakdownSection]
    sections: list[Section]

    # Continuous curves
    energy_curve: list[float]
    tension_curve: list[float]
    sample_interval_ms: int

    # Summary
    total_cues: int
    interpretation: str

    def to_dict(self) -> dict:
        return {
            "metadata": {
                "source_file": self.source_file,
                "duration_ms": self.track_duration_ms,
                "duration_seconds": self.track_duration_ms / 1000.0,
                "bpm": self.bpm,
                "total_cues": self.total_cues,
            },
            "drops": [{"timestamp_ms": d.timestamp_ms, "type": d.drop_type,
                       "intensity": d.intensity, "interpretation": d.interpretation}
                      for d in self.drops],
            "buildups": [{"start_ms": b.start_ms, "end_ms": b.end_ms,
                          "mechanism": b.primary_mechanism, "interpretation": b.interpretation}
                         for b in self.buildups],
            "breakdowns": [{"start_ms": b.start_ms, "end_ms": b.end_ms,
                            "hollowness": b.hollowness, "interpretation": b.interpretation}
                           for b in self.breakdowns],
            "sections": [{"start_ms": s.start_ms, "type": s.section_type,
                          "energy": s.energy_level, "interpretation": s.interpretation}
                         for s in self.sections],
            "curves": {
                "energy": self.energy_curve,
                "tension": self.tension_curve,
                "sample_interval_ms": self.sample_interval_ms,
            },
            "interpretation": self.interpretation,
        }
