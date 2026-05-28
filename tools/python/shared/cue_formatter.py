"""
LOL v04 Cue Formatter.

Formats analysis results into audio-visualizer compatible JSON.
"""

from .models import TimeCue, AnalysisResult


def format_timestamp(ms: int) -> str:
    """Convert milliseconds to 'M:SS.mmm' format.

    Examples:
        0 -> "0:00.000"
        62500 -> "1:02.500"
        225270 -> "3:45.270"
    """
    total_seconds = ms / 1000
    minutes = int(total_seconds // 60)
    seconds = total_seconds % 60
    return f"{minutes}:{seconds:06.3f}"


def format_cue_label(cue: TimeCue) -> str:
    """Format cue label for audio-visualizer.

    Format: "CUE_TYPE - interpretation"
    """
    cue_type_display = cue.cue_type.upper().replace("_", " ")
    return f"{cue_type_display} - {cue.interpretation}"


def prioritize_cues(
    cues: list[TimeCue],
    max_cues: int = 50,
    min_gap_ms: int = 4000
) -> list[TimeCue]:
    """Filter and prioritize cues to meet hardware constraints.

    Priority order: drops > buildups > breakdowns > sections > others

    Args:
        cues: List of all detected cues.
        max_cues: Maximum number of cues to return.
        min_gap_ms: Minimum gap between cues.

    Returns:
        Filtered and prioritized cue list.
    """
    if not cues:
        return []

    sorted_cues = sorted(cues, key=lambda c: (-c.priority, c.timestamp_ms))

    selected = []
    for cue in sorted_cues:
        too_close = False
        for selected_cue in selected:
            if abs(cue.timestamp_ms - selected_cue.timestamp_ms) < min_gap_ms:
                too_close = True
                break

        if not too_close:
            selected.append(cue)

        if len(selected) >= max_cues:
            break

    return sorted(selected, key=lambda c: c.timestamp_ms)


def create_visualizer_cues(
    analysis: AnalysisResult,
    max_cues: int = 50,
    min_gap_ms: int = 4000
) -> list[dict]:
    """Convert analysis results to audio-visualizer compatible JSON.

    Returns list of: {"time": "0:30.500", "label": "DROP - interpretation"}
    """
    all_cues: list[TimeCue] = []

    for drop in analysis.drops:
        all_cues.append(drop.to_cue())

    for buildup in analysis.buildups:
        all_cues.append(buildup.to_cue())

    for breakdown in analysis.breakdowns:
        all_cues.append(breakdown.to_cue())

    for section in analysis.sections:
        if section.section_type in ("intro", "drop", "outro"):
            all_cues.append(section.to_cue())

    selected_cues = prioritize_cues(all_cues, max_cues, min_gap_ms)

    visualizer_cues = []
    for cue in selected_cues:
        visualizer_cues.append({
            "time": format_timestamp(cue.timestamp_ms),
            "label": format_cue_label(cue),
        })

    return visualizer_cues


def format_full_analysis(analysis: AnalysisResult) -> dict:
    """Format complete analysis with all details for debugging/advanced use."""
    return {
        "metadata": {
            "source_file": analysis.source_file,
            "duration_seconds": analysis.track_duration_ms / 1000,
            "bpm": analysis.bpm,
            "total_cues": analysis.total_cues,
        },
        "drops": [
            {
                "timestamp_ms": d.timestamp_ms,
                "time": format_timestamp(d.timestamp_ms),
                "type": d.drop_type,
                "pre_drop": d.pre_drop_type,
                "intensity": d.intensity,
                "bass_return": d.bass_return,
                "interpretation": d.interpretation,
            }
            for d in analysis.drops
        ],
        "buildups": [
            {
                "start_ms": b.start_ms,
                "end_ms": b.end_ms,
                "start_time": format_timestamp(b.start_ms),
                "end_time": format_timestamp(b.end_ms),
                "duration_ms": b.duration_ms,
                "mechanism": b.primary_mechanism,
                "resolves_to": b.resolves_to,
                "tension_delta": round(b.tension_peak - b.tension_start, 3),
                "interpretation": b.interpretation,
            }
            for b in analysis.buildups
        ],
        "breakdowns": [
            {
                "start_ms": b.start_ms,
                "end_ms": b.end_ms,
                "start_time": format_timestamp(b.start_ms),
                "end_time": format_timestamp(b.end_ms),
                "duration_ms": b.duration_ms,
                "hollowness": b.hollowness,
                "emotional_quality": b.emotional_quality,
                "interpretation": b.interpretation,
            }
            for b in analysis.breakdowns
        ],
        "sections": [
            {
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
                "start_time": format_timestamp(s.start_ms),
                "end_time": format_timestamp(s.end_ms),
                "type": s.section_type,
                "energy_level": s.energy_level,
                "interpretation": s.interpretation,
            }
            for s in analysis.sections
        ],
        "curves": {
            "energy": analysis.energy_curve,
            "tension": analysis.tension_curve,
            "sample_interval_ms": analysis.sample_interval_ms,
        },
        "interpretation": analysis.interpretation,
    }
