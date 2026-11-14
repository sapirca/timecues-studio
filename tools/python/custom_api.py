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
        stem        = "vocals"          # optional: source Demucs stem / "mix"

        def detect(self, ctx: DetectionContext) -> list[Boundary]:
            return [Boundary(time_ms=int(t * 1000)) for t in some_times]

The runner validates every field of every returned item. Items that fail
validation are dropped with a structured error; the rest are kept. An
exception inside detect() is caught and reported, never crashes the server.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Sequence

import numpy as np

# Re-export AudioFeatures so user scripts only need one import.
from shared.models import AudioFeatures  # noqa: F401

OutputKind = Literal["boundary", "cue", "span", "loop", "riff", "lyrics", "lanes"]
# The kinds a single lane holds — every output kind but "lanes" itself.
LANE_KINDS = ("boundary", "cue", "span", "loop", "riff", "lyrics")
Importance = Literal["critical", "optional"]

# The rate a span is hitting at, relative to the BEAT ("8th" = twice per beat),
# or "silent" for a stretch where nothing hits. Mirrors PULSE_OPTIONS in
# web-app/src/types/annotationLayer.ts, which is the source of truth.
PULSE_RATES = ("32nd", "16th-triplet", "16th", "8th-triplet", "8th", "beat", "bar", "silent")
PulseRate = Literal["32nd", "16th-triplet", "16th", "8th-triplet", "8th", "beat", "bar", "silent"]

# What one play of a riff node did — see RiffOccurrence.event. Mirrors
# RiffEvent in web-app/src/types/annotationLayer.ts.
RIFF_EVENTS = ("exact", "variation", "fill", "drop")
RiffEvent = Literal["exact", "variation", "fill", "drop"]

# The pulses a riff node can be written on, in steps per beat: sixteenths,
# eighths, quarters, and sixteenth / eighth triplets. Mirrors PULSE_OPTIONS in
# web-app/src/utils/pitchedRiff.ts.
RIFF_PULSES = (4, 2, 1, 6, 3)

# A sequence entry that plays nothing for its length.
RIFF_SILENCE = "__silence__"


# ─── Inputs ──────────────────────────────────────────────────────────────────


GridMode = Literal["static", "mapped", "manual"]


# The annotator's strictness for a detector that offers it: 0 (Strict) … 50
# (Normal) … 100 (Loose). The three names are the slider's two ends and its
# middle, and what results cached before the slider carry.
STRICTNESS_NAMES = {"strict": 0, "normal": 50, "loose": 100}
DEFAULT_STRICTNESS = 50


def strictness_level(value) -> int:
    """0..100 from a number, a numeric string, a name, or None (Normal).
    Raises ValueError on anything else."""
    if value is None or value == "":
        return DEFAULT_STRICTNESS
    if isinstance(value, str) and value in STRICTNESS_NAMES:
        return STRICTNESS_NAMES[value]
    try:
        level = float(value)
    except (TypeError, ValueError):
        level = math.nan
    if isinstance(value, bool) or not 0 <= level <= 100:
        raise ValueError(f"strictness must be 0-100 or one of {', '.join(STRICTNESS_NAMES)}")
    return int(round(level))


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
        The annotator's tempo from SongInfo. Never estimated: the runner
        refuses a song with no BPM, so every detector runs on a set grid.
    beat_times_ms
        Beat instants in milliseconds (sorted ascending): the ANNOTATOR'S grid,
        exactly as the app draws it — tempo splits, the pickup before bar 1 and
        hand-placed beats included. Cut at these and the result lands on the
        lines the annotator sees. There is no fallback grid.
    downbeat_times_ms
        Bar starts in milliseconds, on the same grid as ``beat_times_ms``.
    tracked_beat_times_ms
        The beats librosa tracked in the audio, whatever the grid says. For a
        detector that measures how the audio sits against the grid — never for
        cutting bars or sections.
    grid_source
        Always ``"user"``: the beats are the annotator's grid. Kept so older
        detectors that check it still read the grid.
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
    window_start_ms
        Where this context starts in the song; None for a whole-song run. On a
        window run (a detector with ``windowable = True``, run on a range the
        annotator highlighted) every other field describes ONLY that range,
        counted from zero: ``audio``, ``stems``, ``features`` and the curves
        are cut to it, ``duration_ms`` is its length, ``beat_times_ms`` and
        ``grid_offset_ms`` are relative to its start. Answer in those local
        times — the runner moves the items back into song time. A detector
        that reads the song's files itself must read them through
        ``stem_file()`` so it sees the same range.
    window_lead_ms
        On a window run, how much of the context comes BEFORE the range: the
        runner hands the detector a short lead-in so the cut is not heard as
        an attack, and drops anything found in it. The range itself starts at
        ``window_lead_ms`` in local time. 0 on a whole-song run.
    window_stems
        On a window run of a detector that declares ``stem_parts``: the stems
        the annotator asked it to read, a subset of ``stem_parts``' keys.
        Read only the parts those stems carry. None = every part.
    stem
        The stem THIS run is for: ``"vocals"``, ``"other"`` … or None for the
        whole mix. A detector that declares one stem sees that stem here; one
        that declares several (``stem = ["vocals", "other"]``) is run once per
        stem, each run with its own ``stem`` and its own lane, so ``detect()``
        reads ``ctx.stems[ctx.stem]`` and never needs to know the list.
    strictness
        0 (Strict) … 50 (Normal) … 100 (Loose) — how sure the detector must be
        before it reports something, as the annotator set it on a slider. Only
        a detector that declares ``strictness = True`` is offered the choice;
        every other one always sees 50. See ``strictness_level``.
    drum_source
        ``"auto"``, ``"kit"`` or ``"bands"`` — where the drums are read from,
        as the annotator picked it for a detector that declares
        ``drum_source = True`` (see ``generators.drum_hits``). Every other
        detector sees ``"auto"``.
    section_source
        ``"auto"``, ``"annotated"`` or ``"allin1"`` — where a detector that
        declares ``section_source = True`` reads the song's sections: the
        annotator's first boundaries layer, All-In-One, or (auto) the first
        where there is one, else the second. Every other detector sees
        ``"auto"``.
    switches
        ``{name: bool}`` for each switch a detector declares in ``switches``
        — whether the annotator ticked it for this song. Empty for every other
        detector.
    annotator
        Who asked for the run, when the run was asked for by someone — whose
        boundaries layer ``"annotated"`` sections are, and whose layers a
        ``reads_layers`` detector reads. None from a batch run.
    section_read
        Written by a ``section_source`` detector: which sections it actually
        read (``{"source": "annotated" | "allin1" | "none", "layer": ...}``).
        The runner saves it on the envelope, so the sidebar can say "Auto ·
        yours" the way it says which drums a lane was read from.

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
    downbeat_times_ms: list[int] = field(default_factory=list)
    tracked_beat_times_ms: list[int] = field(default_factory=list)
    grid_source: str = "user"
    grid_offset_ms: int = 0
    time_signature: str = "4/4"
    beats_per_bar: int = 4
    grid_mode: GridMode = "static"
    window_start_ms: Optional[int] = None
    window_lead_ms: int = 0
    window_stems: Optional[list[str]] = None
    strictness: int = 50
    drum_source: str = "auto"
    section_source: str = "auto"
    source: str = ""
    switches: dict = field(default_factory=dict)
    annotator: Optional[str] = None
    stem: Optional[str] = None
    # Caveats this run wants to raise. Written only through `warn()`.
    notes: list[dict] = field(default_factory=list)
    # Which sections a `section_source` detector read. Filled by the detector.
    section_read: dict = field(default_factory=dict)
    # What a `sources` detector actually read ({"source": name, …}) — on Auto,
    # which source Auto came to. Filled by the detector.
    source_read: dict = field(default_factory=dict)

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

    def stem_file(self, stem: str):
        """Context manager yielding the path of a stem's audio file for this
        run, or None when the song has no such stem on disk.

        For detectors whose analysis takes a file rather than ``ctx.stems``
        (a different sample rate, a generator shared with the batch tools).
        On a whole-song run it is the stem on disk; on a window run it is a
        temporary file holding only the window, so the file-based analysis
        answers about the same range as everything else in this context::

            with ctx.stem_file("bass") as path:
                result = analyse(path)
        """
        from contextlib import nullcontext

        from paths import stem_audio

        path = stem_audio(self.slug, stem)
        if path is None or self.window_start_ms is None:
            return nullcontext(path)
        from server_common import trimmed_audio

        start = self.window_start_ms / 1000
        return trimmed_audio(path, start, start + self.duration_ms / 1000)

    def _user_beats(self) -> Optional[list[int]]:
        return self.beat_times_ms if self.grid_source == "user" and len(self.beat_times_ms) >= 2 else None

    def _beat_position(self, t_ms: float) -> float:
        """Fractional position of ``t_ms`` in ``beat_times_ms``: 3.5 is halfway
        from beat 3 to beat 4. Past either end the edge gap carries on."""
        b = self.beat_times_ms
        i = min(max(bisect.bisect_right(b, t_ms) - 1, 0), len(b) - 2)
        return i + (t_ms - b[i]) / max(1e-9, b[i + 1] - b[i])

    def bpm_at(self, t_ms: int) -> float:
        """Local tempo (BPM) at time ``t_ms`` — the gap between the grid's
        beats around it, so a tempo split or a hand-placed beat is followed."""
        b = self._user_beats()
        if b is None:
            return self.bpm
        i = min(max(bisect.bisect_right(b, t_ms) - 1, 0), len(b) - 2)
        return 60000.0 / max(1e-9, b[i + 1] - b[i])

    def beat_index_at(self, t_ms: int) -> int:
        """Cumulative integer beat index from the grid origin (bar 1, beat 1)
        to ``t_ms``; negative in the pickup before it."""
        b = self._user_beats()
        if b is None:
            if self.bpm <= 0:
                return 0
            return int((t_ms - self.grid_offset_ms) / (60000.0 / self.bpm))
        origin = round(self._beat_position(self.grid_offset_ms))
        return int(math.floor(self._beat_position(t_ms) + 1e-9)) - origin

    def snap_to_beat_ms(self, t_ms: int) -> int:
        """Snap ``t_ms`` to the nearest beat of the grid."""
        b = self._user_beats()
        if b is None:
            if self.bpm <= 0:
                return t_ms
            period = 60000.0 / self.bpm
            n = round((t_ms - self.grid_offset_ms) / period)
            return max(0, int(round(self.grid_offset_ms + n * period)))
        i = bisect.bisect_left(b, t_ms)
        if 0 < i < len(b):
            return int(b[i] if b[i] - t_ms < t_ms - b[i - 1] else b[i - 1])
        pos = round(self._beat_position(t_ms))
        edge = (b[0], b[1]) if i == 0 else (b[-2], b[-1])
        step = edge[1] - edge[0]
        base_idx = 0 if i == 0 else len(b) - 1
        return max(0, int(round(b[base_idx] + (pos - base_idx) * step)))


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
    color: Optional[str] = None  # "#rrggbb", overrides the lane colour for this section


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
    color: Optional[str] = None  # "#rrggbb", overrides the lane colour for this span
    # Longer free-form note, shown only in the editor. A span whose description
    # is an ⚡ Energy export (JSON, "type": "energy_span") draws its measured
    # envelope instead of a plain band.
    description: Optional[str] = None
    # The rate this stretch hits at — one of PULSE_RATES. Sets the span's Pulse
    # field, so the lane draws its ticks off the song's grid.
    pulse: Optional[PulseRate] = None


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
    color: Optional[str] = None  # "#rrggbb", overrides the lane colour for this loop


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

    `onsets`, on a word, says where each sound inside it begins: a list of
    `(time_ms, text)` in [time_ms, end_ms], `text` the syllable sung there or
    None for an attack no syllable was laid on. A word holds one time; a sung
    `a-la-ta` begins three times, and this is where the other two live.

    `envelope`, on a word, is the sound's whole life as attack, decay, sustain
    and release: a dict of ints `start_ms <= peak_ms <= decay_end_ms <=
    release_ms <= end_ms` (start and end may lie outside the word's own span —
    a sound rises before it is loud and rings on after), plus `peak_db` (the
    peak's level, dBFS) and `sustain_db` (the sustain's level relative to the
    peak, or None for a sound that decays straight into its release).
    """

    time_ms: int
    text: str
    kind: str = "word"  # "word" | "line"
    end_ms: Optional[int] = None
    source: Optional[str] = None
    onsets: Optional[list] = None
    envelope: Optional[dict] = None


@dataclass
class RiffNote:
    """One note of a riff node: it sounds over `[start, end)`, in beats from
    the node's start, and both edges sit on the node's pulse. `note` is its
    MIDI pitch (0-127, 60 = middle C) when it has one — a bass line, a riff —
    and `label` what to call it ("C1", "ghost"). `accent` is how hard it is
    struck, 1..127 (MIDI velocity); leave it None for full strength.

    Notes of one node never overlap. The rests between them are implied: the
    runner fills every gap with a rest, so the node's blocks tile its length.
    """

    start: float
    end: float
    label: Optional[str] = None
    note: Optional[int] = None
    accent: Optional[int] = None


@dataclass
class RiffNode:
    """A figure, written once: its notes on its own pulse.

    `subbeats_per_beat` is the pulse — 4 (sixteenths), 2, 1, or 6 / 3 for
    triplets (RIFF_PULSES). `steps_per_cycle` is the node's length in those
    steps, so a 1-bar 4/4 node on sixteenths is 16 and a 2-bar one 32.

    `id` is how sequences point at it, unique within the riff. `names` are
    what a musician would call the figure ("four on the floor"), when it has
    a name. `color` ("#rrggbb") is the colour it is drawn in; None lets the app
    pick one.
    """

    id: str
    name: str
    steps_per_cycle: int
    notes: list[RiffNote]
    subbeats_per_beat: int = 4
    color: Optional[str] = None
    names: Optional[list[str]] = None


@dataclass
class RiffEntry:
    """One step of a sequence: a node (or combo) by id, or RIFF_SILENCE, and
    how long it plays, in sixteenths (four to the beat) whatever the node's
    own pulse — so a 1-bar node fills 16, a 1-bar triplet node 16 too."""

    type: str
    length_steps: int


@dataclass
class RiffCombo:
    """A named run of nodes (A A B), placed by items like a node is."""

    id: str
    name: str
    sequence: list[RiffEntry]
    color: Optional[str] = None


@dataclass
class RiffOccurrence:
    """One play of an item that differed from its node — the same node,
    played differently once. Never a node of its own: "the fourth A drops the
    kick" is A with one note missing.

    `index` counts plays from 0 across every repeat of the item's sequence:
    repeat `r` of a sequence of `n` entries plays entry `e` as `r * n + e`.
    `added` are the notes the play struck that the node does not have, in the
    node's beats; `missing` the starts (beats) of the node's notes it left
    out. `event`: "fill" (only added), "drop" (nothing struck), "variation"
    (anything else).
    """

    index: int
    event: RiffEvent
    added: Optional[list[RiffNote]] = None
    missing: Optional[list[float]] = None


@dataclass
class RiffItem:
    """Where a riff plays: from `start` (seconds), its sequence played
    `repeat_count` times end to end. `end` is where the FIRST cycle ends
    (seconds), not the last — the cycle is `end - start` long.

    `occurrences` lists the plays that differed from their node; a play not
    listed plays its node exactly."""

    start: float
    end: float
    sequence: list[RiffEntry]
    repeat_count: int = 1
    label: str = ""
    occurrences: Optional[list[RiffOccurrence]] = None


@dataclass
class Riff:
    """What a detector whose `output_kind` is "riff" returns: one riff lane,
    in the shape a Riff Patterns layer has in the app and in the export —
    a library of nodes (and combos), and the items that place them.

    A groove of several drums is one Riff per drum (a "lanes" detector with a
    lane each), each saying which drum it is in `drum` ("kick", "snare",
    "hat" …). `summary` is the lane's big picture in one line, when the
    detector has one.

    Gated by the experimentalLoopsAndPatterns flag.
    """

    nodes: list[RiffNode]
    items: list[RiffItem]
    combos: list[RiffCombo] = field(default_factory=list)
    drum: Optional[str] = None
    summary: Optional[str] = None


@dataclass
class Lane:
    """One lane of a detector whose `output_kind` is "lanes".

    A detector that reads one thing several ways — each instrument's notes AND
    its loop — returns a list of these instead of one list of items, and the
    app draws each as its own lane, as though it came from a detector of its
    own kind. `id` is the lane's name within the detector (same rule as a
    detector name), unique per run; `label` is what the lane is called;
    `output_kind` is any kind but "lanes"; `items` are that kind's dataclasses
    (for a "riff" lane, one `Riff`), validated exactly as a single-kind
    detector's are. Lanes sharing a `group`
    are drawn in one band, so "Kick" can hold the kick's notes and its loop.

    A "lanes" detector may offer `strictness`, run per stem (`stem` a list),
    run on a section (`windowable`; a section run is merged lane by lane, into
    the cached lane with the same id, so it may return only the lanes it can
    read from the section) and set `is_annotation` (each lane with a layer to
    copy into is copied). It has no `review` and no `stem_parts`: those act on
    one list of items.
    """

    id: str
    label: str
    output_kind: str
    items: list
    group: Optional[str] = None


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
    output_kind : "boundary" | "cue" | "span" | "loop" | "riff" | "lyrics" | "lanes"
        Determines which dataclass detect() must return — for "riff", one
        `Riff`; for "lanes", a list of `Lane`, each holding one of the other
        kinds. `loop` and `riff`
        are hidden from the registry when the `experimentalLoopsAndPatterns`
        Settings flag is off, mirroring the UI gating for those annotation
        types.

    Every registered detector shows in Algorithm Inspect: listed in the
    Detectors sidebar, runnable from there, its output drawn as a read-only
    lane. The two optional flags below only change what happens on top of that.
    """

    # Identity (required)
    name: str = ""
    label: str = ""
    output_kind: OutputKind = "boundary"

    # Optional: when an annotator runs this detector on a song, also copy its
    # output into a new layer of their own annotation — what the lane's ⬇ does
    # by hand. Once per annotator: a re-run leaves an existing copy alone, so
    # edits made to it are never overwritten. Off by default — the output is a
    # proposal, and the annotator decides whether to adopt it.
    is_annotation: bool = False

    # Optional: put a ✓/✗ on every item this detector draws, so the annotator
    # accepts or rejects each one (rejected items stay behind when the lane is
    # copied into a layer). Off by default — a detector's lane then shows its
    # items plainly, and the lane's ⬇ copy is the only approval gesture.
    review: bool = False

    # Optional metadata
    description: str = ""
    version: str = "0.1"

    # Optional: the Demucs stem this detector reads from — "vocals", "drums",
    # "bass", "other", "guitar", "piano", "mix" for detectors that read the
    # whole track (with or without help from the stems), or "stems" for one
    # lane read from several stems and never the full mix (Pulse).
    # Surfaced to the UI so a layer's lane label can show its source stem (e.g.
    # "Vocals presence (vocals)") instead of a generic "(curated)" tag, and so
    # layers light up while that stem is auditioned. None leaves the label
    # untouched.
    #
    # A list runs the detector once per stem: `stem = ["vocals", "other"]`
    # registers `<name>__vocals` and `<name>__other`, each with its own lane
    # under its own stem, and each run is told its stem in `ctx.stem`. "mix"
    # in a list keeps the bare `<name>`. The same `<algo>__<stem>` id the
    # built-in algorithms use for a per-stem run.
    stem: Optional[str | list[str]] = None

    # Optional: logical family/group shown as a sub-heading in the Detectors
    # sidebar (e.g. "Band", "EDM", "Instruments"). Detectors that share a group
    # are clustered together within their stem section. None means ungrouped.
    group: Optional[str] = None

    # Optional: can run on just a highlighted range of the song. Set it only
    # when detect() reads nothing but this context — ctx.audio, ctx.stems, the
    # features and grid, and stem files through ctx.stem_file() — because on
    # a window run those hold only the range, while anything read straight
    # off disk by ctx.slug is still the whole song and would answer about it.
    # Off by default: a detector that cannot honour the range is never
    # offered one, rather than quietly answering about the whole song.
    windowable: bool = False

    # Optional: for a detector whose one lane holds several parts, each read
    # from its own stem (Pulse: kick / snare / hat from the drums, then bass,
    # other ... each on its own) — stem → the label prefixes its items start
    # with, e.g. {"drums": ["Kick", "Snare", "Hat"], "bass": ["Bass"]}. It
    # lets a section run read only some stems (ctx.window_stems), and a
    # Replace remove only those parts' items. A label starts with a prefix
    # when it is the prefix or continues with " · ".
    stem_parts: Optional[dict[str, list[str]]] = None

    # Optional: offers the annotator Strict / Normal / Loose, read from
    # ctx.strictness. Set it only when those three mean something to the
    # detector — how much evidence it needs before it reports an item — and
    # Normal is what it reports without the choice.
    strictness: bool = False

    # Optional: offers the annotator where the drums are read from — Auto (the
    # separated kit where the song has been split, the drums stem's three
    # bands otherwise), Separated kit, or Bands — for a detector whose output
    # comes from `generators.drum_hits`. The runner applies it to every read in
    # the run (`drum_hits.reading`); ctx.drum_source says which was asked for.
    drum_source: bool = False

    # Optional: offers the annotator where the song's sections come from —
    # Auto (their boundaries, else All-In-One), Annotated, or All-In-One —
    # read from ctx.section_source. The detector reads the sections itself and
    # says which it read in ctx.section_read.
    section_source: bool = False

    # Optional: reads the annotator's own layers off disk (ANNOTATION_LAYERS_DIR
    # /<annotator>/<slug>.json) — ctx.annotator says whose, None from a batch
    # run. Reading by slug, such a detector is not windowable.
    reads_layers: bool = False

    # Optional: where the detector reads its input from, offered to the
    # annotator as a picker on its sidebar row — {name: (label, hint)}, or
    # (label, hint, group) to show it under a heading with the others of its
    # group, in the order shown; the first is the default. The pick arrives as ctx.source;
    # the detector says what it actually read in ctx.source_read (on an Auto,
    # which source Auto came to), and the sidebar pill shows it ("Auto · Yours").
    sources: Optional[dict[str, tuple[str, str]]] = None

    # Optional, with `sources`: a layer type ("lyrics"). The picker then also
    # lists each of the annotator's lanes of that type on the song, by name, as
    # the source `lane:<layer id>` — so one lane can be read, not only all of
    # them. The detector finds that layer in the annotator's document.
    lane_sources: Optional[str] = None

    # Optional: a method `measure(self, slug, body) -> dict` answers a question
    # about items the annotator sends (POST /api/custom-scripts/measure/<name>)
    # — the words of one lyrics lane, say — without running on the song. A
    # ValueError's message goes back to the annotator. See custom_runner.measure.

    # Optional: yes/no facts about the song the annotator ticks on this
    # detector's row, as {name: label} — {"bass_leads": "The bass leads this
    # song"}. They live with the detector's result for that song (a run that
    # names none keeps the last result's), and are read from ctx.switches.
    switches: dict = {}

    def detect(
        self, ctx: DetectionContext
    ) -> list[Boundary] | list[Cue] | list[Span] | list[Loop] | Riff | list[Lane]:
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
    is_annotation: bool = False
    description: str = ""
    version: str = ""
    stem: Optional[str] = None
    group: Optional[str] = None
    review: bool = False
    windowable: bool = False
    stem_parts: Optional[dict[str, list[str]]] = None
    strictness: bool = False
    drum_source: bool = False
    section_source: bool = False
    switches: Optional[dict[str, str]] = None
    # [{"name", "label", "hint"}] in order — see CustomDetector.sources.
    sources: Optional[list[dict[str, str]]] = None
    lane_sources: Optional[str] = None
    # The detector's own `name` as written in its file, and every stem it
    # declares. A detector declaring several stems is registered once per stem
    # (`name` is then `<base_name>__<stem>`, `stem` that one stem); these two
    # are how the editor folds the entries back into the one file they share.
    base_name: str = ""
    stems: Optional[list[str]] = None
    # True for a shipped file in custom-default/; the UI titles the two
    # folders apart ("Default" vs "Custom").
    is_default: bool = False
    # The package folder the file sits in (`custom/<package>/<file>.py`) and
    # that package's title from its package.json. None for a loose file at the
    # top of custom/ or custom-default/.
    package: Optional[str] = None
    package_title: Optional[str] = None
    # Archived from the Playground (custom/archived.json): its file stays where
    # it is and the Playground still opens it, but the registry leaves it out
    # of every other list, of "every detector" runs and of its package's zip.
    archived: bool = False
    errors: list[ValidationError] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "file": self.file,
            "status": self.status,
            "label": self.label,
            "output_kind": self.output_kind,
            "is_annotation": self.is_annotation,
            "description": self.description,
            "version": self.version,
            "stem": self.stem,
            "group": self.group,
            "review": self.review,
            "windowable": self.windowable,
            "stem_parts": self.stem_parts,
            "strictness": self.strictness,
            "drum_source": self.drum_source,
            "section_source": self.section_source,
            "sources": self.sources,
            "lane_sources": self.lane_sources,
            "switches": self.switches,
            "base_name": self.base_name or self.name,
            "stems": self.stems,
            "is_default": self.is_default,
            "package": self.package,
            "package_title": self.package_title,
            "archived": self.archived,
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
