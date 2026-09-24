"""Turn a beat tracker's flat list of beats into grid SEGMENTS.

Every beat tracker — madmom, BeatNet, Beat This! — stops at the same place:
a list of beat times and a subset of them labelled downbeats. That is not a
grid. TimeCues' grid model is a small number of segments, each one a hard
restart carrying its own tempo and its own bar 1 (see `GridSegment` in
web-app/src/types/songInfo.ts). Going from four hundred beat timestamps to
"three segments at 138 BPM whose count restarts at 0:31 and 3:47" is the
step nothing upstream does, so it lives here.

Why the naive version is wrong
------------------------------
The obvious approach — cut wherever the inter-beat interval changes — is
useless on exactly the music that needs this. Electronic genres are
sequenced against a DAW click, so the tempo genuinely never moves; what
moves is the PHASE, because the arrangement was cut and reassembled after
rendering. So the interesting event is usually not "the tempo changed" but
"the tempo is identical and the downbeat landed somewhere it shouldn't."

And a naive cut fires constantly on a third case that is not an event at
all: a breakdown with no percussion, where the tracker simply emits nothing
for twenty seconds and then resumes perfectly on the original grid. The gap
looks enormous and means nothing.

So this module sorts every irregular interval into one of three things:

  tempo change   the interval settles at a NEW steady value and stays there
                 → a segment boundary, with a new BPM.
  phase shift    one bad interval, then the ORIGINAL tempo resumes, and the
                 gap is not a whole number of beats → a segment boundary at
                 the same BPM, existing only to re-anchor bar 1.
  dropout        the gap is a whole number of beats at the current tempo —
                 the tracker lost the beat and found it again, still on the
                 original grid → NOT a boundary. Bridged and ignored.

Pure stdlib on purpose: no numpy, no librosa. The caller has already done
the expensive part, and staying dependency-free means this is importable
from any sidecar or batch tool and unit-testable without a model install.
"""

from __future__ import annotations

from collections import Counter

# How far an inter-beat interval may stray from its segment's own median and
# still count as the same tempo. 2.5% is about 3.5 BPM at 138 — comfortably
# wider than a neural tracker's per-beat jitter on a sequenced track, and
# comfortably tighter than any tempo change a listener would call one.
TEMPO_TOLERANCE = 0.025

# ...but a purely relative tolerance is not enough, because trackers emit
# beat times on a fixed frame grid (Beat This! runs at 50 fps, so every
# timestamp is a multiple of 20 ms). A real 125 BPM track therefore comes
# back as intervals of 0.48, 0.48, 0.48, 0.48, 0.50, 0.48… — a 4% swing that
# is quantization, not music, and that a 2.5% relative tolerance reads as a
# phase shift on every fifth beat. This absolute floor absorbs it: two frames
# of slack per interval, which is the worst case when both endpoints of the
# interval round in opposite directions. It also sets the smallest
# displacement we are willing to call a grid restart at all — below ~45 ms
# nothing downstream could act on it anyway.
QUANTIZATION_SLACK = 0.045

# How many consecutive intervals must agree on a new value before we believe
# it is a tempo change rather than one mislocated beat. A tracker that drops
# a single beat produces one doubled interval; it cannot produce four in a
# row without the tempo having actually moved.
SUSTAIN_BEATS = 4

# A segment shorter than this is a tracker artifact, not a section of the
# song — it gets absorbed into its neighbour. Two bars of 4/4 at 138 BPM is
# ~3.5s, so 4s is a little under the shortest musically real restart.
MIN_SEGMENT_SECONDS = 4.0

# A dropout is only a dropout if the silent gap is a whole number of beats.
# This is the slack on that whole number, as a fraction of one beat: at 138
# BPM (0.435s/beat) 12% is ~52ms of accumulated drift permitted across the
# whole gap before we stop calling it "the same grid, resumed".
DROPOUT_PHASE_TOLERANCE = 0.12

# Tempi outside this band are not sections of a song, they are tracker
# artifacts: a burst of quadruple-triggered onsets during a fill reads as
# 428 BPM, and two isolated beats either side of a spoken-word pause read as
# 2 BPM. Both are real outputs we have seen on the corpus. The band is the
# usual MIR one (madmom's DBN searches 55-215) opened up slightly at both
# ends so a genuine half-time doom track or drum'n'bass edit still fits.
MIN_PLAUSIBLE_BPM = 40.0
MAX_PLAUSIBLE_BPM = 220.0

# How close two tempi must be to a 2x (or 4x) relationship before we call it
# a metrical-level flip rather than a tempo change. Trackers switch between
# half-time and full-time within one song — the beats are still on the same
# grid, they are just being counted at a different level, so cutting a
# segment there would be describing the tracker rather than the music.
OCTAVE_TOLERANCE = 0.06

# The longest dropout we will bridge, in beats. Past ~64 beats (16 bars of
# 4/4) the "same grid resumed" claim rests on too little evidence — a long
# ambient passage can drift audibly and still land near a beat multiple by
# chance, so we treat it as a real re-anchor instead.
MAX_DROPOUT_BEATS = 64


def _median(values: "list[float]") -> float:
    """Median of a non-empty list. (statistics.median allocates a sorted copy
    per call and this runs inside the per-beat loop; this stays cheap.)"""
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    return ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2.0


def _same_tempo(value: float, reference: float) -> bool:
    """Is `value` the same inter-beat interval as `reference`?

    Relative tolerance for real tempo differences, absolute floor for frame
    quantization — see QUANTIZATION_SLACK. A single relative test alone
    misreads a 50 fps tracker's dither as a grid restart on every fifth beat
    of a perfectly steady track.
    """
    if reference <= 0:
        return False
    return abs(value - reference) <= max(reference * TEMPO_TOLERANCE, QUANTIZATION_SLACK)


def _clean_times(times) -> "list[float]":
    """Sorted, de-duplicated, finite times. Trackers occasionally emit a
    repeated timestamp at a segment join; a zero interval would divide by
    zero downstream, so it is dropped rather than defended against later."""
    out: "list[float]" = []
    for t in times or ():
        try:
            v = float(t)
        except (TypeError, ValueError):
            continue
        if v != v or v in (float("inf"), float("-inf")):  # NaN / ±inf
            continue
        out.append(v)
    out.sort()
    deduped: "list[float]" = []
    for v in out:
        if not deduped or v - deduped[-1] > 1e-6:
            deduped.append(v)
    return deduped


def _classify_gap(gap: float, reference: float) -> str:
    """One irregular interval → 'dropout' | 'shift'.

    'dropout' means the gap is a whole number of beats at the current tempo:
    the tracker went quiet across a breakdown and came back on the same
    grid, so the phase never actually moved. Anything else is a genuine
    phase shift and earns a boundary.

    Note this is asked ONLY of gaps longer than the reference — a gap
    SHORTER than one beat can never be a whole number of them.
    """
    if reference <= 0:
        return "shift"
    beats = gap / reference
    nearest = round(beats)
    if nearest < 2 or nearest > MAX_DROPOUT_BEATS:
        return "shift"
    # Drift is measured against one beat, not against the whole gap: half a
    # beat out is half a beat out whether it accumulated over 4 beats or 40.
    if abs(beats - nearest) <= DROPOUT_PHASE_TOLERANCE:
        return "dropout"
    return "shift"


def _find_cuts(intervals: "list[float]") -> "list[tuple[int, str]]":
    """Beat indices where a new segment starts, with why.

    Returns [(beat_index, reason)] where `beat_index` indexes into the beat
    list (not the interval list) and names the FIRST beat of the new
    segment. Reasons are 'tempo' and 'shift'; 'dropout' intervals produce no
    cut at all, which is the whole point of classifying them.
    """
    n = len(intervals)
    if n == 0:
        return []

    cuts: "list[tuple[int, str]]" = []
    run_start = 0                                    # index into `intervals`
    reference = _median(intervals[: min(SUSTAIN_BEATS * 2, n)])

    i = 0
    while i < n:
        gap = intervals[i]
        if _same_tempo(gap, reference):
            i += 1
            continue

        # Irregular. Does a NEW steady tempo start here and hold?
        ahead = intervals[i : i + SUSTAIN_BEATS]
        if len(ahead) == SUSTAIN_BEATS:
            ahead_ref = _median(ahead)
            steady = ahead_ref > 0 and all(_same_tempo(v, ahead_ref) for v in ahead)
            changed = not _same_tempo(ahead_ref, reference)
            if steady and changed:
                # interval i spans beats i → i+1, so the new segment opens at
                # beat i+1: the first beat actually played at the new tempo.
                cuts.append((i + 1, "tempo"))
                run_start = i
                reference = ahead_ref
                i += SUSTAIN_BEATS
                continue

        # Not a sustained tempo change. Either the tracker went quiet across
        # a whole number of beats (bridge it) or the phase genuinely moved.
        if gap > reference and _classify_gap(gap, reference) == "dropout":
            i += 1
            continue

        cuts.append((i + 1, "shift"))
        run_start = i + 1
        # Re-reference from the new run so a phase shift doesn't leave us
        # comparing against a tempo we have already left behind.
        following = intervals[run_start : run_start + SUSTAIN_BEATS * 2]
        if following:
            reference = _median(following)
        i += 1

    return cuts


def _meter_from_downbeats(
    beats: "list[float]", downbeats: "list[float]", interval: float
) -> "tuple[str | None, float | None]":
    """Infer '<n>/4' and the bar-1 time for one segment's worth of beats.

    Counts beats between consecutive downbeats and takes the mode. Returns
    (None, None) when there aren't two full bars inside the segment to
    compare — an honest "unknown" beats a confident 4/4 derived from a
    single downbeat, because the caller renders whatever we say.
    """
    inside = [d for d in downbeats if beats and beats[0] - 1e-6 <= d <= beats[-1] + 1e-6]
    if len(inside) < 2:
        return None, (inside[0] if inside else None)

    spans: "list[int]" = []
    for a, b in zip(inside, inside[1:]):
        if interval <= 0:
            continue
        count = round((b - a) / interval)
        if 1 <= count <= 16:
            spans.append(int(count))
    if not spans:
        return None, inside[0]

    counts = Counter(spans)
    most_common, votes = counts.most_common(1)[0]
    # A bare plurality across a handful of bars is not a meter. Demand a
    # strict majority of the complete bars observed, and never fewer than
    # two — "3, 6, 3, 8, 7" has a winner but no meter.
    if votes < 2 or votes * 2 <= len(spans):
        return None, inside[0]
    return f"{most_common}/4", inside[0]


def fit_segments(
    beat_times,
    downbeats=(),
    *,
    duration: "float | None" = None,
    min_segment_seconds: float = MIN_SEGMENT_SECONDS,
) -> "list[dict]":
    """Fit grid segments to a tracker's beats.

    Each segment is `{start, bpm, time_signature, ...}` where `start` is bar
    1 beat 1 — the same contract as `GridSegment` in songInfo.ts, so the UI
    can adopt one without arithmetic. `start` is snapped to the segment's
    first DOWNBEAT when the tracker gave us one inside the segment, because
    a segment anchored on beat 3 is a grid that is wrong in exactly the way
    this whole module exists to fix.

    The first segment is always returned, even for a song with no changes at
    all — the caller decides whether to keep it as the song's own
    gridOffset/bpm or as an explicit segment.
    """
    beats = _clean_times(beat_times)
    downs = _clean_times(downbeats)
    if len(beats) < 2:
        return []

    intervals = [b - a for a, b in zip(beats, beats[1:])]
    cuts = _find_cuts(intervals)

    # Cut indices → [start, end) index ranges over `beats`.
    starts = [0] + [idx for idx, _ in cuts]
    reasons = ["opening"] + [reason for _, reason in cuts]
    bounds = list(zip(starts, starts[1:] + [len(beats)]))
    ranges = _absorb_unmeasurable(list(zip(starts, [hi for _, hi in bounds], reasons)))

    segments: "list[dict]" = []
    for lo, hi, reason in ranges:
        span = beats[lo:hi]
        if len(span) < 2:
            continue
        seg_intervals = [b - a for a, b in zip(span, span[1:])]
        # Median over the segment's own intervals: immune to the single
        # doubled interval a bridged dropout leaves inside the run.
        typical = _median(seg_intervals)
        if typical <= 0:
            continue
        meter, bar_one = _meter_from_downbeats(span, downs, typical)
        start = bar_one if bar_one is not None else span[0]
        segments.append({
            "start":          round(start, 6),
            "end":            round(span[-1], 6),
            "bpm":            round(60.0 / typical, 3),
            "time_signature": meter,
            "beats":          len(span),
            "reason":         reason,
        })

    # Order matters. Implausible tempi go first so an octave comparison is
    # never made against a 428 BPM artifact; the length floor goes last so it
    # judges segments at their final extent, after both merges have run.
    segments = _absorb(segments, _implausible)
    segments = _merge_octaves(segments)
    segments = _absorb(segments, lambda seg: seg["end"] - seg["start"] < min_segment_seconds)

    # Whatever survives first IS the opening — there is nothing before it to
    # have been cut away from, so it cannot be labelled a shift.
    if segments:
        segments[0]["reason"] = "opening"

    # `end` on the last segment is its last BEAT, which is up to one beat shy
    # of the audio. Extend it to the real duration so the segment table
    # doesn't show a song ending early.
    if segments and duration and duration > segments[-1]["end"]:
        segments[-1]["end"] = round(float(duration), 6)

    return segments


def _absorb_unmeasurable(
    ranges: "list[tuple[int, int, str]]",
) -> "list[tuple[int, int, str]]":
    """Fold away ranges holding fewer than two beats.

    A one-beat range has no interval, so no tempo can be read from it. That
    happens in clusters at the top of a sparse intro, where the tracker
    places a handful of isolated beats before the drums arrive — and dropping
    them outright would silently leave the first seconds of the song outside
    every segment, which reads on screen as a grid that starts late.

    So they merge FORWARD into the range that follows (the next range's beats
    are the ones that establish the tempo those stray beats belong to), or
    backward into the previous one when there is no next.
    """
    out: "list[tuple[int, int, str]]" = []
    pending_lo: "int | None" = None
    for lo, hi, reason in ranges:
        if pending_lo is not None:
            lo, pending_lo = pending_lo, None
        if hi - lo < 2:
            pending_lo = lo
            continue
        out.append((lo, hi, reason))
    if pending_lo is not None and out:
        lo, hi, reason = out[-1]
        out[-1] = (lo, ranges[-1][1], reason)
    return out


def _implausible(segment: dict) -> bool:
    """A fitted tempo no piece of music actually has."""
    bpm = segment.get("bpm") or 0.0
    return not (MIN_PLAUSIBLE_BPM <= bpm <= MAX_PLAUSIBLE_BPM)


def _absorb(segments: "list[dict]", should_absorb) -> "list[dict]":
    """Merge every segment matching `should_absorb` into a neighbour.

    The one mechanism behind both post-passes: a segment too short to be real
    and a segment whose tempo is not a tempo both need to disappear into
    whatever is next to them rather than reach the curator.

    A matching segment merges BACKWARD into its predecessor — the
    predecessor's bar 1 is the one already established and on screen —
    except when it is the opening segment, which has no predecessor and so
    absorbs its successor instead.

    When EVERY segment matches there is nothing sound to merge into, and the
    segments are returned untouched. That is the spoken-word case: an honest
    mess is more useful than a fabricated single segment spanning three
    minutes of speech that has no pulse at all.
    """
    if len(segments) < 2 or all(should_absorb(seg) for seg in segments):
        return segments

    out: "list[dict]" = []
    for seg in segments:
        if out and should_absorb(seg):
            prev = out[-1]
            prev["end"] = seg["end"]
            prev["beats"] += seg["beats"]
            continue
        out.append(dict(seg))

    # The opening segment can only be judged once its successor is known.
    while len(out) > 1 and should_absorb(out[0]):
        first, second = out[0], out[1]
        second["start"] = first["start"]
        second["beats"] += first["beats"]
        out.pop(0)   # its reason is restamped 'opening' by the caller

    return out


def _octave_related(a: float, b: float) -> bool:
    """Are these two tempi the same pulse counted at different levels?"""
    if a <= 0 or b <= 0:
        return False
    ratio = max(a, b) / min(a, b)
    return any(abs(ratio - f) / f <= OCTAVE_TOLERANCE for f in (2.0, 4.0))


def _merge_octaves(segments: "list[dict]") -> "list[dict]":
    """Join neighbours that differ only by a metrical level.

    A tracker that reports 65 BPM through a verse and 130 through the chorus
    has not found a tempo change — it has changed its mind about which pulse
    to count, and both readings describe the same grid. Cutting there hands
    the curator a segment table that documents the tracker's indecision.

    Both cut reasons are considered, including 'tempo'. That looks wrong at
    first — a 'tempo' cut passed the sustain test on four consecutive
    intervals — but a tracker that flips to double-time for a whole chorus
    flips for hundreds of intervals, so a level change is ALWAYS sustained.
    Excluding 'tempo' here means the merge never fires on the common case.

    The cost is that a genuine 2x tempo change is merged too. From beat times
    alone the two are not distinguishable — that is the octave ambiguity, and
    it is why the maintainer resolves octaves per song by hand. Merging is
    the better default: it under-reports a change the curator can add back,
    rather than inventing a grid restart mid-chorus.

    The surviving BPM and meter come from whichever side has more beats
    behind it, which is the standard resolution and the level the rest of the
    song is more likely counted at.
    """
    if len(segments) < 2:
        return segments

    out = [dict(segments[0])]
    for seg in segments[1:]:
        prev = out[-1]
        if _octave_related(prev["bpm"], seg["bpm"]):
            dominant = prev if prev["beats"] >= seg["beats"] else seg
            prev["bpm"] = dominant["bpm"]
            prev["time_signature"] = dominant["time_signature"]
            prev["end"] = seg["end"]
            prev["beats"] += seg["beats"]
            continue
        out.append(dict(seg))
    return out


def summarize(segments: "list[dict]") -> dict:
    """A one-line description of what the fit found, for logs and the UI.

    Distinguishes the two cases a curator cares about: a song whose tempo
    moves, and a song whose tempo is rock solid but whose count restarts.
    """
    tempo_cuts = sum(1 for s in segments if s.get("reason") == "tempo")
    phase_cuts = sum(1 for s in segments if s.get("reason") == "shift")
    return {
        "segments":     len(segments),
        "tempo_changes": tempo_cuts,
        "phase_shifts":  phase_cuts,
        "constant_tempo": tempo_cuts == 0 and len(segments) > 0,
    }
