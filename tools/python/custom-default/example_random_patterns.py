"""Worked example: riff detector emitting a 1-bar kick figure x4.

Demonstrates the experimental `Riff` output kind — one riff lane, in the shape
a Riff Patterns layer has in the app: a node (the figure, written once, its
notes in beats on its own pulse) and an item that places it. Hidden from the
registry unless the `experimentalLoopsAndPatterns` Settings flag is on.

A 4/4 bar on the sixteenth pulse is 16 steps (`steps_per_cycle`), 4 to the
beat (`subbeats_per_beat`); the kick strikes each beat, one sixteenth long.
"""

from __future__ import annotations

from custom_api import CustomDetector, DetectionContext, Riff, RiffEntry, RiffItem, RiffNode, RiffNote


class FourOnTheFloorPatternDetector(CustomDetector):
    name = "example_random_patterns"
    label = "4-on-the-floor pattern"
    output_kind = "riff"
    description = "Emits a 1-bar kick figure repeated 4 times starting at the first downbeat. Experimental."
    windowable = True
    version = "0.2"

    BEATS_PER_BAR = 4
    REPEAT_COUNT = 4

    def detect(self, ctx: DetectionContext) -> Riff:
        if not ctx.beat_times_ms or ctx.bpm <= 0:
            return Riff(nodes=[], items=[])
        start = ctx.beat_times_ms[0] / 1000
        cycle = 60.0 / float(ctx.bpm) * self.BEATS_PER_BAR
        if start + cycle * self.REPEAT_COUNT > ctx.duration_ms / 1000:
            return Riff(nodes=[], items=[])
        kick = RiffNode(
            id="kick",
            name="Four on the floor",
            steps_per_cycle=4 * self.BEATS_PER_BAR,
            notes=[RiffNote(start=beat, end=beat + 0.25) for beat in range(self.BEATS_PER_BAR)],
        )
        return Riff(
            nodes=[kick],
            items=[RiffItem(start=start, end=start + cycle, label="kick pattern",
                            sequence=[RiffEntry(type="kick", length_steps=kick.steps_per_cycle)],
                            repeat_count=self.REPEAT_COUNT)],
            drum="kick",
        )
