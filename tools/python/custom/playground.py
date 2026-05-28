"""Playground detector — a customizable boundary detector you can tweak live.

Uses ctx.energy_curve + ctx.tension_curve (both 100 ms / sample, in [0, 1])
to find moments where the song's "drive" jumps the most, then optionally
snaps each pick to the nearest beat. Every knob below is safe to change
without breaking validation.
"""

import numpy as np
from custom_api import Boundary, CustomDetector, DetectionContext


# ─── KNOBS ──────────────────────────────────────────────────────────────────
# Tweak these, click Save & validate, then Run. Output should visibly change.

ENERGY_WEIGHT  = 1.0     # how much ctx.energy_curve contributes to the score
TENSION_WEIGHT = 1.0     # how much ctx.tension_curve contributes to the score
SMOOTH_WIN     = 5       # boxcar smoothing on the score (in 100 ms samples)
DERIV_HALF     = 3       # half-window for the "jump" measure (in samples)
PEAK_Z         = 1.5     # peaks must be ≥ mean + Z·std of the jump signal
MIN_SPACING_MS = 4_000   # drop peaks closer than this to a stronger neighbor
SNAP_TO_BEAT   = True    # snap each chosen ms to the nearest beat in ctx.beat_times_ms
SNAP_TOL_MS    = 250     # …only if a beat is within this distance
TOP_K_CRITICAL = 3       # the K strongest get importance="critical"; rest are "optional"
LABEL_PREFIX   = "jump"  # human-readable label prefix; set to "" for no labels

# ────────────────────────────────────────────────────────────────────────────


class Playground(CustomDetector):
    name          = "playground"
    label         = "Playground (energy+tension jumps)"
    output_kind   = "boundary"
    is_algorithm  = True
    is_annotation = False
    description   = "Tweakable boundary detector — knobs at the top of the file."
    version       = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        # 1) Build a combined score from the two pre-computed curves.
        e = np.asarray(ctx.energy_curve,  dtype=np.float32)
        t = np.asarray(ctx.tension_curve, dtype=np.float32)
        n = min(e.size, t.size)
        if n < 2 * DERIV_HALF + 1:
            return []
        score = ENERGY_WEIGHT * e[:n] + TENSION_WEIGHT * t[:n]

        # 2) Smooth, then measure how much the score "jumps" over a small window.
        if SMOOTH_WIN > 1:
            k = np.ones(SMOOTH_WIN, dtype=np.float32) / SMOOTH_WIN
            score = np.convolve(score, k, mode="same")
        jump = np.zeros_like(score)
        jump[DERIV_HALF:-DERIV_HALF] = (
            score[2 * DERIV_HALF:] - score[: -2 * DERIV_HALF]
        )
        jump = np.abs(jump)

        # 3) Threshold on z-score, find local maxima above it.
        thresh = float(jump.mean() + PEAK_Z * jump.std())
        is_peak = (
            (jump[1:-1] > thresh)
            & (jump[1:-1] >= jump[:-2])
            & (jump[1:-1] >= jump[2:])
        )
        peak_idxs = np.where(is_peak)[0] + 1
        if peak_idxs.size == 0:
            return []

        # 4) ms_per_sample for the curves is 100 (per the contract).
        peaks_ms = peak_idxs.astype(np.int64) * 100
        strengths = jump[peak_idxs]

        # 5) Greedy non-max suppression by MIN_SPACING_MS — keep the strongest.
        order = np.argsort(-strengths)
        kept: list[tuple[int, float]] = []  # (time_ms, strength)
        for i in order:
            ms = int(peaks_ms[i])
            if all(abs(ms - k_ms) >= MIN_SPACING_MS for k_ms, _ in kept):
                kept.append((ms, float(strengths[i])))
        kept.sort(key=lambda x: x[0])  # back to chronological order

        # 6) Optionally snap to the nearest beat within tolerance.
        if SNAP_TO_BEAT and ctx.beat_times_ms:
            beats = np.asarray(ctx.beat_times_ms, dtype=np.int64)
            snapped: list[tuple[int, float]] = []
            for ms, s in kept:
                j = int(np.argmin(np.abs(beats - ms)))
                if abs(int(beats[j]) - ms) <= SNAP_TOL_MS:
                    ms = int(beats[j])
                snapped.append((ms, s))
            kept = snapped

        # 7) Mark top-K strongest as "critical", rest as "optional".
        rank_by_strength = sorted(range(len(kept)), key=lambda i: -kept[i][1])
        critical_set = set(rank_by_strength[:TOP_K_CRITICAL])

        out: list[Boundary] = []
        for i, (ms, _) in enumerate(kept):
            if not (0 <= ms <= ctx.duration_ms):
                continue
            label = f"{LABEL_PREFIX} {ms // 1000}s" if LABEL_PREFIX else None
            out.append(Boundary(
                time_ms=int(ms),
                label=label,
                importance="critical" if i in critical_set else "optional",
            ))
        return out
