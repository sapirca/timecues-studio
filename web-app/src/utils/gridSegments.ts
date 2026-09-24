// Grid segments — resolving the stored splits into a drawable, queryable table.
//
// A song's grid is a run of segments laid end to end. The opening one is not
// stored: it is derived from the song's own `gridOffset` / `bpm` /
// `timeSignature`, so those fields keep meaning exactly what they meant
// before segments existed, and a song with no splits resolves to a single
// segment that behaves byte-for-byte like the legacy single-tempo grid.
//
// Each segment starts on ITS OWN bar 1, beat 1. The segment before it is cut
// wherever the split lands — a bar that only got 3.5 of its 4 beats is the
// normal outcome, and `cutBeats` reports exactly how much it kept so the UI
// can say so out loud. Nothing is ever rounded to complete the outgoing bar:
// that would silently move a downbeat the curator placed by hand.
//
// Two running offsets are carried per segment:
//   beatIndexOffset — cumulative beat LINES before this segment, so a global
//                     beat index stays unique and monotonic across the song.
//   barNumberOffset — cumulative BARS before this segment, counting the cut
//                     bar as one. This is what keeps "bar 42" stable across a
//                     split ('continue'); in 'restart' mode it is always 0.
//
// Segments deliberately ignore tempo anchors: a song's grid comes from its
// segments when it has splits, and from the legacy anchor/static path when it
// has none. Anchor code is untouched either way.

import type { GridSegment, SongInfo, BarNumbering } from '../types/songInfo';
import {
  effectiveGridSegments,
  storedGridSegments,
  effectiveBarNumbering,
  DEFAULT_TIME_SIGNATURE,
} from '../types/songInfo';
import { beatsPerBarFromTimeSignature, beatDuration } from './beatGrid';

/** Id the opening (derived) segment always carries. Never collides with a
 *  stored id — those are minted by makeGridSegmentId() as `gs_…`. */
export const OPENING_SEGMENT_ID = 'opening';

/** Float slack for "does this land exactly on a bar line" comparisons.
 *  1 µs, far below any audible phase. */
const EPS = 1e-6;
/** A head is stored to the millisecond, so a bar that ends 0.4 ms short of a
 *  bar line is a rounding artifact, not a cut. Anything under this much time
 *  counts as "landed on the line" — without it a whole bar reports itself as
 *  cut, hatched and labelled "4 of 4 beats", which is a bar that lost nothing. */
const CUT_EPS_SEC = 0.003;

export interface ResolvedSegment {
  id: string;
  /** 0 for the opening segment, then 1, 2, … in time order. */
  index: number;
  /** Absolute seconds. This instant is bar 1, beat 1 of the segment. */
  start: number;
  /** Start of the next segment, or +Infinity for the last one. */
  end: number;
  bpm: number;
  timeSignature: string;
  beatsPerBar: number;
  /** Seconds per beat at this segment's tempo. */
  beatDur: number;
  /** Cumulative beat lines before this segment. */
  beatIndexOffset: number;
  /** Cumulative bars before this segment (0 under 'restart' numbering). */
  barNumberOffset: number;
  /** Beat lines inside [start, end). Infinity for the final segment. */
  beatCount: number;
  /** Bars inside the segment, counting a cut final bar as one. */
  barCount: number;
  /** Beats the final bar keeps when the segment is cut mid-bar, in
   *  (0, beatsPerBar). Exactly 0 when the segment ends on a bar line, and 0
   *  for the final segment, which is not cut by anything. */
  cutBeats: number;
  /** Time of the final bar line, i.e. where the cut bar starts. Only
   *  meaningful when `cutBeats > 0`. */
  cutBarStart: number;
}

/** Resolve a song's grid into its segment table, as the ACTIVE grid sees it:
 *  splits apply in Mapped mode (and Hand-placed on a Mapped base) and are
 *  inert everywhere else, so switching modes never redraws them away.
 *
 *  Always returns at least one segment when the song has a usable BPM: the
 *  opening one, spanning the whole track. Returns [] when there is no grid
 *  yet, which callers read as "fall back to the legacy path". */
export function resolveGridSegments(
  info: SongInfo | null | undefined,
): ResolvedSegment[] {
  if (!info || !Number.isFinite(info.bpm) || (info.bpm ?? 0) <= 0) return [];
  return buildResolved(
    effectiveGridSegments(info),
    info.gridOffset ?? 0,
    info.bpm as number,
    info.timeSignature || DEFAULT_TIME_SIGNATURE,
    effectiveBarNumbering(info),
  );
}

/** Same as resolveGridSegments but from loose parts — for callers holding a
 *  draft that is not yet a SongInfo (a drag in progress, a preview). */
export function buildResolved(
  segments: readonly GridSegment[],
  gridOffset: number,
  bpm: number,
  timeSignature: string,
  numbering: BarNumbering = 'continue',
): ResolvedSegment[] {
  const heads: Array<{ id: string; start: number; bpm: number; timeSignature: string }> = [
    { id: OPENING_SEGMENT_ID, start: gridOffset, bpm, timeSignature },
    ...segments.map((g) => ({ id: g.id, start: g.start, bpm: g.bpm, timeSignature: g.timeSignature })),
  ];

  const out: ResolvedSegment[] = [];
  let beatIndexOffset = 0;
  let barNumberOffset = 0;

  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].start : Number.POSITIVE_INFINITY;
    const beatsPerBar = beatsPerBarFromTimeSignature(h.timeSignature);
    const beatDur = beatDuration(h.bpm);

    let beatCount = Number.POSITIVE_INFINITY;
    let barCount = Number.POSITIVE_INFINITY;
    let cutBeats = 0;
    let cutBarStart = Number.POSITIVE_INFINITY;

    if (Number.isFinite(end)) {
      const totalBeats = (end - h.start) / beatDur;
      // Tolerance in BEATS for what counts as landing on a line, from a fixed
      // tolerance in time — a slow segment's beat is worth more milliseconds.
      const beatTol = Math.max(EPS, CUT_EPS_SEC / beatDur);
      const wholeBars = Math.max(0, Math.floor(totalBeats / beatsPerBar + beatTol / beatsPerBar));
      const lastBarBeats = totalBeats - wholeBars * beatsPerBar;
      cutBeats = lastBarBeats < beatTol ? 0 : lastBarBeats;
      barCount = wholeBars + (cutBeats > 0 ? 1 : 0);
      // Beat LINES in [start, end): indices 0 … ceil(totalBeats) - 1.
      beatCount = Math.max(0, Math.ceil(totalBeats - beatTol));
      cutBarStart = h.start + wholeBars * beatsPerBar * beatDur;
    }

    out.push({
      id: h.id, index: i, start: h.start, end,
      bpm: h.bpm, timeSignature: h.timeSignature,
      beatsPerBar, beatDur,
      beatIndexOffset,
      barNumberOffset: numbering === 'restart' ? 0 : barNumberOffset,
      beatCount, barCount, cutBeats, cutBarStart,
    });

    if (Number.isFinite(beatCount)) beatIndexOffset += beatCount;
    if (Number.isFinite(barCount)) barNumberOffset += barCount;
  }
  return out;
}

/** The segment containing `t`. Times before the first segment's start (the
 *  pickup, before bar 1) belong to the opening segment, whose grid runs
 *  backwards through them just as the legacy grid does. */
export function segmentAtTime(
  resolved: readonly ResolvedSegment[],
  t: number,
): ResolvedSegment | null {
  if (resolved.length === 0) return null;
  let found = resolved[0];
  for (const seg of resolved) {
    if (seg.start <= t + EPS) found = seg;
    else break;
  }
  return found;
}

/** The segment owning a global beat index. */
export function segmentAtBeatIndex(
  resolved: readonly ResolvedSegment[],
  beatIndex: number,
): ResolvedSegment | null {
  if (resolved.length === 0) return null;
  let found = resolved[0];
  for (const seg of resolved) {
    if (beatIndex >= seg.beatIndexOffset) found = seg;
    else break;
  }
  return found;
}

/** Absolute time of a global beat index, ignoring per-beat overrides. */
export function segmentBeatTime(
  resolved: readonly ResolvedSegment[],
  beatIndex: number,
): number | null {
  const seg = segmentAtBeatIndex(resolved, beatIndex);
  if (!seg) return null;
  return seg.start + (beatIndex - seg.beatIndexOffset) * seg.beatDur;
}

/** Fractional beat position of `t` from the song origin — the segment-aware
 *  counterpart to beatPositionAt(). Beats before bar 1 come back negative. */
export function segmentBeatPosition(
  resolved: readonly ResolvedSegment[],
  t: number,
): number | null {
  const seg = segmentAtTime(resolved, t);
  if (!seg) return null;
  return seg.beatIndexOffset + (t - seg.start) / seg.beatDur;
}

/** Display bar / beat for `t`, honouring each segment's own meter.
 *  `bar` and `beat` are 0-based here; callers add the display origin. */
export function segmentBarBeat(
  resolved: readonly ResolvedSegment[],
  t: number,
): { bar: number; beat: number; frac: number; segment: ResolvedSegment } | null {
  const seg = segmentAtTime(resolved, t);
  if (!seg) return null;
  const local = (t - seg.start) / seg.beatDur;
  // A hair under a whole beat is a whole beat — otherwise 4.0 arrives as
  // 3.9999999999999996 and the line reports the previous bar.
  const localFloor = Math.floor(local + EPS);
  const barLocal = Math.floor(localFloor / seg.beatsPerBar);
  const beat = localFloor - barLocal * seg.beatsPerBar;
  return {
    bar: seg.barNumberOffset + barLocal,
    beat,
    frac: local - localFloor,
    segment: seg,
  };
}

// ─── Editing ─────────────────────────────────────────────────────────────────

/** A split closer than one beat of the outgoing tempo is almost always a
 *  slipped mouse, so the editor refuses it rather than clamping. */
export function minSplitGapSec(outgoing: ResolvedSegment | null): number {
  return outgoing ? outgoing.beatDur : 0.2;
}

/** The grid running between two positions is the one that owns the earlier
 *  of them — that is the tempo a new head would be cutting into. */
function gapBetween(
  segments: readonly ResolvedSegment[],
  a: number,
  b: number,
): number {
  return minSplitGapSec(segmentAtTime(segments, Math.min(a, b)));
}

export interface SplitCheck {
  ok: boolean;
  /** Set when `ok` is false — ready to show as an inline message. */
  reason?: string;
}

/** Can a segment head sit at `t`, given the song's other heads? `ignoreId`
 *  lets a drag test its own new position without tripping over itself. */
export function canPlaceSegmentAt(
  resolved: readonly ResolvedSegment[],
  t: number,
  ignoreId?: string,
): SplitCheck {
  if (!Number.isFinite(t)) return { ok: false, reason: 'That is not a time.' };
  const others = resolved.filter((s) => s.id !== ignoreId);
  if (others.length === 0) return { ok: true };
  const origin = others[0].start;
  if (t <= origin) {
    return { ok: false, reason: 'A split has to come after the song’s first downbeat.' };
  }
  for (const seg of others) {
    const gap = gapBetween(others, t, seg.start);
    if (Math.abs(t - seg.start) < gap) {
      return {
        ok: false,
        reason: seg.index === 0
          ? 'Too close to the song’s first downbeat — leave at least one beat.'
          : `Too close to segment ${seg.index + 1} — leave at least one beat between splits.`,
      };
    }
  }
  return { ok: true };
}

/** Where the OPENING segment's head may sit — the song's own downbeat, which
 *  is `gridOffset` rather than a stored split.
 *
 *  The rules are not a split's. A split must fall *after* the origin and clear
 *  of its neighbours; the origin has nothing before it to come after, and
 *  moving it is how a song whose bar 1 isn't at 0:00 gets its grid lined up.
 *  What it must not do is cross a split: `normalizeGridSegments` drops every
 *  stored segment at or before the offset, so an origin dragged past segment 2
 *  would delete it on the way through, silently and with no undo prompt.
 */
export function canPlaceOriginAt(
  resolved: readonly ResolvedSegment[],
  t: number,
  duration?: number,
): SplitCheck {
  if (!Number.isFinite(t)) return { ok: false, reason: 'That is not a time.' };
  if (t < 0) return { ok: false, reason: 'The downbeat can’t sit before the start of the song.' };
  if (duration != null && Number.isFinite(duration) && duration > 0 && t >= duration) {
    return { ok: false, reason: 'The downbeat has to be inside the song.' };
  }
  const next = resolved.find((s) => s.index === 1);
  if (next) {
    // One beat of the OPENING grid — the tempo the first segment would be
    // counting at, which is the one being squeezed.
    const gap = minSplitGapSec(resolved[0] ?? null);
    if (next.start - t < gap) {
      return { ok: false, reason: 'Too close to segment 2 — the first grid needs at least one beat.' };
    }
  }
  return { ok: true };
}

/** Where a head may go, whichever head it is. The opening segment plays by
 *  different rules from a split, and both the lane's live readout and the
 *  commit path have to agree about which set applies. */
export function canMoveHeadTo(
  resolved: readonly ResolvedSegment[],
  segment: ResolvedSegment,
  t: number,
  duration?: number,
): SplitCheck {
  return segment.index === 0
    ? canPlaceOriginAt(resolved, t, duration)
    : canPlaceSegmentAt(resolved, t, segment.id);
}

/** How much of its final bar the segment ending at `t` would keep. Drives the
 *  live readout during a drag. Returns null when nothing is cut. */
export function cutPreviewAt(
  resolved: readonly ResolvedSegment[],
  t: number,
  ignoreId?: string,
): { beatsKept: number; beatsPerBar: number; barNumber: number } | null {
  const others = resolved.filter((s) => s.id !== ignoreId);
  let outgoing: ResolvedSegment | null = null;
  for (const seg of others) {
    if (seg.start < t - EPS) outgoing = seg;
    else break;
  }
  if (!outgoing) return null;
  const totalBeats = (t - outgoing.start) / outgoing.beatDur;
  // Same tolerance the resolved table uses, so the live readout and the hatch
  // that lands after the drop always agree about whether anything was cut.
  const beatTol = Math.max(EPS, CUT_EPS_SEC / outgoing.beatDur);
  const wholeBars = Math.max(0, Math.floor(totalBeats / outgoing.beatsPerBar + beatTol / outgoing.beatsPerBar));
  const kept = totalBeats - wholeBars * outgoing.beatsPerBar;
  if (kept < beatTol || outgoing.beatsPerBar - kept < beatTol) return null;
  return {
    beatsKept: kept,
    beatsPerBar: outgoing.beatsPerBar,
    barNumber: outgoing.barNumberOffset + wholeBars,
  };
}

/** Where a dragged segment head lands when snapping is on: the nearest beat
 *  of the OUTGOING grid — the one the music is still running on where the head
 *  is being dropped — not the dragged segment's own grid, which is exactly the
 *  thing being repositioned.
 *
 *  Whether to call this at all is the caller's decision: the head obeys the
 *  timeline's Snap-to-grid switch like every other marker, so an unsnapped
 *  drag simply keeps the raw time. */
export function snapSegmentHeadTime(
  resolved: readonly ResolvedSegment[],
  t: number,
  draggedId: string,
  /** Hand-placed pins. A pinned beat is where the line is DRAWN, so it has to
   *  be where the head lands too — otherwise snapping puts the head next to a
   *  visible beat line rather than on it. */
  overrides?: Readonly<Record<string, number>>,
): number {
  // The outgoing segment is the one before the dragged head in the table. Taken
  // by position rather than by comparing starts, so it doesn't change under a
  // drag that is itself rewriting the starts.
  const idx = resolved.findIndex((s) => s.id === draggedId);
  // The opening head has no outgoing grid — it IS where the grid begins, so
  // there are no beats before it to snap to. Returned early rather than left
  // to the fallback scan below, which would otherwise latch onto segment 2
  // the moment a drag passed under it and snap the origin to a later grid.
  if (idx === 0) return Math.max(0, t);
  let outgoing: ResolvedSegment | undefined = idx > 0 ? resolved[idx - 1] : undefined;
  if (!outgoing) {
    for (const seg of resolved) {
      if (seg.id !== draggedId && seg.start < t) outgoing = seg;
    }
  }
  if (!outgoing) return t;
  const n = Math.round((t - outgoing.start) / outgoing.beatDur);
  // Segment-scoped key first, then the legacy plain index — the same order
  // readBeatOverride uses, but pinned to the outgoing segment rather than to
  // whichever segment the global beat index currently falls in (one past the
  // outgoing segment's last beat is the dragged head's own territory).
  if (overrides) {
    const scoped = resolved.length > 1 ? overrides[`${outgoing.id}:${n}`] : undefined;
    const plain = overrides[String(outgoing.beatIndexOffset + n)];
    const pinned = typeof scoped === 'number' ? scoped : plain;
    if (typeof pinned === 'number' && Number.isFinite(pinned)) return Math.max(0, pinned);
  }
  return Math.max(0, outgoing.start + n * outgoing.beatDur);
}

/** How to write "kept 3.5 of 4 beats" so the number never lies. One decimal
 *  reads best, but a bar that kept 3.96 beats must not round to "4 of 4" — a
 *  full bar that reports itself as cut is exactly the bug this label exists to
 *  rule out — and one that kept 0.04 must not read "0 of 4" either. So the
 *  precision grows until the printed value is neither the empty bar nor the
 *  whole one. */
export function formatKeptBeats(kept: number, beatsPerBar: number): string {
  for (const dp of [1, 2, 3]) {
    const f = 10 ** dp;
    const v = Math.round(kept * f) / f;
    if (v > 0 && v < beatsPerBar) return String(v);
  }
  return String(Math.round(kept * 1000) / 1000);
}

// ─── Per-beat overrides across a split ───────────────────────────────────────
//
// Manual mode pins individual beats by global integer beat index. A split
// renumbers every beat after it, so the raw keys would point somewhere new.
// Overrides are therefore stored scoped to their segment once a song has any
// splits — `"<segmentId>:<beatIndexInSegment>"` — and re-keyed by TIME
// whenever the segment table changes, so a pinned beat stays on the beat the
// curator pinned. A song with no splits keeps the plain numeric keys it
// always had, so untouched songs never rewrite their file.

/** Key for a pinned beat. Plain index when the song has no splits (legacy,
 *  byte-identical), segment-scoped once it does. */
export function beatOverrideKey(
  resolved: readonly ResolvedSegment[],
  beatIndex: number,
): string {
  if (resolved.length <= 1) return String(beatIndex);
  const seg = segmentAtBeatIndex(resolved, beatIndex);
  if (!seg) return String(beatIndex);
  return `${seg.id}:${beatIndex - seg.beatIndexOffset}`;
}

/** Look up a pinned beat, accepting either key shape so a song that has just
 *  gained its first split still reads its old entries. */
export function readBeatOverride(
  overrides: Readonly<Record<string, number>> | undefined,
  resolved: readonly ResolvedSegment[],
  beatIndex: number,
): number | undefined {
  if (!overrides) return undefined;
  const scoped = overrides[beatOverrideKey(resolved, beatIndex)];
  if (typeof scoped === 'number' && Number.isFinite(scoped)) return scoped;
  const plain = overrides[String(beatIndex)];
  return typeof plain === 'number' && Number.isFinite(plain) ? plain : undefined;
}

/** Re-key every pinned beat from one segment table to another.
 *
 *  Identity first: a pin whose segment still exists keeps the beat it was
 *  pinned to, so moving a head or changing a tempo carries its pins along
 *  with the grid rather than stranding them. Only when the pin's segment is
 *  gone — or when its key predates segments entirely — does it fall back to
 *  matching by time, and then only if the old beat still lands on a beat of
 *  the new grid. A pin that would otherwise be dragged onto a DIFFERENT beat
 *  is dropped, because quietly displacing someone's hand-placed beat is
 *  worse than losing it visibly. */
export function remapBeatOverrides(
  overrides: Readonly<Record<string, number>> | undefined,
  before: readonly ResolvedSegment[],
  after: readonly ResolvedSegment[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!overrides || after.length === 0) return out;

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const target = remapOne(key, before, after);
    if (target == null) continue;
    const newKey = beatOverrideKey(after, target);
    // First writer wins: two old pins never fold onto one beat.
    if (newKey in out) continue;
    out[newKey] = value;
  }
  return out;
}

/** The global beat index a pin should land on under `after`, or null to drop
 *  it. Split out so the two strategies read as the two cases they are. */
function remapOne(
  key: string,
  before: readonly ResolvedSegment[],
  after: readonly ResolvedSegment[],
): number | null {
  const parsed = parseOverrideKey(key);
  if (parsed == null) return null;

  // ── Identity: the same beat of the same segment. ──
  if (parsed.segId != null) {
    const seg = after.find((s) => s.id === parsed.segId);
    if (seg) {
      if (parsed.index < 0) return null;
      if (Number.isFinite(seg.beatCount) && parsed.index >= seg.beatCount) return null;
      return seg.beatIndexOffset + parsed.index;
    }
  }

  // ── Fallback: the same instant, if it is still a beat. ──
  const anchorTime = overrideAnchorTime(key, before);
  if (anchorTime == null) return null;
  const seg = segmentAtTime(after, anchorTime);
  if (!seg) return null;
  const local = Math.round((anchorTime - seg.start) / seg.beatDur);
  if (local < 0) return null;
  if (Number.isFinite(seg.beatCount) && local >= seg.beatCount) return null;
  const landed = seg.start + local * seg.beatDur;
  if (Math.abs(landed - anchorTime) > OVERRIDE_MATCH_SEC) return null;
  return seg.beatIndexOffset + local;
}

/** How far a pinned beat may sit from a beat of the new grid and still be
 *  considered the same beat. Matches the segment dedup window — below it,
 *  two positions are the same position. */
const OVERRIDE_MATCH_SEC = 0.020;

function parseOverrideKey(key: string): { segId: string | null; index: number } | null {
  const colon = key.indexOf(':');
  if (colon > 0) {
    const index = Number(key.slice(colon + 1));
    if (!Number.isFinite(index)) return null;
    return { segId: key.slice(0, colon), index };
  }
  const index = Number(key);
  if (!Number.isFinite(index)) return null;
  return { segId: null, index };
}

/** The macro time of the beat a key pins, under the given segment table. */
function overrideAnchorTime(
  key: string,
  resolved: readonly ResolvedSegment[],
): number | null {
  if (resolved.length === 0) return null;
  const colon = key.indexOf(':');
  if (colon > 0) {
    const segId = key.slice(0, colon);
    const local = Number(key.slice(colon + 1));
    if (!Number.isFinite(local)) return null;
    const seg = resolved.find((s) => s.id === segId);
    if (!seg) return null;
    return seg.start + local * seg.beatDur;
  }
  const idx = Number(key);
  if (!Number.isFinite(idx)) return null;
  return segmentBeatTime(resolved, idx);
}

/** Resolve every stored split, whatever the active mode. This is what the
 *  lane and the list draw: the map you are building is visible while you
 *  build it, even before Mapped is the mode in force. */
export function resolveStoredGridSegments(
  info: SongInfo | null | undefined,
): ResolvedSegment[] {
  if (!info || !Number.isFinite(info.bpm) || (info.bpm ?? 0) <= 0) return [];
  return buildResolved(
    storedGridSegments(info),
    info.gridOffset ?? 0,
    info.bpm as number,
    info.timeSignature || DEFAULT_TIME_SIGNATURE,
    effectiveBarNumbering(info),
  );
}
