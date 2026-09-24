"""Curated grids → ground-truth beat and downbeat times.

A curated song-info IS beat annotation, just stored as a rule rather than a
list: `gridOffset` + `bpm` + `timeSignature`, plus a `gridSegments` entry for
every point where the count restarts. Expanding that rule back into the beat
times it describes turns the corpus into a labelled evaluation set for free —
no new annotation pass, no second source of truth to keep in sync.

That is the point of this module. Published beat-tracker F-measures are
measured on Ballroom, GTZAN, Hainsworth and friends; none of those is EDM,
and the one EDM evaluation that exists (Raveform, TISMIR 2025) found madmom's
downbeat F1 falling from 0.805 on pop to 0.669 on EDM while its beat F1
stayed at 0.947. Numbers from other people's genres do not predict behaviour
on this corpus, so we measure on ours.

Mirror of resolveGridSegments() in web-app/src/utils/gridSegments.ts. The
rules that matter here:

  * The opening segment is NOT stored. It is the song's own gridOffset / bpm
    / timeSignature, so a song with no splits expands exactly as it did
    before segments existed.
  * Each segment starts on ITS OWN bar 1, beat 1.
  * The outgoing segment is cut wherever the split lands. A bar that got
    three and a half of its four beats is the normal outcome and is never
    rounded up — doing so would invent a downbeat the curator did not place.

Ground truth is only as good as the grid it comes from, so `is_trustworthy`
reports whether a song's grid was actually curated or is still sitting at an
untouched default. Scoring a tracker against a default grid measures nothing.
"""

from __future__ import annotations

# Mirror of TIME_SIGNATURES_TO_BEATS in web-app/src/utils/beatGrid.ts.
TIME_SIGNATURES_TO_BEATS = {
    "4/4": 4, "3/4": 3, "6/8": 6, "5/4": 5, "7/8": 7, "2/4": 2, "12/8": 12,
}


def beats_per_bar(time_signature: "str | None") -> int:
    """Beats per bar for a time signature, defaulting to 4 like the UI does."""
    if not time_signature:
        return 4
    if time_signature in TIME_SIGNATURES_TO_BEATS:
        return TIME_SIGNATURES_TO_BEATS[time_signature]
    head = time_signature.split("/")[0]
    try:
        num = int(head)
    except (TypeError, ValueError):
        return 4
    return num if num > 0 else 4


def segments_are_active(info: dict) -> bool:
    """Do this song's stored splits actually apply to its grid?

    They do NOT always. Splits are inert outside Mapped mode — the UI keeps
    them on disk so switching modes never destroys work, which means a song
    can carry twenty segments while rendering as one steady grid. Reading
    them regardless produces ground truth for a grid the app never draws.

    This is not hypothetical: toast3d_peter_the_wolf stores 20 segments with
    gridMode 'static'. Applying them scored every tracker at ~0.39 on a song
    where they actually agree, which reads as four failing trackers rather
    than one wrong reference. Mirrors resolveGridSegments() in
    web-app/src/utils/gridSegments.ts.
    """
    mode = info.get("gridMode") or "static"
    if mode == "mapped":
        return True
    if mode == "manual" and (info.get("manualBaseGridMode") or "") == "mapped":
        return True
    return False


def resolve_segments(info: dict) -> "list[dict]":
    """The song's grid as a run of segments laid end to end.

    Returns [{start, end, bpm, time_signature, beats_per_bar}] with `end`
    being the next segment's start, or None for the last one (the caller
    closes it with the audio duration).
    """
    opening = {
        "start":          float(info.get("gridOffset") or 0.0),
        "bpm":            float(info.get("bpm") or 0.0),
        "time_signature": info.get("timeSignature") or "4/4",
    }

    stored = []
    for seg in (info.get("gridSegments") or []) if segments_are_active(info) else []:
        try:
            start = float(seg["start"])
            bpm = float(seg["bpm"])
        except (KeyError, TypeError, ValueError):
            continue
        if bpm <= 0:
            continue
        stored.append({
            "start":          start,
            "bpm":            bpm,
            "time_signature": seg.get("timeSignature") or "4/4",
        })

    # Only splits strictly after the opening are real; the UI enforces this
    # on write, but a hand-edited file need not have.
    stored = sorted((s for s in stored if s["start"] > opening["start"]),
                    key=lambda s: s["start"])

    segments = [opening] + stored
    for seg, nxt in zip(segments, segments[1:]):
        seg["end"] = nxt["start"]
    segments[-1]["end"] = None
    for seg in segments:
        seg["beats_per_bar"] = beats_per_bar(seg["time_signature"])
    return segments


def expand(info: dict, duration: float) -> "tuple[list[float], list[float]]":
    """Expand a curated grid into (beat_times, downbeat_times) in seconds.

    Every segment restarts the bar count, so its first beat is a downbeat by
    definition — that is what a split MEANS in this model, and it is the
    single most important thing for a tracker to get right on a genre whose
    tempo never moves.
    """
    beats: "list[float]" = []
    downbeats: "list[float]" = []

    for seg in resolve_segments(info):
        bpm = seg["bpm"]
        if bpm <= 0:
            continue
        beat_dur = 60.0 / bpm
        end = seg["end"] if seg["end"] is not None else duration
        end = min(float(end), float(duration))
        per_bar = seg["beats_per_bar"]

        i = 0
        while True:
            t = seg["start"] + i * beat_dur
            # Strictly before `end`: the next segment owns its own start, so
            # emitting a beat there too would double the downbeat at a split.
            if t >= end - 1e-9 or t > duration:
                break
            if t >= 0:
                beats.append(t)
                if i % per_bar == 0:
                    downbeats.append(t)
            i += 1

    return beats, downbeats


# A grid still sitting at every default was never curated: scoring a tracker
# against it measures the defaults, not the music. 120 BPM at offset 0 in 4/4
# with no splits is what a song looks like before anyone has touched it.
_UNTOUCHED = {"bpm": 120.0, "gridOffset": 0.0, "timeSignature": "4/4"}


def is_trustworthy(info: dict) -> "tuple[bool, str]":
    """Is this grid worth scoring against? Returns (ok, reason-if-not).

    Deliberately conservative about what counts as evidence of curation. A
    non-default BPM or a non-zero offset means somebody set it; splits mean
    somebody worked on it properly. Everything else is refused with a reason
    rather than silently producing a confident, meaningless score.
    """
    bpm = float(info.get("bpm") or 0.0)
    if bpm <= 0:
        return False, "no BPM set"

    # Two grid shapes this module does not model. Refusing is the honest
    # answer: a wrong reference makes every tracker look broken, which is a
    # more expensive mistake than one missing row in the table.
    mode = info.get("gridMode") or "static"
    if mode == "dynamic" and info.get("tempoAnchors"):
        return False, "Drifting grid — tempoAnchors are not expanded here"
    if info.get("beatOverrides"):
        return False, "Hand-placed grid — per-beat overrides are not expanded here"

    has_splits = bool(info.get("gridSegments")) and segments_are_active(info)
    offset = float(info.get("gridOffset") or 0.0)
    ts = info.get("timeSignature") or "4/4"

    if has_splits:
        return True, ""
    if (abs(bpm - _UNTOUCHED["bpm"]) < 1e-9
            and abs(offset) < 1e-9
            and ts == _UNTOUCHED["timeSignature"]):
        return False, "grid is still at the untouched default (120 BPM, offset 0, 4/4)"
    if abs(offset) < 1e-9 and bpm == round(bpm):
        # A whole-number BPM at offset exactly 0 is the shape of "typed the
        # tempo in, never aligned the downbeat". The beats are plausible; the
        # PHASE is not, and phase is most of what we are measuring.
        return True, "offset is exactly 0 — downbeat may never have been aligned"
    return True, ""
