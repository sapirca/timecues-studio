"""Worked example: loop detector emitting one 4-bar loop on the first downbeat.

Demonstrates the experimental `Loop` output kind. Hidden from the registry
unless the `experimentalLoopsAndPatterns` Settings flag is on — the server
filters loop/pattern detectors out of the response when the flag is off,
mirroring the UI gating for the Loops annotation tab.
"""

from __future__ import annotations

from custom_api import CustomDetector, DetectionContext, Loop


class FirstDownbeatLoopDetector(CustomDetector):
    name = "example_random_loops"
    label = "first 4-bar loop"
    output_kind = "loop"
    is_algorithm = True
    is_annotation = True
    description = "Emits one 4-bar loop starting at the first detected downbeat. Experimental."
    version = "0.1"

    BARS = 4
    BEATS_PER_BAR = 4   # 4/4 assumed; refine when ctx exposes a time signature.

    def detect(self, ctx: DetectionContext) -> list[Loop]:
        if not ctx.beat_times_ms or ctx.bpm <= 0:
            return []
        start_ms = int(ctx.beat_times_ms[0])
        # Each beat is 60_000 / bpm ms; a bar is 4 beats; loop spans BARS bars.
        beat_ms = 60_000.0 / float(ctx.bpm)
        duration_ms = int(round(beat_ms * self.BEATS_PER_BAR * self.BARS))
        if duration_ms <= 0 or start_ms + duration_ms > ctx.duration_ms:
            return []
        return [Loop(
            start_ms=start_ms,
            duration_ms=duration_ms,
            label=f"{self.BARS}-bar loop",
            snap_zero_cross=True,
        )]
