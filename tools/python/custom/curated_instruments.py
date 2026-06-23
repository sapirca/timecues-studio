"""First-party stub: surfaces the `instruments` generator as a detector.

The real logic lives in tools/python/generators/instruments.py (Silero-VAD
on the vocals stem for a reliable "vocals" base + PANNs on the `other`
stem for named instruments). This thin wrapper lets the existing
custom-detector UI list it, run it, overlay it, and "Copy to manual
layer" it — with no extra web plumbing. Run regenerates from the current
SPAN / PANNs caches; if those aren't populated yet the result is empty.
"""

from custom_api import CustomDetector, DetectionContext, Span
from generators.common import to_dataclasses
from generators.instruments import generate


class CuratedInstruments(CustomDetector):
    name = "curated_instruments"
    label = "Instruments (curated)"
    output_kind = "span"
    is_algorithm = True
    is_annotation = True
    description = "Per-instrument presence spans: VAD vocals + PANNs named instruments (on the 'other' stem)."
    version = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Span]:
        return to_dataclasses(generate(ctx.slug))
