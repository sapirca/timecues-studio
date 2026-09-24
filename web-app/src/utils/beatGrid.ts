// Single source of truth for beat/bar grid math.
//
// Convention (matches Rekordbox "Set Grid"):
//   - bpm: tempo in beats per minute (B).
//   - gridOffset: time in seconds where bar 1 / beat 1 sits (T_offset), held
//     inside the first bar: 0 <= T_offset < barDuration. See "Grid offset
//     folding" below for why a whole-bar offset is folded away.
//   - beatsPerBar: numerator of the time signature.
//
// For any time t (seconds):
//   beatIndex   = floor((t - T_offset) / dBeat)   // can be negative
//   beatTime(i) = T_offset + i * dBeat
//   barIndex    = floor(beatIndex / beatsPerBar)  // can be negative
//
// Bar 1 in the UI = barIndex 0 (the bar that starts at gridOffset) — the
// song's first full bar, since the offset never spans a whole one. Times
// before it are the pickup, and number backwards (bar 0, then -1).
//
import type { ResolvedSegment } from './gridSegments';

// ─── Grid segments ───────────────────────────────────────────────────────────
//
// A song split into grid segments resolves its grid from the segment table
// instead of the single-tempo path: each segment owns its tempo, its meter
// and its own bar 1. Only `ResolvedSegment` is imported, as a type, so this
// module stays free of a runtime edge back to gridSegments.ts — the three
// lookups below are the whole of what the grid math needs, and
// gridSegments.ts holds the canonical versions for everyone else.
//
// A song with fewer than two segments takes none of these paths: one segment
// IS the legacy single-tempo grid, so unsplit songs render through exactly
// the code they always did.

/** True when the segment table actually splits the song. */
function hasSplits(segments: readonly ResolvedSegment[] | undefined): segments is readonly ResolvedSegment[] {
  return !!segments && segments.length > 1;
}

/** Float slack for beat-boundary floors — 1 µs, far below audible phase. */
const SEG_EPSILON = 1e-6;

function segmentAt(segments: readonly ResolvedSegment[], t: number): ResolvedSegment {
  let found = segments[0];
  for (const seg of segments) {
    if (seg.start <= t + SEG_EPSILON) found = seg;
    else break;
  }
  return found;
}

function segmentForBeat(segments: readonly ResolvedSegment[], beatIndex: number): ResolvedSegment {
  let found = segments[0];
  for (const seg of segments) {
    if (beatIndex >= seg.beatIndexOffset) found = seg;
    else break;
  }
  return found;
}

/** Override key for a beat inside a split song. Mirrors beatOverrideKey() in
 *  gridSegments.ts — utils/beatGrid.test.ts asserts the two never diverge. */
function segmentOverrideKey(seg: ResolvedSegment, beatIndex: number): string {
  return `${seg.id}:${beatIndex - seg.beatIndexOffset}`;
}

/** Pinned position for a beat, accepting the legacy plain-index key so a song
 *  that has just gained its first split still honours its old pins. */
function segmentOverrideAt(
  overrides: Readonly<Record<string, number>> | undefined,
  seg: ResolvedSegment,
  beatIndex: number,
): number | undefined {
  if (!overrides) return undefined;
  const scoped = overrides[segmentOverrideKey(seg, beatIndex)];
  if (typeof scoped === 'number' && Number.isFinite(scoped)) return scoped;
  const plain = overrides[String(beatIndex)];
  return typeof plain === 'number' && Number.isFinite(plain) ? plain : undefined;
}

export const TIME_SIGNATURES_TO_BEATS: Record<string, number> = {
  '4/4': 4, '3/4': 3, '6/8': 6, '5/4': 5, '7/8': 7, '2/4': 2, '12/8': 12,
};

export function beatsPerBarFromTimeSignature(ts: string | undefined): number {
  if (!ts) return 4;
  if (TIME_SIGNATURES_TO_BEATS[ts] != null) return TIME_SIGNATURES_TO_BEATS[ts];
  const num = parseInt(ts.split('/')[0] ?? '', 10);
  return Number.isFinite(num) && num > 0 ? num : 4;
}

// ─── Bar / beat display origin ───────────────────────────────────────────────
//
// Bar and beat *numbering* is a display convention, not grid math. Musicians
// count from 1 ("bar 1, beat 1"); DAW- and code-facing readers often prefer 0.
// Internally every index stays 0-based — the origin is added only when a
// number is rendered, and subtracted only when one is parsed.
//
// The module-level value mirrors the `barBeatOrigin` user setting
// (SettingsProvider keeps it in sync) so non-React callers — exporters,
// serializers — follow the same convention without threading a parameter.
// React call sites pass it explicitly via useBarBeatOrigin() so that flipping
// the setting re-renders them.

export type BarBeatOrigin = 0 | 1;
export const DEFAULT_BAR_BEAT_ORIGIN: BarBeatOrigin = 0;

let _barBeatOrigin: BarBeatOrigin = DEFAULT_BAR_BEAT_ORIGIN;

export function setBarBeatOrigin(o: BarBeatOrigin): void {
  _barBeatOrigin = o === 0 ? 0 : 1;
}

export function getBarBeatOrigin(): BarBeatOrigin {
  return _barBeatOrigin;
}

// ─── Time precision ──────────────────────────────────────────────────────────
//
// In-memory times keep full float precision for editing / playback. Only
// *exported* numbers are rounded, to the `timePrecisionDecimals` setting.
// This is the single rounding convention — 3 decimals = millisecond, matching
// the `precision = 3` used by the bar.beat conversion below.

export const DEFAULT_TIME_PRECISION = 3;
export const MIN_TIME_PRECISION = 2;
export const MAX_TIME_PRECISION = 6;

/** Round a time (seconds) to `decimals` places. Rounds, never truncates —
 *  `toFixed` returns a string, so re-parse to a number. Values are clamped to
 *  the allowed 2–6 range so callers can pass a raw setting straight through. */
export function roundTime(t: number, decimals: number = DEFAULT_TIME_PRECISION): number {
  const d = Math.min(MAX_TIME_PRECISION, Math.max(MIN_TIME_PRECISION, Math.round(decimals)));
  return Number(t.toFixed(d));
}

export function beatDuration(bpm: number): number {
  return 60 / bpm;
}

export function barDuration(bpm: number, beatsPerBar: number): number {
  return beatDuration(bpm) * beatsPerBar;
}

// ─── Grid offset folding ─────────────────────────────────────────────────────
//
// The offset is a PHASE inside one bar, never a whole-bar displacement: bar 1
// is the song's first bar, so `0 <= gridOffset < barDuration`. An offset of
// 3.5 bars places bar 1 three and a half bars into the song, which numbers
// everything before it negatively ("bar -2.4.964") — the grid runs in both
// directions, so `floor` is happy to hand back negative bars. Folding it to
// 0.5 bars leaves every grid line exactly where it was (the fold is a whole
// number of bars) and only renumbers them, so the first bar of the song is
// bar 1 — or bar 0, per `barBeatOrigin`. Times before the offset are the
// pickup, at most one bar of it.
//
// Callers that hold beat *indices* against the old numbering (annotation beat
// stamps, `SongInfo.beatOverrides` keys) must shift them by
// `gridOffsetBarShift * beatsPerBar` when the fold moves — see
// withFoldedGridOffset() in utils/beatAnchoring.ts, which does both halves.

/** Float-noise tolerance for the fold — 1 µs, far below any audible phase. */
const FOLD_EPSILON_SEC = 1e-6;

/** Whole bars the offset pushes bar 1 past the start of the song — the amount
 *  a fold removes, in bars. 0 when the offset is already inside the first bar
 *  or the tempo isn't usable. */
export function gridOffsetBarShift(
  gridOffset: number,
  bpm: number,
  beatsPerBar: number,
): number {
  const bar = barDuration(bpm, beatsPerBar);
  if (!Number.isFinite(gridOffset) || !Number.isFinite(bar) || bar <= 0) return 0;
  // A hair under a full bar is a full bar: float noise in a stored offset
  // must not leave the grid one bar out of step with its numbering.
  const shift = Math.floor((gridOffset + FOLD_EPSILON_SEC) / bar);
  return Math.max(0, shift);
}

/** The offset folded into the first bar: `gridOffset mod barDuration`, in
 *  [0, barDuration). Returns the offset untouched when the tempo isn't usable
 *  (no BPM yet — nothing to fold against). */
export function foldGridOffset(
  gridOffset: number,
  bpm: number,
  beatsPerBar: number,
): number {
  const shift = gridOffsetBarShift(gridOffset, bpm, beatsPerBar);
  if (shift === 0) return gridOffset;
  const folded = gridOffset - shift * barDuration(bpm, beatsPerBar);
  // Sub-microsecond residue is float noise from the subtraction, not phase.
  return Math.abs(folded) < FOLD_EPSILON_SEC ? 0 : roundTime(folded, MAX_TIME_PRECISION);
}

// Floor that handles negatives like Python (so beatIndex of t<offset is correctly negative).
// JS's Math.floor already does this; the wrapper exists to make intent explicit.
//
// In a split song the returned index is the *cumulative* beat count from the
// global origin, so bar numbering stays continuous across segments.
export function beatIndexAt(
  t: number,
  bpm: number,
  gridOffset: number,
  segments?: readonly ResolvedSegment[],
): number {
  if (hasSplits(segments)) {
    const seg = segmentAt(segments, t);
    return seg.beatIndexOffset + Math.floor((t - seg.start) / seg.beatDur + SEG_EPSILON);
  }
  return Math.floor((t - gridOffset) / beatDuration(bpm));
}

export function barIndexAt(
  t: number,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  segments?: readonly ResolvedSegment[],
): number {
  if (hasSplits(segments)) {
    const seg = segmentAt(segments, t);
    const local = Math.floor((t - seg.start) / seg.beatDur + SEG_EPSILON);
    return seg.barNumberOffset + Math.floor(local / seg.beatsPerBar);
  }
  return Math.floor(beatIndexAt(t, bpm, gridOffset) / beatsPerBar);
}

// Inverse of beatIndexAt: given a (possibly cumulative) beat index, return
// the absolute time. In a split song, walks segments until the requested
// index is found. When `overrides` is supplied and the requested index has
// an entry, the override value short-circuits the macro math — used by
// Manual-mode micro-overrides (see SongInfo.beatOverrides).
export function beatTimeAt(
  beatIndex: number,
  bpm: number,
  gridOffset: number,
  overrides?: Readonly<Record<string, number>>,
  segments?: readonly ResolvedSegment[],
): number {
  if (hasSplits(segments)) {
    const seg = segmentForBeat(segments, beatIndex);
    if (Number.isInteger(beatIndex)) {
      const pinned = segmentOverrideAt(overrides, seg, beatIndex);
      if (pinned != null) return pinned;
    }
    return seg.start + (beatIndex - seg.beatIndexOffset) * seg.beatDur;
  }
  if (overrides && Number.isInteger(beatIndex)) {
    const v = overrides[String(beatIndex)];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return gridOffset + beatIndex * beatDuration(bpm);
}

// Enumerate beat times in [from, to] (seconds) for the metronome click track.
//
// gridOffset is *phase only* — it sets where bar 1 / beat 1 sits, NOT where the
// pulse begins. The pulse extends infinitely in both directions, so beats
// before the offset (negative beat indices) are emitted just like beats after
// it: the click sounds the same on either side of the offset. The only floor on
// emitted times is `from` (the caller passes `from >= 0`), which keeps clicks
// out of negative time. The downbeat accent is derived from the beat index with
// a sign-safe modulo so it lands correctly even for negative indices.
//
// Routes through the same helpers as the rest of the grid so Mapped mode ticks
// at the right segment-local tempo, and Manual-mode per-beat overrides pull
// clicks onto their pinned positions. Static mode (no splits, no overrides)
// walks the plain `gridOffset + i*dBeat` grid.
export function beatsInRange(
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  from: number,
  to: number,
  overrides?: Readonly<Record<string, number>>,
  segments?: readonly ResolvedSegment[],
): Array<{ t: number; isDownbeat: boolean }> {
  if (!Number.isFinite(bpm) || bpm <= 0 || beatsPerBar <= 0) return [];
  // Start a couple of beats early so an overridden beat that pulled forward
  // earlier than its macro position is still in range.
  const startIdx = beatIndexAt(from, bpm, gridOffset, segments) - 2;
  const out: Array<{ t: number; isDownbeat: boolean }> = [];
  const HARD_CAP = 256;
  for (let i = startIdx; out.length < HARD_CAP; i++) {
    const t = beatTimeAt(i, bpm, gridOffset, overrides, segments);
    if (t < from) continue;
    if (t > to) break;
    // The downbeat accent follows the segment's own meter, so a 6/8 stretch
    // clicks in six even when the song opened in four.
    let isDownbeat: boolean;
    if (hasSplits(segments)) {
      const seg = segmentForBeat(segments, i);
      const local = i - seg.beatIndexOffset;
      isDownbeat = ((local % seg.beatsPerBar) + seg.beatsPerBar) % seg.beatsPerBar === 0;
    } else {
      isDownbeat = ((i % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
    }
    out.push({ t, isDownbeat });
  }
  return out;
}

/** Fractional cumulative beat count from the grid origin to time `t` — the
 *  counterpart to `beatIndexAt` (which floors to an integer). In a split
 *  song, sums each completed segment's integer beat count, then adds the
 *  fractional remainder inside the segment containing `t`, so a time can be
 *  converted to "how many beats in" even when tempo changes partway through
 *  the span being measured. */
export function beatPositionAt(
  t: number,
  bpm: number,
  gridOffset: number,
  segments?: readonly ResolvedSegment[],
): number {
  if (hasSplits(segments)) {
    const seg = segmentAt(segments, t);
    return seg.beatIndexOffset + (t - seg.start) / seg.beatDur;
  }
  return (t - gridOffset) / beatDuration(bpm);
}

// ─── Bar.beat string conversion (rekordbox-style) ─────────────────────────────
//
// Display format: "bar.beat[.frac]", 1-indexed.
//   "1.1"     = bar 1, beat 1   (= gridOffset)
//   "2.3"     = bar 2, beat 3
//   "2.3.5"   = bar 2, beat 3 + 0.5 of a beat (halfway to beat 4)
//   "2.3.75"  = bar 2, beat 3 + 0.75 of a beat
//
// The third part is a decimal fraction of one beat, written without the leading
// "0." (so "5" means 0.5, "75" means 0.75, "125" means 0.125).

export function timeToBarBeat(
  t: number,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  precision = 3,
  origin: BarBeatOrigin = getBarBeatOrigin(),
  segments?: readonly ResolvedSegment[],
): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0 || beatsPerBar <= 0) return null;

  let barIdx: number;
  let beatInBar: number;
  let frac: number;

  if (hasSplits(segments)) {
    // Each segment counts in its own meter from its own bar 1; the running
    // bar number comes from the table, not from dividing a global index.
    const seg = segmentAt(segments, t);
    const local = (t - seg.start) / seg.beatDur;
    const localRounded = Math.round(local * Math.pow(10, precision)) / Math.pow(10, precision);
    const barLocal = Math.floor(localRounded / seg.beatsPerBar);
    barIdx = seg.barNumberOffset + barLocal;
    beatInBar = Math.floor(localRounded - barLocal * seg.beatsPerBar);
    frac = localRounded - barLocal * seg.beatsPerBar - beatInBar;
  } else {
    const totalBeats = beatPositionAt(t, bpm, gridOffset);
    // Round to the displayed precision in beats so the round-trip is stable
    // (e.g. 2.999999 doesn't render as bar 1, beat 4, frac 0.999...).
    const beatsRounded = Math.round(totalBeats * Math.pow(10, precision)) / Math.pow(10, precision);
    barIdx = Math.floor(beatsRounded / beatsPerBar);
    beatInBar = Math.floor(beatsRounded - barIdx * beatsPerBar);
    frac = beatsRounded - barIdx * beatsPerBar - beatInBar;
  }

  const barDisplay = barIdx + origin;
  const beatDisplay = beatInBar + origin;

  if (frac < Math.pow(10, -(precision + 1))) {
    return `${barDisplay}.${beatDisplay}`;
  }
  const fracStr = frac.toFixed(precision).slice(2).replace(/0+$/, '');
  return fracStr ? `${barDisplay}.${beatDisplay}.${fracStr}` : `${barDisplay}.${beatDisplay}`;
}

export function barBeatToTime(
  s: string,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  origin: BarBeatOrigin = getBarBeatOrigin(),
  segments?: readonly ResolvedSegment[],
): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0 || beatsPerBar <= 0) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('.');
  if (parts.length < 1 || parts.length > 3) return null;

  const bar = parseInt(parts[0], 10);
  const beat = parts.length >= 2 && parts[1] !== '' ? parseInt(parts[1], 10) : origin;
  if (!Number.isFinite(bar) || !Number.isFinite(beat) || beat < origin) return null;

  let frac = 0;
  if (parts.length === 3 && parts[2] !== '') {
    if (!/^\d+$/.test(parts[2])) return null;
    const f = parseFloat('0.' + parts[2]);
    if (!Number.isFinite(f) || f < 0 || f >= 1) return null;
    frac = f;
  }

  // Split songs: find the segment owning this bar number, then count in that
  // segment's meter from its own bar 1. Under 'restart' numbering every
  // segment has a bar 1, so a bare bar number resolves to the earliest
  // segment that has it — the same ambiguity a score has, and the reason
  // 'continue' is the default.
  if (hasSplits(segments)) {
    const barIdx = bar - origin;
    const beatInBar = beat - origin;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const withinLast = i === segments.length - 1;
      const beyond = seg.barNumberOffset + seg.barCount;
      if (barIdx < seg.barNumberOffset && i > 0) continue;
      if (withinLast || barIdx < beyond) {
        const local = (barIdx - seg.barNumberOffset) * seg.beatsPerBar + beatInBar + frac;
        return seg.start + local * seg.beatDur;
      }
    }
    const last = segments[segments.length - 1];
    const local = (barIdx - last.barNumberOffset) * last.beatsPerBar + beatInBar + frac;
    return last.start + local * last.beatDur;
  }

  const totalBeats = (bar - origin) * beatsPerBar + (beat - origin) + frac;
  return gridOffset + totalBeats * (60 / bpm);
}

/** A grid subdivision snapping can land on. 'beat' = every beat; 'bar' =
 *  every bar; 'Nbar' = every N bars (N = 2, 4, 8, 16…).
 *
 *  The sub-beat rungs come in two families, because a beat divides two ways
 *  that never meet in between: binary (1/2, 1/4, 1/8) and triplet (1/3, 1/6).
 *  Both are here for one reason — the beat-grid unit selector offers both, and
 *  a snap that cannot express the unit the user is looking at will quietly
 *  round their annotation onto a line that isn't drawn. */
export type SnapDivision =
  | 'beat' | 'bar' | `${number}bar`
  | '1/2beat' | '1/4beat' | '1/8beat'
  | '1/3beat' | '1/6beat';

/** Narrowest snap step a hand can actually aim at, in screen pixels.
 *
 *  A five-minute song drawn at fit zoom is about 4.5 px per second, so at
 *  100 BPM one beat is under 3 px. Snapping in 3 px steps is not a snap the
 *  annotator can see or steer — the band just slides under the pointer, which
 *  is exactly what "Grid Lock is on but nothing snaps" means in practice. The
 *  Prominence lane already reasons in pixels for the same reason (see
 *  MAGNET_REACH_PX in LeadLaneRow). */
export const MIN_SNAP_STEP_PX = 6;

/** The ladders a too-fine snap is widened along. Every entry is a whole
 *  multiple of the one before it, so coarsening only ever removes landing
 *  spots — it never moves the grid off the finer lines.
 *
 *  Two ladders, because that invariant is exactly what a beat's two families
 *  do not share: 1/2 is not a whole multiple of 1/3, so widening a triplet
 *  along the binary rungs would slide every landing spot off the triplet grid
 *  the user can see. A triplet division therefore coarsens 1/6 → 1/3 → beat
 *  and only then joins the common bar rungs, where the two families agree
 *  again. */
const BINARY_SNAP_LADDER: readonly SnapDivision[] = ['1/8beat', '1/4beat', '1/2beat', 'beat', 'bar', '2bar', '4bar', '8bar'];
const TRIPLET_SNAP_LADDER: readonly SnapDivision[] = ['1/6beat', '1/3beat', 'beat', 'bar', '2bar', '4bar', '8bar'];

function snapLadderFor(division: SnapDivision): readonly SnapDivision[] {
  return division === '1/3beat' || division === '1/6beat'
    ? TRIPLET_SNAP_LADDER : BINARY_SNAP_LADDER;
}

/**
 * Widen `division` until one step is at least `minPx` wide on screen.
 *
 * Zoom is what decides whether a beat is a target or a blur: at fit zoom a
 * beat is a couple of pixels and the musically honest unit is the bar; zoomed
 * in, the same rule hands the beat (or the sixteenth) straight back. Same
 * adaptive grid a DAW gives you, and the same reasoning the Prominence lane's
 * pixel-sized magnet zone already uses.
 *
 * `pxPerSec` of 0 (unknown width) or a missing BPM leaves the division alone.
 */
export function coarsenSnapDivision(
  division: SnapDivision,
  bpm: number,
  beatsPerBar: number,
  pxPerSec: number,
  minPx: number = MIN_SNAP_STEP_PX,
): SnapDivision {
  if (!(pxPerSec > 0) || !Number.isFinite(bpm) || bpm <= 0) return division;
  const widthPx = (d: SnapDivision) => (60 / bpm) * unitBeats(d, beatsPerBar) * pxPerSec;
  if (widthPx(division) >= minPx) return division;
  // A division off the ladder ('3bar', '16bar') is already coarser than a bar;
  // it can only have failed the test on a very long track, so continue from
  // the bar rung rather than pretending it was a sub-beat.
  const ladder = snapLadderFor(division);
  const from = ladder.indexOf(division);
  const start = from >= 0 ? from + 1 : ladder.indexOf('bar');
  for (let i = start; i < ladder.length; i++) {
    if (widthPx(ladder[i]) >= minPx) return ladder[i];
  }
  return ladder[ladder.length - 1];
}

// Snap an arbitrary time to the nearest grid line at the given subdivision.
// 'beat' = every beat; 'bar' = every bar; 'Nbar' = every N bars (N=2,4,8,16…).
// Negative results are clamped to 0 — annotations live in [0, duration].
//
// In a split song the snap is performed within the local segment, using that
// segment's bpm and start as the period and origin.
//
// When `overrides` is supplied (Manual mode), the macro snap is computed
// first; then the snapped *cumulative beat index* is looked up in
// `overrides`. If the user has pinned that beat to a different time, the
// override wins. Snap behavior is therefore consistent with what the user
// sees on the emerald grid strip.
export function snapTimeToGrid(
  time: number,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  division: SnapDivision,
  overrides?: Readonly<Record<string, number>>,
  /** Magnetic assist: when set, only snap if the grid line is within this many
   *  seconds of `time`. Anything further away is a deliberate off-grid
   *  placement (a laid-back vocal, a pushed stab) and is returned untouched.
   *  Omit for the classic always-snap behaviour. */
  toleranceSec?: number,
  segments?: readonly ResolvedSegment[],
): number {
  if (hasSplits(segments)) {
    const seg = segmentAt(segments, time);
    const unitSeg = unitBeats(division, seg.beatsPerBar);
    const period = seg.beatDur * unitSeg;
    const n = Math.round((time - seg.start) / period);
    const snapped = Math.max(0, seg.start + n * period);
    const beatIndex = seg.beatIndexOffset + n * unitSeg;
    if (Number.isInteger(beatIndex)) {
      const pinned = segmentOverrideAt(overrides, seg, beatIndex);
      if (pinned != null) {
        const at = Math.max(0, pinned);
        if (toleranceSec != null && Math.abs(at - time) > toleranceSec) return time;
        return at;
      }
    }
    if (toleranceSec != null && Math.abs(snapped - time) > toleranceSec) return time;
    return snapped;
  }
  const unit = unitBeats(division, beatsPerBar);
  const period = (60 / bpm) * unit;
  const n = Math.round((time - gridOffset) / period);
  const snappedTime = Math.max(0, gridOffset + n * period);
  const snappedBeatIndex = n * unit;
  if (overrides && Number.isInteger(snappedBeatIndex)) {
    const v = overrides[String(snappedBeatIndex)];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const overridden = Math.max(0, v);
      if (toleranceSec != null && Math.abs(overridden - time) > toleranceSec) return time;
      return overridden;
    }
  }
  if (toleranceSec != null && Math.abs(snappedTime - time) > toleranceSec) return time;
  return snappedTime;
}

function unitBeats(division: string, beatsPerBar: number): number {
  if (division === '1/8beat') return 0.125;
  if (division === '1/6beat') return 1 / 6;
  if (division === '1/4beat') return 0.25;
  if (division === '1/3beat') return 1 / 3;
  if (division === '1/2beat') return 0.5;
  if (division === 'beat') return 1;
  if (division === 'bar') return beatsPerBar;
  const m = /^(\d+)bar$/.exec(division);
  return m ? parseInt(m[1], 10) * beatsPerBar : beatsPerBar;
}

/** Returns the display-numbered bar and beat (within bar) for time `t`, plus a
 *  decimal-bars value (useful for compact display). `origin` is the number the
 *  first bar / first beat carry — 1 for musician-style counting, 0 for
 *  zero-based; see setBarBeatOrigin above. */
export function formatBeatPosition(
  t: number,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  origin: BarBeatOrigin = getBarBeatOrigin(),
  segments?: readonly ResolvedSegment[],
): { bar: number; beat: number; fracBars: number } {
  if (hasSplits(segments)) {
    const seg = segmentAt(segments, t);
    const local = Math.floor((t - seg.start) / seg.beatDur + SEG_EPSILON);
    const barLocal = Math.floor(local / seg.beatsPerBar);
    const beat0 = local - barLocal * seg.beatsPerBar;
    const bar0 = seg.barNumberOffset + barLocal;
    return { bar: bar0 + origin, beat: beat0 + origin, fracBars: bar0 + beat0 / seg.beatsPerBar };
  }
  const bi = beatIndexAt(t, bpm, gridOffset);
  const bar0 = Math.floor(bi / beatsPerBar);
  const beat0 = ((bi % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const fracBars = bi / beatsPerBar;
  return { bar: bar0 + origin, beat: beat0 + origin, fracBars };
}

export interface GridLine {
  /** Time in seconds. When an override applies at this beat index, `t` is
   *  the override value (not the macro-computed time). */
  t: number;
  /** Beat index from grid origin (negative for beats before bar 1). Fractional for sub-beat lines. */
  beatIndex: number;
  /** True if this beat starts a bar. */
  isBar: boolean;
  /** Display bar number of the bar this line belongs to, already offset by the
   *  active `barBeatOrigin` (so the first bar reads 1 or 0 per the setting).
   *  Meaningful only when `isBar` — gate on that, not on the value, since a
   *  zero-based grid has a real bar 0. */
  barNumber: number;
  /** True if this bar is also a phrase boundary (every 4 bars by default). */
  isPhrase: boolean;
  /** True if this line falls between beats (8th-note, 16th-note, etc.). */
  isSubBeat?: boolean;
  /** True when `t` came from a per-beat override (Manual mode) rather than
   *  the macro tempo math. Renderers can use this to color the line
   *  differently and to show "pinned" tooltips. */
  isOverridden?: boolean;
}

export interface VisibleGridOptions {
  bpm: number;
  gridOffset: number;
  beatsPerBar: number;
  /** Earliest time (seconds) to include. */
  startTime: number;
  /** Latest time (seconds) to include. */
  endTime: number;
  /** Phrase length in bars (default 4). */
  phraseBars?: number;
  /** If set, only emit bar boundaries every N bars (no sub-beats). */
  barGroupSize?: number | null;
  /**
   * Subdivide each beat into N equal parts (2 = 8th notes, 4 = 16th notes,
   * 3 = 8th triplets, 6 = 16th triplets, 8 = 32nd notes).
   * Ignored when barGroupSize is set. Default 1 = no subdivision.
   */
  subBeatDivision?: number;
  /**
   * Only emit lines every N beats (anchored at beat 0). Used for the compound
   * pulse in 6/8, 9/8, 12/8 where a "felt" beat groups 3 notated beats.
   * Ignored when barGroupSize or subBeatDivision (>1) is set.
   */
  beatGroupSize?: number;
  /** Drop lines at t < 0 (default true — there is no audio before zero). */
  clipToZero?: boolean;
  /**
   * Per-beat overrides (Manual mode). Sparse map keyed by global integer
   * beat index → absolute timestamp in seconds. When provided, the emitter
   * replaces the macro time of any matching integer beat with the override
   * value and marks `GridLine.isOverridden = true`. Sub-beat lines are
   * unaffected — overrides only apply to integer beat indices.
   */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Number carried by the first bar / first beat when rendering `barNumber`.
   *  Defaults to the active display origin (see setBarBeatOrigin). */
  barBeatOrigin?: BarBeatOrigin;
  /**
   * Resolved grid segments. When the table holds more than one segment, it
   * replaces the static path: every segment draws its own tempo, its own
   * meter and its own bar 1, and the bar the previous
   * segment was in the middle of is simply cut where the next one starts.
   * One segment (or none) leaves every other path untouched.
   */
  segments?: readonly ResolvedSegment[];
}

/** A single contiguous tempo region, used by the per-region grid emitter. */
interface GridRegion {
  bpm: number;
  origin: number;          // segment's "beat 0" time (= segment start, or gridOffset)
  beatIndexOffset: number; // cumulative integer beats from global origin to `origin`
  regionMinT: number;
  regionMaxT: number;
  /** When true, lines at exactly `regionMaxT` are not emitted — the next
   *  segment owns that boundary. Used to keep segment boundaries from
   *  emitting a duplicate line on both sides. */
  excludeRight?: boolean;
  /** Meter for this region. Grid segments carry their own; the static path
   *  leaves it unset and inherits `opts.beatsPerBar`. */
  beatsPerBar?: number;
  /** Bar number this region opens on. Set only by grid segments, where the
   *  bar count is carried forward by the segment table rather than derived
   *  from a global beat index — the two disagree the moment a segment is cut
   *  mid-bar or changes meter. */
  barNumberOffset?: number;
  /** Segment owning this region, for scoped beat-override lookups. */
  segment?: ResolvedSegment;
}

/**
 * Compute every beat / bar line that intersects the visible window.
 * Walks integer beat indices directly to avoid float drift.
 *
 * When `opts.segments` holds a split, the timeline is divided into regions
 * (one per segment) and the emitter runs once per region.
 */
export function visibleGridLines(opts: VisibleGridOptions): GridLine[] {
  const {
    bpm, gridOffset,
    startTime, endTime,
    clipToZero = true,
  } = opts;

  if (!Number.isFinite(bpm) || bpm <= 0 || endTime <= startTime) return [];

  const minT = clipToZero ? Math.max(0, startTime) : startTime;
  const lines: GridLine[] = [];

  if (hasSplits(opts.segments)) {
    // Segment path. One region per segment, each with its own tempo, meter
    // and opening bar number. Non-final segments exclude their right edge so
    // the head line is emitted once, by the segment that starts there.
    const segments = opts.segments;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segEnd = Number.isFinite(seg.end) ? seg.end : endTime;
      if (segEnd <= startTime || seg.start >= endTime) continue;
      emitGridLinesForRegion(opts, {
        bpm: seg.bpm,
        origin: seg.start,
        beatIndexOffset: seg.beatIndexOffset,
        regionMinT: Math.max(minT, i === 0 ? Number.NEGATIVE_INFINITY : seg.start),
        regionMaxT: Math.min(endTime, segEnd),
        excludeRight: i + 1 < segments.length,
        beatsPerBar: seg.beatsPerBar,
        barNumberOffset: seg.barNumberOffset,
        segment: seg,
      }, lines);
    }
    return lines;
  }

  // Static-BPM path. One region spanning the requested window.
  emitGridLinesForRegion(opts, {
    bpm, origin: gridOffset, beatIndexOffset: 0,
    regionMinT: minT, regionMaxT: endTime,
  }, lines);
  return lines;
}

/** Shared inner loop. Original single-tempo logic with two adaptations:
 *    - `region.bpm` / `region.origin` replace `bpm` / `gridOffset` for the
 *      step grid, so each segment's beats are spaced by its own tempo.
 *    - `region.beatIndexOffset` is added when computing `n` for the bar
 *      number / phrase math so a split song keeps continuous bar
 *      numbering. The static path passes 0 → no behavior change. */
function emitGridLinesForRegion(
  opts: VisibleGridOptions,
  region: GridRegion,
  into: GridLine[],
): void {
  const {
    beatsPerBar,
    startTime, endTime,
    phraseBars = 4,
    barGroupSize = null,
    subBeatDivision = 1,
    beatGroupSize = 1,
    clipToZero = true,
    beatOverrides,
    barBeatOrigin = getBarBeatOrigin(),
  } = opts;
  const { bpm: regionBpm, origin, beatIndexOffset, regionMinT, regionMaxT } = region;
  // Grid segments count bars in their own meter, from their own bar 1.
  const regionBeatsPerBar = region.beatsPerBar ?? beatsPerBar;
  const segmentBars = region.barNumberOffset != null;
  if (!Number.isFinite(regionBpm) || regionBpm <= 0 || regionMaxT <= regionMinT) return;

  const dBeat = 60 / regionBpm;

  // Sub-beat mode (8th/16th notes). Only meaningful in dense mode.
  const div = barGroupSize == null && Number.isFinite(subBeatDivision) && subBeatDivision > 1
    ? Math.floor(subBeatDivision) : 1;
  const dStep = dBeat / div;

  const firstStep = Math.floor((regionMinT - origin) / dStep);
  const lastStep  = Math.ceil((regionMaxT - origin) / dStep);

  const EPS = 1e-9;
  for (let m = firstStep; m <= lastStep; m++) {
    const macroT = origin + m * dStep;
    if (clipToZero && macroT < 0) continue;
    if (macroT < startTime - EPS || macroT > endTime + EPS) continue;
    if (macroT < regionMinT - EPS || macroT > regionMaxT + EPS) continue;
    if (region.excludeRight && macroT >= regionMaxT - EPS) continue;

    const isBeat = ((m % div) + div) % div === 0;
    // Local beat index inside this region.
    const nLocal = m / div;
    // Cumulative beat index from the global origin — used for bar / phrase
    // math so continuity is preserved across segments.
    const n = nLocal + beatIndexOffset;
    // Segments number bars from the table (a cut bar still spends a number,
    // and meters differ per segment, so a global index can't be divided);
    // the static path keeps dividing the global beat index.
    const barIdx = segmentBars
      ? region.barNumberOffset! + Math.floor(nLocal / regionBeatsPerBar)
      : Math.floor(n / regionBeatsPerBar);
    const isBar = isBeat && (segmentBars
      ? nLocal - Math.floor(nLocal / regionBeatsPerBar) * regionBeatsPerBar === 0
      : n - barIdx * regionBeatsPerBar === 0);

    // Apply per-beat override (Manual mode). Only integer beats are
    // override-eligible — sub-beats stay on the macro grid even when their
    // bounding beats are pinned. Override moves the position only;
    // bar/phrase classification is derived from `n` and stays put.
    let t = macroT;
    let overridden = false;
    if (beatOverrides && isBeat && Number.isInteger(n)) {
      const v = region.segment
        ? segmentOverrideAt(beatOverrides, region.segment, n)
        : beatOverrides[String(n)];
      if (typeof v === 'number' && Number.isFinite(v)) {
        t = v;
        overridden = true;
      }
    }

    if (barGroupSize != null) {
      if (!isBar) continue;
      // Group bars from barIdx 0 (bar 1). Negative bars never align unless barGroupSize divides them.
      if (((barIdx % barGroupSize) + barGroupSize) % barGroupSize !== 0) continue;
      const isPhrase = ((barIdx % (phraseBars * barGroupSize)) + phraseBars * barGroupSize) % (phraseBars * barGroupSize) === 0;
      into.push({ t, beatIndex: n, isBar: true, barNumber: barIdx + barBeatOrigin, isPhrase, isOverridden: overridden || undefined });
    } else if (div === 1 && beatGroupSize > 1) {
      // Compound-pulse mode: only emit every Nth beat (anchored at beat 0 —
      // the segment's own beat 0 when the song is split, so the pulse
      // regroups from each segment head rather than from the song origin).
      if (!isBeat) continue;
      const pulseIndex = segmentBars ? nLocal : n;
      if (((pulseIndex % beatGroupSize) + beatGroupSize) % beatGroupSize !== 0) continue;
      const isPhrase = isBar && (((barIdx % phraseBars) + phraseBars) % phraseBars === 0);
      into.push({
        t, beatIndex: n, isBar,
        barNumber: barIdx + barBeatOrigin,
        isPhrase,
        isOverridden: overridden || undefined,
      });
    } else {
      const isPhrase = isBar && (((barIdx % phraseBars) + phraseBars) % phraseBars === 0);
      into.push({
        t, beatIndex: n, isBar,
        barNumber: barIdx + barBeatOrigin,
        isPhrase,
        isSubBeat: !isBeat,
        isOverridden: overridden || undefined,
      });
    }
  }
}

/**
 * Width multiplier for beat-grid lines at a given player zoom, so the grid
 * reads as hairlines when the whole song is on screen and thickens as you
 * zoom into a handful of bars. `zoomFactor` is the player's multiplier
 * relative to fit (1 = fit, 2 = ×2 …).
 *
 * The curve is √zoom — line spacing grows linearly with zoom, so a square
 * root keeps the ink-to-gap ratio from swinging as hard as the spacing does.
 * It is normalized so ×6.25 lands on the unscaled 1× width, and clamped to
 * [0.4, 2] so a fit view still shows the grid and a deep zoom never turns
 * bars into slabs.
 */
export function adaptiveGridThicknessScale(zoomFactor: number): number {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return 1;
  return Math.max(0.4, Math.min(2, Math.sqrt(zoomFactor) / 2.5));
}
