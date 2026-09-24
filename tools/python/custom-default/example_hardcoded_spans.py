"""Worked example: span detector emitting two hardcoded intro/outro spans.

Useful for testing the new `Span` output kind and the source picker — the
output is deterministic so you can verify the round-trip without running
detection logic.
"""

from __future__ import annotations

from custom_api import CustomDetector, DetectionContext, Span


class HardcodedSpansDetector(CustomDetector):
    name = "example_hardcoded_spans"
    label = "hardcoded spans"
    output_kind = "span"
    is_algorithm = True
    is_annotation = True
    description = "Emits two fixed spans: 0–8 s (intro) and the last 8 s (outro). Useful for testing the picker."
    version = "0.1"

    EDGE_MS = 8_000

    def detect(self, ctx: DetectionContext) -> list[Span]:
        if ctx.duration_ms <= self.EDGE_MS * 2:
            return []
        return [
            Span(start_ms=0, duration_ms=self.EDGE_MS, label="intro", intensity=0.6),
            Span(
                start_ms=ctx.duration_ms - self.EDGE_MS,
                duration_ms=self.EDGE_MS,
                label="outro",
                intensity=0.4,
            ),
        ]
