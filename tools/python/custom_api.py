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
        stem        = "vocals"          # optional: source Demucs stem / "mix"

        def detect(self, ctx: DetectionContext) -> list[Boundary]:
            return [Boundary(time_ms=int(t * 1000)) for t in some_times]

The runner validates every field of every returned item. Items that fail
validation are dropped with a structured error; the rest are kept. An
exception inside detect() is caught and reported, never crashes the server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Sequence

import numpy as np

# Re-export AudioFeatures so user scripts only need one import.
from shared.models import AudioFeatures  # noqa: F401

OutputKind = Literal["boundary", "cue", "span", "loop", "pattern", "lyrics"]
Importance = Literal["critical", "optional"]


# ─── Inputs ──────────────────────────────────────────────────────────────────


GridMode = Literal["static", "mapped", "manual"]


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
    slug
        The song slug being analyzed. Lets a detector locate the song's
        other cached artifacts on disk (e.g. first-party generators that
        combine raw algorithm caches). Empty string when unknown.
    grid_offset_ms
        Time of bar 1 / beat 1 in milliseconds (from SongInfo.gridOffset).
    time_signature
        Time signature string from SongInfo (e.g. ``"4/4"``).
    beats_per_bar
        Numerator of the time signature, pre-parsed for convenience.
    grid_mode
        ``"static"`` / ``"mapped"`` / ``"manual"`` from SongInfo.gridMode.

    Grid helpers (``bpm_at``, ``beat_index_at``, ``snap_to_beat_ms``) live
    on this instance. Detectors that emit grid-aligned output should call
    those instead of re-implementing the beat math.
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
    slug: str = ""
    grid_offset_ms: int = 0
    time_signature: str = "4/4"
    beats_per_bar: int = 4
    grid_mode: GridMode = "static"
    # Caveats this run wants to raise. Written only through `warn()`.
    notes: list[dict] = field(default_factory=list)

    # ─── Reporting ───────────────────────────────────────────────────────

    def warn(self, code: str, message: str) -> None:
        """Record a caveat about THIS run. Does not fail it.

        For the case a detector has no other way to report: it ran, it
        produced items, and it does not trust them. An error means an item was
        rejected and a fatal means nothing ran — neither can say "here is your
        groove, and the stem it came from has no hi-hats in it to have heard".
        Without that the only honest output would be no output, which throws
        away the two thirds that are fine.

        Duplicate codes collapse, so a per-hit check can call this in a loop.
        """
        code = str(code)
        if any(n.get("code") == code for n in self.notes):
            return
        self.notes.append({"code": code, "message": str(message)})

    # ─── Grid helpers ────────────────────────────────────────────────────

    def bpm_at(self, t_ms: int) -> float:
        """Local tempo (BPM) at time ``t_ms``."""
        return self.bpm

    def beat_index_at(self, t_ms: int) -> int:
        """Cumulative integer beat index from the grid origin to ``t_ms``."""
        if self.bpm <= 0:
            return 0
        return int((t_ms - self.grid_offset_ms) / (60000.0 / self.bpm))

    def snap_to_beat_ms(self, t_ms: int) -> int:
        """Snap ``t_ms`` to the nearest beat boundary."""
        if self.bpm <= 0:
            return t_ms
        period = 60000.0 / self.bpm
        n = round((t_ms - self.grid_offset_ms) / period)
        return max(0, int(round(self.grid_offset_ms + n * period)))


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

    `velocity`, `level_db` and `color` are for cues that are STRUCK — drum
    hits, plucks, anything with a loudness of its own. They answer two
    different loudness questions, so a detector reports whichever it can:

      * `velocity` (1-127, MIDI-shaped) is how hard this hit was struck
        against the hardest hit of the same instrument. A full-force hi-hat is
        127 even though it is far quieter than any kick. The lane draws the
        tick this tall, so a ghost note is a stub.
      * `level_db` (<= 0) is the hit's actual level against the loudest hit in
        the track — the number that IS comparable across instruments.

    `color` (``"#rrggbb"``) paints this one tick, overriding the lane's colour
    — e.g. one hue per drum, so a dense lane of kicks, snares and hats still
    reads at a glance. Unlike `intensity`, none of the three is a confidence.

    Three more, just as optional:

      * `note` (0-127, MIDI note number; 60 = middle C) is the pitch of the
        hit — a bass pluck, a synth stab, a tuned tom. With `velocity` it is
        everything a MIDI note-on needs.
      * `decay_ms` (> 0) is how long the hit rings before it has faded. A cue
        is still a point in time; this says whether it is a flash or a swell,
        and the lane draws it as a faint tail after the tick.
      * `importance` (``"critical"`` / ``"optional"``) is the same star a
        hand-placed cue carries — e.g. downbeat kicks critical, fills optional.
    """

    time_ms: int
    label: Optional[str] = None
    description: Optional[str] = None  # free-form longer note shown only in the editor
    intensity: Optional[float] = None  # in [0, 1]
    candidates: Optional[list[int]] = None  # alternate ms times within tolerance
    velocity: Optional[int] = None  # 1-127, against the same instrument's hardest hit
    level_db: Optional[float] = None  # <= 0, against the loudest hit in the track
    color: Optional[str] = None  # "#rrggbb", overrides the lane colour for this tick
    note: Optional[int] = None  # 0-127 MIDI note number (60 = middle C)
    decay_ms: Optional[int] = None  # > 0, how long the hit rings
    importance: Optional[Importance] = None  # "critical" | "optional"


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
class Lyrics:
    """A word- or line-level lyric timestamp.

    `time_ms` must be an int in [0, ctx.duration_ms]. `text` is required and
    non-empty. `kind` is "word" (a single sung word) or "line" (a sung
    line/phrase). `end_ms`, when set, marks the end of the word/line and must
    be in [time_ms, ctx.duration_ms]; word-level entries from coarse models
    may leave it None.

    Mirrors the TypeScript ``LyricsItem`` (web-app/src/types/annotationLayer.ts):
    seconds there, milliseconds here. Gated by the experimentalLyricsFamily
    Settings flag on the UI side.

    `source` names which algorithm actually produced this timestamp (e.g.
    "whisper-base" or "ctc-forced-aligner") — provenance for the UI, since
    curated_lyrics prefers ctc-forced-aligner over whisper-base and silently
    falls back when the former hasn't been run.
    """

    time_ms: int
    text: str
    kind: str = "word"  # "word" | "line"
    end_ms: Optional[int] = None
    source: Optional[str] = None


@dataclass
class Pattern:
    """A short repeating motif that tiles across the track.

    `start_ms` + `duration_ms` describe ONE cycle; the renderer multiplies
    it `repeat_count` times. `highlighted_beats` carries 0-based step
    indices within one cycle that are accented inside the pattern.

    `steps_per_cycle` declares how many sub-steps the cycle is divided into —
    i.e. the index space of `highlighted_beats` (valid indices are
    `0 .. steps_per_cycle - 1`). Set it so the grid reflects YOUR cycle, not
    the song's bar: a 1-bar 4/4 cycle is 16 (16th-note resolution), a 2-beat
    cycle is 8, etc. When omitted, the UI falls back to `beats_per_bar * 4`.

    `spans` carries held runs of consecutive steps — each `[start_step,
    length]` with `length >= 2` — treated as one sustained accent (e.g. a note
    held across steps 2–4) rather than three separate ticks. A step is EITHER a
    lone `highlighted_beats` tick OR inside one span, never both; spans don't
    overlap. Omit / leave `None` for patterns with no holds.

    `rows` splits the cycle into named lines played at once — a drum groove is
    kick, snare and hat, not one undifferentiated list of hits. Each row carries
    its own `highlighted_beats` in the same index space, and optionally an
    `accents` list positionally paired with them (1..127, MIDI's range) saying
    how hard each of those steps is struck. A multi-row pattern should ALSO set
    the top-level `highlighted_beats` to the union of its rows, so a reader that
    only knows the single-row shape still draws the figure.

    `occurrences` describes each repeat that differs from the canonical cycle:
    a `deviation` in [0, 1] (0 = played exactly) plus the steps it `added` or
    was `missing`. Without it a repeating figure can only be reported as an
    average, and "this groove repeats eight times, and the fourth drops the
    hat" has nowhere to live.

    `motif` names the FIGURE, where `label` describes this one occurrence of
    it. Two patterns carrying the same motif are the same thing coming back —
    the verse groove returning in the drop — which is what lets a reader define
    the figure once and place it many times instead of emitting lookalike
    copies with nothing saying they are related. Keep it short and stable (a
    letter, a slug); the UI builds names from it.

    All optional; a single-row detector omits them and behaves as before.

    Gated by the experimentalLoopsAndPatterns flag.
    """

    start_ms: int
    duration_ms: int
    label: Optional[str] = None
    repeat_count: int = 1
    highlighted_beats: Optional[list[int]] = None
    spans: Optional[list[Sequence[int]]] = None
    steps_per_cycle: Optional[int] = None
    rows: Optional[list["PatternRow"]] = None
    occurrences: Optional[list["PatternOccurrence"]] = None
    motif: Optional[str] = None


@dataclass
class PatternRow:
    """One named line inside a multi-row Pattern (e.g. the kick of a groove).

    `highlighted_beats` uses the pattern's own `steps_per_cycle` index space.
    `accents` is positional against it — `accents[k]` is the velocity of
    `highlighted_beats[k]` — and may be omitted or shorter, in which case the
    unpaired steps are played at full strength.
    """

    row: str
    highlighted_beats: list[int]
    accents: Optional[list[int]] = None


@dataclass
class PatternOccurrence:
    """One repeat of a Pattern, and how it differed from the canonical cycle.

    `deviation` is 0.0 when the repeat plays the figure exactly. `added` and
    `missing` name the cells that differ as `{"row": <row name>, "step": <int>}`
    — row "" for a single-row pattern.
    """

    index: int
    start_ms: int
    deviation: float = 0.0
    added: Optional[list[dict]] = None
    missing: Optional[list[dict]] = None
    relabelled: Optional[list[dict]] = None


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
    output_kind : "boundary" | "cue" | "span" | "loop" | "pattern" | "lyrics"
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

    # Optional: the Demucs stem this detector reads from — "vocals", "drums",
    # "bass", "other", or "mix" for whole-track detectors. Surfaced to the UI so
    # a layer's lane label can show its source stem (e.g. "Vocals presence
    # (vocals)") instead of a generic "(curated)" tag, and so layers light up
    # while that stem is auditioned. None leaves the label untouched.
    stem: Optional[str] = None

    # Optional: logical family/group shown as a sub-heading in the Detectors
    # sidebar (e.g. "Band", "EDM", "Instruments"). Detectors that share a group
    # are clustered together within their stem section. None means ungrouped.
    group: Optional[str] = None

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
    stem: Optional[str] = None
    group: Optional[str] = None
    # True for a shipped file in custom-default/; the UI titles the two
    # folders apart ("Default" vs "Custom").
    is_default: bool = False
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
            "stem": self.stem,
            "group": self.group,
            "is_default": self.is_default,
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
