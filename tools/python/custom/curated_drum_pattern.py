"""First-party stub: surfaces the `drum-pattern` generator as a detector.

The real logic lives in tools/python/generators/drum_pattern.py (drum-stem
onsets folded onto the 16th-note grid → the repeating groove). This thin
wrapper lets the existing custom-detector UI list it, run it, overlay it,
and "Copy to manual layer" it. The `pattern` output kind is gated by the
experimentalLoopsAndPatterns Settings flag (hidden when off). Run needs
the Demucs drums stem on disk; empty otherwise.
"""

from custom_api import CustomDetector, DetectionContext, Pattern
from generators.common import to_dataclasses
from generators.drum_pattern import generate


class CuratedDrumPattern(CustomDetector):
    name = "curated_drum_pattern"
    label = "Drum pattern (curated)"
    output_kind = "pattern"
    is_algorithm = True
    is_annotation = True
    description = "The repeating drum groove: drum-stem onsets quantized to the 16th-note grid."
    version = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Pattern]:
        return to_dataclasses(generate(ctx.slug))
