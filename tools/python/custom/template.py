"""Custom detector template.

This file IS registered as a runnable detector named `template` so you can see
end-to-end how a detector flows through the system. To start your own:

  cp tools/python/custom/template.py tools/python/custom/<your_name>.py

…then change `name`, `label`, and `detect()` in your copy. The server will
auto-discover the new file (POST /api/custom-scripts/reload to force a re-scan).

Read tools/python/custom/CLAUDE.md for the full contract and rules.
"""

from custom_api import Boundary, CustomDetector, DetectionContext

# Other output dataclasses you can import here when you change `output_kind`:
#   Cue     — labeled point in time (kick hits, FX triggers, claps)
#   Span    — labeled interval, may overlap on the same row (vocal-active
#             regions, instrument presence, phrase boundaries)
#   Loop    — grid-aware seamless-playback interval; gated by the
#             experimentalLoopsAndPatterns Settings flag (registry hides
#             loop detectors when the flag is off)
#   Pattern — short repeating motif that tiles `repeat_count` times across
#             the track; same experimental gating as Loop
# See tools/python/custom/CLAUDE.md for the per-field validation rules and
# example_hardcoded_spans / example_random_loops / example_random_patterns
# for end-to-end worked examples.


class Template(CustomDetector):
    # ── Identity (all required) ────────────────────────────────────────────
    name = "template"               # ^[a-z][a-z0-9_-]{0,30}$ — also the file stem
    label = "Template (every 30 s)" # 1–80 chars, shown in the UI
    output_kind = "boundary"        # one of: "boundary" | "cue" | "span" |
                                    # "loop" | "pattern". "loop"/"pattern"
                                    # detectors are hidden from the registry
                                    # when the experimentalLoopsAndPatterns
                                    # Settings flag is off.

    # ── Surfacing (at least one True) ──────────────────────────────────────
    is_algorithm  = True            # show as a read-only row in the inspector
    is_annotation = True           # ALSO surface as an editable annotation tab

    # ── Optional metadata ──────────────────────────────────────────────────
    description = "Starter scaffold — emits one boundary every 30 seconds. Copy this file to start your own detector."
    version = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        """Return your boundary predictions.

        Available on `ctx`:
          ctx.audio          : np.ndarray, mono, sr=22050
          ctx.sr             : 22050
          ctx.duration_ms    : int
          ctx.stems          : {"vocals","drums","bass","other"} → np.ndarray (may be {})
          ctx.features       : AudioFeatures (rms, chromagram, mfcc, spectral_*, ...)
          ctx.energy_curve   : np.ndarray in [0, 1], 100 ms / sample
          ctx.tension_curve  : np.ndarray in [0, 1], 100 ms / sample
          ctx.bpm            : float
          ctx.beat_times_ms  : list[int]

        Validation rules (output is rejected if violated):
          - Boundary.time_ms    : int, in [0, ctx.duration_ms]
          - Boundary.label      : str | None
          - Boundary.importance : "critical" | "optional" | None
          - Boundary.candidates : list[int] | None — each in [0, ctx.duration_ms]

        Bad items are dropped with a structured error; good items are kept.
        """
        # ─── EXAMPLE: replace with your logic ──────────────────────────────
        # Put a marker every 30 seconds.
        step_ms = 30_000
        return [
            Boundary(time_ms=t, label=f"step at {t // 1000}s", importance="optional")
            for t in range(0, ctx.duration_ms + 1, step_ms)
        ]
