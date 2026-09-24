"""Worked example: cue detector emitting 8 evenly-spaced random-labeled cues.

A skeleton for testing the `Cue` annotation surface and the new source picker
in the inspector. Deterministic across runs of the same song (the RNG is
seeded with the track duration) so the test fixture stays stable.
"""

from __future__ import annotations

import random

from custom_api import Cue, CustomDetector, DetectionContext


class RandomCueDetector(CustomDetector):
    name = "example_random_cues"
    label = "random cues"
    output_kind = "cue"
    is_algorithm = True
    is_annotation = True
    description = "Sprinkles 8 evenly-spaced cues with random labels — useful for testing the picker / Accept-Reject UI."
    version = "0.1"

    N_CUES = 8
    LABELS = ("hit", "clap", "kick", "snare", "fx", "vox", "rise", "drop")

    def detect(self, ctx: DetectionContext) -> list[Cue]:
        if ctx.duration_ms <= 0:
            return []
        rng = random.Random(ctx.duration_ms)
        step = ctx.duration_ms / (self.N_CUES + 1)
        out: list[Cue] = []
        for i in range(self.N_CUES):
            t_ms = int((i + 1) * step)
            # Demonstrate alt-candidates: every third cue gets a ±150 ms
            # alternative, clamped to the track. The evaluator counts any one
            # of these as a hit, so a detector that can't fully commit to a
            # single instant doesn't get penalised for the ambiguity.
            cands: list[int] | None = None
            if i % 3 == 0:
                a = max(0, t_ms - 150)
                b = min(ctx.duration_ms, t_ms + 150)
                cands = [a, b]
            out.append(Cue(
                time_ms=t_ms,
                label=rng.choice(self.LABELS),
                intensity=round(rng.random(), 3),
                candidates=cands,
            ))
        return out
