"""Worked example: pattern detector emitting a 1-bar kick pattern x4.

Demonstrates the experimental `Pattern` output kind. Hidden from the registry
unless the `experimentalLoopsAndPatterns` Settings flag is on.

`highlighted_beats` indexes 16th-note steps within one cycle — see
PATTERN_SUBBEATS_PER_BEAT in web-app/src/types/annotationLayer.ts. A 4/4 bar
has 16 steps (0..15); we accent the downbeats at steps 0, 4, 8, 12.
"""

from __future__ import annotations

from custom_api import CustomDetector, DetectionContext, Pattern


class FourOnTheFloorPatternDetector(CustomDetector):
    name = "example_random_patterns"
    label = "4-on-the-floor pattern"
    output_kind = "pattern"
    is_algorithm = True
    is_annotation = True
    description = "Emits a 1-bar kick pattern repeated 4 times starting at the first downbeat. Experimental."
    version = "0.1"

    BEATS_PER_BAR = 4
    REPEAT_COUNT = 4
    DOWNBEAT_STEPS = (0, 4, 8, 12)  # 16th-note step indices for 4-on-the-floor

    def detect(self, ctx: DetectionContext) -> list[Pattern]:
        if not ctx.beat_times_ms or ctx.bpm <= 0:
            return []
        start_ms = int(ctx.beat_times_ms[0])
        beat_ms = 60_000.0 / float(ctx.bpm)
        cycle_ms = int(round(beat_ms * self.BEATS_PER_BAR))
        if cycle_ms <= 0 or start_ms + cycle_ms * self.REPEAT_COUNT > ctx.duration_ms:
            return []
        return [Pattern(
            start_ms=start_ms,
            duration_ms=cycle_ms,
            label="kick pattern",
            repeat_count=self.REPEAT_COUNT,
            highlighted_beats=list(self.DOWNBEAT_STEPS),
        )]
