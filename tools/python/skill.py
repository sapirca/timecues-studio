#!/usr/bin/env python3
"""
LOL v05 Audio Analysis Skill.

Orchestrates all analysis tools and produces prioritized cue output
for the audio-visualizer.

Usage:
    python -m src.skill <audio_file> [--output <output_dir>] [--max-cues <n>] [--verbose]

Examples:
    python -m src.skill ../../common/audio/vandelux-tulum.mp3
    python -m src.skill ../../common/audio/vandelux-tulum.mp3 --output ./outputs --max-cues 30
"""

import argparse
import json
import sys
from pathlib import Path

from .shared.audio_loader import load_audio
from .shared.feature_extractor import extract_features, compute_energy_curve, compute_tension_curve
from .shared.models import AnalysisResult
from .shared.cue_formatter import create_visualizer_cues, format_full_analysis

from .tools.tempo_analyzer import TempoAnalyzer
from .tools.energy_tracker import EnergyTracker
from .tools.tension_analyzer import TensionAnalyzer
from .tools.drop_detector import DropDetector
from .tools.buildup_detector import BuildupDetector
from .tools.breakdown_detector import BreakdownDetector
from .tools.section_classifier import SectionClassifier


class LOLSkill:
    """LOL v05 Audio Analysis Skill.

    Orchestrates all analysis tools and produces prioritized cue output
    for the audio-visualizer.
    """

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def log(self, msg: str):
        """Print log message if verbose."""
        if self.verbose:
            print(f"[LOL] {msg}")

    def analyze(
        self,
        audio_path: str,
        max_cues: int = 50,
        min_gap_ms: int = 4000,
    ) -> tuple[list[dict], AnalysisResult]:
        """Run full analysis pipeline.

        Args:
            audio_path: Path to audio file.
            max_cues: Maximum cues for hardware constraints.
            min_gap_ms: Minimum gap between cues.

        Returns:
            Tuple of:
            - list[dict]: Audio-visualizer compatible cues.
            - AnalysisResult: Full analysis data.
        """
        self.log(f"Loading audio: {audio_path}")

        # 1. Load audio
        audio = load_audio(audio_path)
        self.log(f"Duration: {audio.duration_seconds:.1f}s")

        # 2. Extract shared features (computed once)
        self.log("Extracting features...")
        features = extract_features(audio)
        self.log(f"Tempo: {features.tempo:.1f} BPM")

        # 3. Compute energy and tension curves
        self.log("Computing energy curve...")
        energy_curve = compute_energy_curve(features)

        self.log("Computing tension curve...")
        tension_curve = compute_tension_curve(features, energy_curve)

        # 4. Run all tools
        self.log("Running tempo analyzer...")
        tempo_result = TempoAnalyzer().analyze(audio, features)

        self.log("Running energy tracker...")
        energy_result = EnergyTracker().analyze(audio, features, energy_curve)

        self.log("Running tension analyzer...")
        tension_result = TensionAnalyzer().analyze(audio, features, energy_curve, tension_curve)

        self.log("Running breakdown detector...")
        breakdown_result = BreakdownDetector().analyze(audio, features, energy_curve)

        self.log("Running drop detector...")
        drop_result = DropDetector().analyze(audio, features, energy_curve, breakdown_result.breakdowns)

        self.log("Running buildup detector...")
        buildup_result = BuildupDetector().analyze(audio, features, energy_curve, tension_curve)

        self.log("Running section classifier...")
        section_result = SectionClassifier().analyze(audio, features, energy_curve)

        # 5. Build full analysis result
        self.log("Building analysis result...")
        analysis = AnalysisResult(
            source_file=audio_path,
            track_duration_ms=audio.duration_ms,
            bpm=tempo_result.bpm,
            drops=drop_result.drops,
            buildups=buildup_result.buildups,
            breakdowns=breakdown_result.breakdowns,
            sections=section_result.sections,
            energy_curve=energy_result.energy_curve,
            tension_curve=tension_result.tension_curve,
            sample_interval_ms=100,
            total_cues=0,
            interpretation=self._generate_track_interpretation(
                tempo_result, energy_result, tension_result,
                drop_result, buildup_result, breakdown_result,
                section_result, audio
            ),
        )

        # 6. Create visualizer cues
        self.log("Creating visualizer cues...")
        visualizer_cues = create_visualizer_cues(analysis, max_cues, min_gap_ms)
        analysis.total_cues = len(visualizer_cues)

        self.log(f"Generated {len(visualizer_cues)} cues")

        return visualizer_cues, analysis

    def _generate_track_interpretation(
        self,
        tempo_result,
        energy_result,
        tension_result,
        drop_result,
        buildup_result,
        breakdown_result,
        section_result,
        audio
    ) -> str:
        """Generate overall track interpretation."""
        parts = []

        if tempo_result.bpm < 100:
            tempo_char = "downtempo"
        elif tempo_result.bpm < 120:
            tempo_char = "mid-tempo"
        elif tempo_result.bpm < 140:
            tempo_char = "driving"
        else:
            tempo_char = "high-energy"

        parts.append(f"{tempo_char} electronic track at {tempo_result.bpm:.0f} BPM")

        if drop_result.drop_count > 0:
            parts.append(f"with {drop_result.drop_count} impactful drop(s)")

        if buildup_result.buildup_count > 0:
            parts.append(f"{buildup_result.buildup_count} tension buildup(s)")

        if breakdown_result.breakdown_count > 0:
            parts.append(f"{breakdown_result.breakdown_count} atmospheric breakdown(s)")

        if tension_result.tension_energy_correlation < 0.5:
            parts.append("Sophisticated dynamics with tension operating independently of energy")

        return ". ".join(parts) + "."


def main():
    parser = argparse.ArgumentParser(
        description="LOL v05 Audio Analysis Skill",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python -m src.skill ../../common/audio/vandelux-tulum.mp3
    python -m src.skill ../../common/audio/vandelux-tulum.mp3 --output ./outputs
    python -m src.skill ../../common/audio/vandelux-tulum.mp3 --max-cues 30 --verbose
        """
    )
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--output", "-o", default="./outputs", help="Output directory")
    parser.add_argument("--max-cues", type=int, default=50, help="Maximum cues")
    parser.add_argument("--min-gap", type=int, default=4000, help="Minimum gap between cues (ms)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--full", "-f", action="store_true", help="Output full analysis (not just cues)")

    args = parser.parse_args()

    audio_path = Path(args.audio_file)
    if not audio_path.exists():
        print(f"Error: Audio file not found: {audio_path}")
        sys.exit(1)

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    skill = LOLSkill(verbose=args.verbose)
    cues, analysis = skill.analyze(
        str(audio_path),
        max_cues=args.max_cues,
        min_gap_ms=args.min_gap,
    )

    stem = audio_path.stem
    cues_file = output_dir / f"{stem}_cues.json"
    analysis_file = output_dir / f"{stem}_analysis.json"

    with open(cues_file, "w") as f:
        json.dump(cues, f, indent=2)
    print(f"Cues written to: {cues_file}")

    if args.full:
        full_analysis = format_full_analysis(analysis)
        with open(analysis_file, "w") as f:
            json.dump(full_analysis, f, indent=2)
        print(f"Full analysis written to: {analysis_file}")

    print(f"\n=== Analysis Summary ===")
    print(f"Track: {audio_path.name}")
    print(f"Duration: {analysis.track_duration_ms / 1000:.1f}s")
    print(f"BPM: {analysis.bpm:.1f}")
    print(f"Drops: {len(analysis.drops)}")
    print(f"Buildups: {len(analysis.buildups)}")
    print(f"Breakdowns: {len(analysis.breakdowns)}")
    print(f"Sections: {len(analysis.sections)}")
    print(f"Total Cues: {len(cues)}")
    print(f"\n{analysis.interpretation}")

    print(f"\n=== Cues ({len(cues)}) ===")
    for cue in cues:
        print(f"  {cue['time']}: {cue['label'][:80]}...")


if __name__ == "__main__":
    main()
