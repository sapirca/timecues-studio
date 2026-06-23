"""First-party stub: surfaces the `phrases` generator as a detector.

The real logic lives in tools/python/generators/phrases.py (cached allin1
sections + downbeat grid). Surfaced as a read-only algorithm overlay
(is_annotation=False) because boundaries have no editable annotation-layer
equivalent — structural boundaries are reviewed through the Manual track,
and this overlay lets the annotator compare against the auto phrases. Run
regenerates from the current allin1 cache.
"""

from custom_api import Boundary, CustomDetector, DetectionContext
from generators.common import to_dataclasses
from generators.phrases import generate


class CuratedPhrases(CustomDetector):
    name = "curated_phrases"
    label = "Phrases (curated)"
    output_kind = "boundary"
    is_algorithm = True
    is_annotation = False
    description = "Structural phrases: allin1 sections (critical) + N-bar phrase marks (optional)."
    version = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        return to_dataclasses(generate(ctx.slug))
