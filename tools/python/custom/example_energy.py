"""Worked example: boundary detector based on energy-curve jumps.

This is a minimal but complete detector. It reads ctx.energy_curve, finds
points where the smoothed gradient exceeds a threshold, and returns one
Boundary per peak.

Use it to:
  - Verify the runner end-to-end (drop _example_energy.py into custom/, run
    `POST /api/custom-scripts/run/example_energy?slug=<slug>`).
  - See real usage of ctx.features, ctx.energy_curve, np operations.
"""

from __future__ import annotations

import numpy as np

from custom_api import Boundary, CustomDetector, DetectionContext


class EnergyJumpDetector(CustomDetector):
    name = "example_energy"
    label = "energy jumps"
    output_kind = "boundary"
    is_algorithm = True
    is_annotation = True
    description = "Boundary at every peak in the gradient of the smoothed energy curve."
    version = "0.1"

    # Tunables. Kept as class attributes so they're easy to read/edit.
    SMOOTH_WINDOW = 5          # in samples (energy curve is 100 ms / sample)
    GRADIENT_THRESHOLD = 0.04  # absolute change per 100 ms — empirical
    MIN_GAP_MS = 4_000         # don't return boundaries closer than this

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        energy = np.asarray(ctx.energy_curve, dtype=np.float32)
        if energy.size < 4:
            return []

        # Smooth with a small box filter so per-frame noise doesn't trigger.
        kernel = np.ones(self.SMOOTH_WINDOW, dtype=np.float32) / self.SMOOTH_WINDOW
        smooth = np.convolve(energy, kernel, mode="same")

        gradient = np.abs(np.diff(smooth))
        peak_indices = np.where(gradient > self.GRADIENT_THRESHOLD)[0]
        if peak_indices.size == 0:
            return []

        # Energy curve sample interval is 100 ms (set by the runner / skill.py).
        sample_interval_ms = 100

        out: list[Boundary] = []
        last_emitted_ms = -self.MIN_GAP_MS  # always emit the first one
        for idx in peak_indices:
            t_ms = int(idx * sample_interval_ms)
            if t_ms - last_emitted_ms < self.MIN_GAP_MS:
                continue
            if t_ms > ctx.duration_ms:
                break
            out.append(Boundary(
                time_ms=t_ms,
                label=f"energy jump (Δ={float(gradient[idx]):.3f})",
                importance="optional",
            ))
            last_emitted_ms = t_ms

        return out
