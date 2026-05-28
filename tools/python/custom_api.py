"""Public API for user-authored custom detectors.

This module is the ONLY thing user scripts in tools/python/custom/<name>.py
should import from. The classes and dataclasses here are the frozen contract:
field names, types, and bounds will not change without a major version bump.

Quick usage
-----------
    from custom_api import CustomDetector, DetectionContext, Boundary

    class MyDetector(CustomDetector):
        name        = "my_detector"     # ^[a-z][a-z0-9_-]{0,30}$, unique
        label       = "My detector"
        output_kind = "boundary"        # or "cue"
        is_algorithm  = True
        is_annotation = False

        def detect(self, ctx: DetectionContext) -> list[Boundary]:
            return [Boundary(time_ms=int(t * 1000)) for t in some_times]

The runner validates every field of every returned item. Items that fail
validation are dropped with a structured error; the rest are kept. An
exception inside detect() is caught and reported, never crashes the server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

import numpy as np

# Re-export AudioFeatures so user scripts only need one import.
from shared.models import AudioFeatures  # noqa: F401

OutputKind = Literal["boundary", "cue", "span", "loop", "pattern"]
Importance = Literal["critical", "optional"]


# ─── Inputs ──────────────────────────────────────────────────────────────────


GridMode = Literal["static", "dynamic", "manual"]


@dataclass(frozen=True)
class TempoAnchor:
    """One point on the piecewise-constant tempo curve. Mirrors the
    TypeScript ``TempoAnchor`` (see ``web-app/src/types/songInfo.ts``):
    the segment that STARTS at ``timestamp_ms`` has tempo ``bpm`` until
    the next anchor (or end of audio)."""
    timestamp_ms: int   # absolute time (rounded ms)
    bpm: float


@dataclass(frozen=True)
class DetectionContext:
    """Everything a detector might want, computed once per song.

    The runner constructs this. User code only reads fields.

    Attributes
    ----------
    audio
        Mono audio samples at sample rate `sr`. Float32 in [-1, 1].
    sr
        Sample rate in Hz (always 22050).
    duration_ms
        Track length in milliseconds (rounded).
    stems
        Demuxed sources keyed by name: {"vocals", "drums", "bass", "other"}.
        Each value is a 1D float32 ndarray at `sr`. May be an empty dict if
        the song has not been demuxed yet — handle the empty case.
    features
        Pre-extracted spectral / rhythmic features. See shared.models.AudioFeatures.
    energy_curve
        Composite normalized energy in [0, 1]. Sample interval = 100 ms.
    tension_curve
        Tension proxy in [0, 1]. Same sample interval as energy_curve.
    bpm
        Curator-confirmed tempo from SongInfo. Falls back to the
        ``librosa`` feature extractor's tempo when SongInfo has none.
    beat_times_ms
        Beat instants in milliseconds (sorted ascending).
    grid_offset_ms
        Time of bar 1 / beat 1 in milliseconds (from SongInfo.gridOffset).
    time_signature
        Time signature string from SongInfo (e.g. ``"4/4"``).
    beats_per_bar
        Numerator of the time signature, pre-parsed for convenience.
    grid_mode
        ``"static"`` / ``"dynamic"`` / ``"manual"`` from SongInfo.gridMode.
    tempo_anchors
        Sparse anchor list (Dynamic / Manual modes). Empty in Static mode.
        Sorted ascending by ``timestamp_ms``.

    Anchor-aware helpers (``bpm_at``, ``beat_index_at``, etc.) live on
    this instance. Detectors that emit grid-aligned output should call
    those instead of re-implementing the segment math.
    """

    audio: np.ndarray
    sr: int
    duration_ms: int
    stems: dict[str, np.ndarray]
    features: AudioFeatures
    energy_curve: np.ndarray
    tension_curve: np.ndarray
    bpm: float
    beat_times_ms: list[int]
    grid_offset_ms: int = 0
    time_signature: str = "4/4"
    beats_per_bar: int = 4
    grid_mode: GridMode = "static"
    tempo_anchors: tuple[TempoAnchor, ...] = ()

    # ─── Anchor-aware grid helpers ───────────────────────────────────────

    def _bounding_anchor_index(self, t_ms: int) -> int:
        """Index of the latest anchor with ``timestamp_ms <= t_ms``, or
        -1 when ``t_ms`` is before the first anchor / no anchors."""
        idx = -1
        for i, a in enumerate(self.tempo_anchors):
            if a.timestamp_ms <= t_ms:
                idx = i
            else:
                break
        return idx

    def bpm_at(self, t_ms: int) -> float:
        """Local tempo (BPM) at time ``t_ms``. Falls back to ``self.bpm``
        when ``t_ms`` is before the first anchor or no anchors exist."""
        i = self._bounding_anchor_index(t_ms)
        return self.tempo_anchors[i].bpm if i >= 0 else self.bpm

    def beat_index_at(self, t_ms: int) -> int:
        """Cumulative integer beat index from origin to ``t_ms``. Bar
        numbering stays continuous across anchors (segment math sums up
        integer beat counts per segment, then floor-divides inside the
        bounding segment)."""
        i = self._bounding_anchor_index(t_ms)
        if i < 0 or not self.tempo_anchors:
            if self.bpm <= 0:
                return 0
            return int((t_ms - self.grid_offset_ms) / (60000.0 / self.bpm))
        # Sum integer beats of completed earlier segments.
        cum = int(round((self.tempo_anchors[0].timestamp_ms - self.grid_offset_ms) / (60000.0 / self.bpm))) if self.bpm > 0 else 0
        if cum < 0:
            cum = 0
        for k in range(i):
            d_beat = 60000.0 / self.tempo_anchors[k].bpm
            cum += max(0, int(round((self.tempo_anchors[k + 1].timestamp_ms - self.tempo_anchors[k].timestamp_ms) / d_beat)))
        anchor = self.tempo_anchors[i]
        return cum + int((t_ms - anchor.timestamp_ms) / (60000.0 / anchor.bpm))

    def snap_to_beat_ms(self, t_ms: int) -> int:
        """Snap ``t_ms`` to the nearest beat boundary using the local
        segment's tempo (or the global bpm before the first anchor)."""
        i = self._bounding_anchor_index(t_ms)
        if i < 0:
            if self.bpm <= 0:
                return t_ms
            period = 60000.0 / self.bpm
            n = round((t_ms - self.grid_offset_ms) / period)
            return max(0, int(round(self.grid_offset_ms + n * period)))
        a = self.tempo_anchors[i]
        period = 60000.0 / a.bpm
        n = round((t_ms - a.timestamp_ms) / period)
        return max(0, int(round(a.timestamp_ms + n * period)))


# ─── Outputs ─────────────────────────────────────────────────────────────────


@dataclass
class Boundary:
    """A single boundary prediction.

    time_ms must be an integer in [0, duration_ms]. Any other value will
    cause this item to be rejected by the validator.
    """

    time_ms: int
    label: Optional[str] = None
    importance: Optional[Importance] = None
    candidates: Optional[list[int]] = None  # alternate ms times within tolerance


@dataclass
class Cue:
    """A single cue prediction: a labeled point in time.

    time_ms must be an integer in [0, ctx.duration_ms]. Use Cue for discrete
    events like kick hits, FX triggers, claps, or any single timestamped
    moment that does NOT partition the timeline the way a Boundary does.

    `candidates` carries alternative valid times in ms — during evaluation any
    candidate within tolerance counts as a hit. Mirrors Boundary.candidates,
    so a detector that can name two equally plausible timestamps for the same
    event (e.g. on-the-beat vs. anticipated-by-a-16th) doesn't have to pick
    one and lose evaluation credit on the other.
    """

    time_ms: int
    label: Optional[str] = None
    description: Optional[str] = None  # free-form longer note shown only in the editor
    intensity: Optional[float] = None  # in [0, 1]
    candidates: Optional[list[int]] = None  # alternate ms times within tolerance


@dataclass
class Span:
    """A labeled time interval. May overlap with other Spans on the same row.

    duration_ms must be > 0. start_ms + duration_ms must not exceed the
    track length. Any violation drops this item.

    Use Span (not Cue) for things with a non-zero extent: vocal-active
    regions, instrument-presence regions, filter sweeps, phrase boundaries.
    """

    start_ms: int
    duration_ms: int
    label: Optional[str] = None
    intensity: Optional[float] = None  # in [0, 1]


@dataclass
class Loop:
    """A grid-aware seamless-playback interval.

    Like Span but signals "this region works musically when played
    back-to-back on repeat" — N-bar phrases, drum loops, DJ pickups.

    `snap_zero_cross` is a UI hint: when True, the player snaps loop
    boundaries to the nearest audio zero-crossing to avoid clicks at the
    seam. Defaults to None (= UI decides).

    Gated by the experimentalLoopsAndPatterns flag — the registry filters
    out loop-emitting detectors when the flag is off.
    """

    start_ms: int
    duration_ms: int
    label: Optional[str] = None
    snap_zero_cross: Optional[bool] = None


@dataclass
class Pattern:
    """A short repeating motif that tiles across the track.

    `start_ms` + `duration_ms` describe ONE cycle; the renderer multiplies
    it `repeat_count` times. `highlighted_beats` carries 0-based step
    indices within one cycle (0 .. beats_per_bar * 4 - 1, since the UI
    uses 16th-note resolution) that are accented inside the pattern.

    Gated by the experimentalLoopsAndPatterns flag.
    """

    start_ms: int
    duration_ms: int
    label: Optional[str] = None
    repeat_count: int = 1
    highlighted_beats: Optional[list[int]] = None


# ─── Detector base class ─────────────────────────────────────────────────────


class CustomDetector:
    """Base class every user detector must subclass.

    Class attributes are the manifest. Implementations override `detect`.

    Required class attributes
    -------------------------
    name : str
        Identifier used as filename, registry key, and result-folder name.
        Must match ^[a-z][a-z0-9_-]{0,30}$. Must be unique across the registry.
    label : str
        Human-readable name shown in the UI (1-80 chars).
    output_kind : "boundary" | "cue" | "span" | "loop" | "pattern"
        Determines which dataclass detect() must return. `loop` and `pattern`
        are hidden from the registry when the `experimentalLoopsAndPatterns`
        Settings flag is off, mirroring the UI gating for those annotation
        types.

    At least one of `is_algorithm` / `is_annotation` must be True.
    """

    # Identity (required)
    name: str = ""
    label: str = ""
    output_kind: OutputKind = "boundary"

    # Surfacing
    is_algorithm: bool = True
    is_annotation: bool = False

    # Optional metadata
    description: str = ""
    version: str = "0.1"

    def detect(
        self, ctx: DetectionContext
    ) -> list[Boundary] | list[Cue] | list[Span] | list[Loop] | list[Pattern]:
        raise NotImplementedError(
            "CustomDetector subclasses must implement detect(ctx)."
        )


# ─── Validation result types (used by loader/runner; not user-facing) ────────


@dataclass
class ValidationError:
    """One per rejected item or load-time problem.

    Surfaced verbatim to the user so they know exactly what went wrong.
    """

    index: Optional[int]   # item index when run-time, else None
    field: Optional[str]   # offending field name when known
    message: str
    value: Any = None

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "field": self.field,
            "value": _safe_repr(self.value),
            "message": self.message,
        }


@dataclass
class RegistryEntry:
    """One per `.py` file in tools/python/custom/.

    `status="ok"` means the file imported and the detector class validated.
    Everything else carries an `errors` list that the UI shows verbatim.
    """

    name: str                # detector.name OR file stem if load failed
    file: str                # absolute path to the source file
    status: Literal["ok", "load_error", "validation_error"]
    label: str = ""
    output_kind: OutputKind = "boundary"
    is_algorithm: bool = True
    is_annotation: bool = False
    description: str = ""
    version: str = ""
    errors: list[ValidationError] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "file": self.file,
            "status": self.status,
            "label": self.label,
            "output_kind": self.output_kind,
            "is_algorithm": self.is_algorithm,
            "is_annotation": self.is_annotation,
            "description": self.description,
            "version": self.version,
            "errors": [e.to_dict() for e in self.errors],
        }


def _safe_repr(value: Any) -> Any:
    """JSON-safe representation of arbitrary user values for error messages."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_safe_repr(v) for v in value[:8]]
    if isinstance(value, dict):
        return {str(k): _safe_repr(v) for k, v in list(value.items())[:8]}
    try:
        return repr(value)[:200]
    except Exception:
        return f"<unrepresentable {type(value).__name__}>"
