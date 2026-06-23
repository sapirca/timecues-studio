"""First-party stub: surfaces the `cues` generator as a detector.

The real logic lives in tools/python/generators/cues.py (sparse, salient
points: instrument/vocal/motif entrances, beat-snapped, section
boundaries excluded). This thin wrapper lets the existing custom-detector
UI list it, run it, overlay it, and "Copy to manual layer" it. Run
regenerates from the current PANNs / lyrics / locomotif caches; empty
until at least one of those is populated.
"""

from custom_api import Cue, CustomDetector, DetectionContext
from generators.common import to_dataclasses
from generators.cues import generate


class CuratedCues(CustomDetector):
    name = "curated_cues"
    label = "Cues (curated)"
    output_kind = "cue"
    is_algorithm = True
    is_annotation = True
    description = "Sparse points of interest: instrument/vocal/motif entrances, beat-snapped, sections excluded."
    version = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Cue]:
        return to_dataclasses(generate(ctx.slug))
