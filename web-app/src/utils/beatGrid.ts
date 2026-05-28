// Single source of truth for beat/bar grid math.
//
// Convention (matches Rekordbox "Set Grid"):
//   - bpm: tempo in beats per minute (B).
//   - gridOffset: time in seconds where bar 1 / beat 1 sits (T_offset, >= 0).
//   - beatsPerBar: numerator of the time signature.
//
// For any time t (seconds):
//   beatIndex   = floor((t - T_offset) / dBeat)   // can be negative
//   beatTime(i) = T_offset + i * dBeat
//   barIndex    = floor(beatIndex / beatsPerBar)  // can be negative
//
// Bar 1 in the UI = barIndex 0 (the bar that starts at gridOffset).
//
// ─── Tempo Anchors (Dynamic / Manual adjustment modes) ───────────────────────
//
// A song may carry a sparse `TempoAnchor[]` (see types/songInfo.ts) that
// makes tempo piecewise-constant over time:
//
//   - Each anchor is { timestamp, bpm } and marks the START of a segment
//     whose tempo is `bpm`. The segment runs until the next anchor (or end
//     of audio).
//   - For times *before* the first anchor — and for songs with zero anchors —
//     the legacy global bpm + gridOffset applies (Static BPM mode).
//   - Helpers below take an optional `anchors` argument. When omitted or
//     empty, every helper degrades to the legacy single-tempo behavior
//     byte-for-byte. Static-path callers pay no overhead beyond a null check.

import type { TempoAnchor } from '../types/songInfo';

export const TIME_SIGNATURES_TO_BEATS: Record<string, number> = {
  '4/4': 4, '3/4': 3, '6/8': 6, '5/4': 5, '7/8': 7, '2/4': 2, '12/8': 12,
};

export function beatsPerBarFromTimeSignature(ts: string | undefined): number {
  if (!ts) return 4;
  if (TIME_SIGNATURES_TO_BEATS[ts] != null) return TIME_SIGNATURES_TO_BEATS[ts];
  const num = parseInt(ts.split('/')[0] ?? '', 10);
  return Number.isFinite(num) && num > 0 ? num : 4;
}

export function beatDuration(bpm: number): number {
  return 60 / bpm;
}

export function barDuration(bpm: number, beatsPerBar: number): number {
  return beatDuration(bpm) * beatsPerBar;
}

// Floor that handles negatives like Python (so beatIndex of t<offset is correctly negative).
// JS's Math.floor already does this; the wrapper exists to make intent explicit.
//
// When `anchors` is provided and `t` falls inside an anchor segment, the
// returned index is the *cumulative* beat count from the global origin, so
// bar numbering stays continuous across segments. For `t` before the first
// anchor (or no anchors), the legacy formula applies unchanged.
export function beatIndexAt(
  t: number,
  bpm: number,
  gridOffset: number,
  anchors?: readonly TempoAnchor[],
): number {
  const idx = findBoundingAnchorIndex(anchors, t);
  if (idx < 0) return Math.floor((t - gridOffset) / beatDuration(bpm));
  const anchor = anchors![idx];
  const cum = cumulativeBeatsAtAnchor(anchors, idx, bpm, gridOffset);
  return cum + Math.floor((t - anchor.timestamp) / beatDuration(anchor.bpm));
}

export function barIndexAt(
  t: number,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  anchors?: readonly TempoAnchor[],
): number {
  return Math.floor(beatIndexAt(t, bpm, gridOffset, anchors) / beatsPerBar);
}

// Inverse of beatIndexAt: given a (possibly cumulative) beat index, return
// the absolute time. For anchored mode, walks segments until the requested
// index is found. When `overrides` is supplied and the requested index has
// an entry, the override value short-circuits the macro math — used by
// Manual-mode micro-overrides (see SongInfo.beatOverrides).
export function beatTimeAt(
  beatIndex: number,
  bpm: number,
  gridOffset: number,
  anchors?: readonly TempoAnchor[],
  overrides?: Readonly<Record<string, number>>,
): number {
  if (overrides && Number.isInteger(beatIndex)) {
    const v = overrides[String(beatIndex)];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  if (!anchors || anchors.length === 0) {
    return gridOffset + beatIndex * beatDuration(bpm);
  }
  // Beats before the first anchor — legacy formula still applies, because
  // segment-0 (pre-anchor) shares the global bpm + offset.
  const cum0 = cumulativeBeatsAtAnchor(anchors, 0, bpm, gridOffset);
  if (beatIndex < cum0) return gridOffset + beatIndex * beatDuration(bpm);
  // Find the segment that contains this beat index.
  let cum = cum0;
  for (let i = 0; i < anchors.length; i++) {
    const nextCum = i + 1 < anchors.length
      ? cum + Math.max(0, Math.round((anchors[i + 1].timestamp - anchors[i].timestamp) / beatDuration(anchors[i].bpm)))
      : Number.POSITIVE_INFINITY;
    if (beatIndex < nextCum) {
      return anchors[i].timestamp + (beatIndex - cum) * beatDuration(anchors[i].bpm);
    }
    cum = nextCum;
  }
  // Unreachable — the last segment runs to +∞.
  return anchors[anchors.length - 1].timestamp;
}

// ─── Anchor lookups (Dynamic / Manual adjustment) ────────────────────────────
//
// Pure read helpers. They never mutate the array, never sort — the caller is
// responsible for ensuring `anchors` is normalized (sorted ascending, no
// near-duplicates). See normalizeAnchors() in types/songInfo.ts.
//
// All anchor inputs are treated as readonly. Passing `undefined` or `[]` makes
// the helpers behave as if there are no anchors at all, so callers can pass
// `info?.tempoAnchors` directly without a null check.

/** Index of the latest anchor with `timestamp <= t`. Returns -1 when `t`
 *  is before the first anchor, or when the array is empty / absent. */
export function findBoundingAnchorIndex(
  anchors: readonly TempoAnchor[] | undefined,
  t: number,
): number {
  if (!anchors || anchors.length === 0) return -1;
  // Anchors are pre-sorted; a linear scan is fine for the sparse counts we
  // expect (a few dozen at most). Binary search would only matter at 10⁴+
  // anchors, which is not a use case here.
  let idx = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].timestamp <= t) idx = i;
    else break;
  }
  return idx;
}

/** The anchor whose segment contains time `t`, or null when `t` is before
 *  the first anchor (use the legacy global bpm + gridOffset in that case). */
export function findBoundingAnchor(
  anchors: readonly TempoAnchor[] | undefined,
  t: number,
): TempoAnchor | null {
  const i = findBoundingAnchorIndex(anchors, t);
  return i < 0 ? null : anchors![i];
}

/** Local tempo (BPM) at time `t`. Falls back to `fallbackBpm` when `t` is
 *  before the first anchor or no anchors are present. */
export function anchorSegmentBpm(
  anchors: readonly TempoAnchor[] | undefined,
  t: number,
  fallbackBpm: number,
): number {
  const a = findBoundingAnchor(anchors, t);
  return a ? a.bpm : fallbackBpm;
}

/** Local "beat 0" time for the segment containing `t`. For times inside an
 *  anchor segment, this is the anchor's timestamp; otherwise the legacy
 *  `fallbackOffset` (= songInfo.gridOffset). */
export function anchorSegmentOrigin(
  anchors: readonly TempoAnchor[] | undefined,
  t: number,
  fallbackOffset: number,
): number {
  const a = findBoundingAnchor(anchors, t);
  return a ? a.timestamp : fallbackOffset;
}

/** Cumulative integer-beat count from the global origin to the start of
 *  segment `idx`. Used by helpers that must keep bar numbering continuous
 *  across anchors (so a song never has two "bar 1"s).
 *
 *  Convention: anchors land on beat boundaries of the *previous* segment.
 *  For each segment, the integer beat count is `round((next.timestamp -
 *  this.timestamp) / dBeat)`; the round() tolerates the inherent drift in
 *  user-dragged or analyzer-derived anchors. The drag/derivation logic
 *  (anchorEdit.ts, Checkpoint B6) keeps that drift sub-millisecond.
 *
 *  For `idx <= 0` or empty anchors, returns the segment-0 beat count from
 *  the legacy formula: floor((anchors[0].timestamp - fallbackOffset) /
 *  dBeat_fallback). Returns 0 when no anchors exist. */
export function cumulativeBeatsAtAnchor(
  anchors: readonly TempoAnchor[] | undefined,
  idx: number,
  fallbackBpm: number,
  fallbackOffset: number,
): number {
  if (!anchors || anchors.length === 0 || idx < 0) return 0;
  const dBeat0 = beatDuration(fallbackBpm);
  // Beats from the legacy origin to the first anchor.
  let cum = Math.round((anchors[0].timestamp - fallbackOffset) / dBeat0);
  if (cum < 0) cum = 0;
  for (let i = 0; i < Math.min(idx, anchors.length - 1); i++) {
    const dBeat = beatDuration(anchors[i].bpm);
    const segBeats = Math.round((anchors[i + 1].timestamp - anchors[i].timestamp) / dBeat);
    cum += Math.max(0, segBeats);
  }
  return cum;
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
  anchors?: readonly TempoAnchor[],
): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0 || beatsPerBar <= 0) return null;
  // Cumulative beats from origin to `t`, kept fractional. In anchored mode,
  // sum the integer beat-count of each completed segment, then add the
  // fractional remainder inside the bounding segment.
  let totalBeats: number;
  const idx = findBoundingAnchorIndex(anchors, t);
  if (idx < 0) {
    totalBeats = (t - gridOffset) / (60 / bpm);
  } else {
    const cum = cumulativeBeatsAtAnchor(anchors, idx, bpm, gridOffset);
    const a = anchors![idx];
    totalBeats = cum + (t - a.timestamp) / (60 / a.bpm);
  }
  // Round to the displayed precision in beats so the round-trip is stable
  // (e.g. 2.999999 doesn't render as bar 1, beat 4, frac 0.999...).
  const beatsRounded = Math.round(totalBeats * Math.pow(10, precision)) / Math.pow(10, precision);
  const barIdx = Math.floor(beatsRounded / beatsPerBar);
  const beatInBar = Math.floor(beatsRounded - barIdx * beatsPerBar);
  const frac = beatsRounded - barIdx * beatsPerBar - beatInBar;

  const barDisplay = barIdx + 1;
  const beatDisplay = beatInBar + 1;

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
  anchors?: readonly TempoAnchor[],
): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0 || beatsPerBar <= 0) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('.');
  if (parts.length < 1 || parts.length > 3) return null;

  const bar = parseInt(parts[0], 10);
  const beat = parts.length >= 2 && parts[1] !== '' ? parseInt(parts[1], 10) : 1;
  if (!Number.isFinite(bar) || !Number.isFinite(beat) || beat < 1) return null;

  let frac = 0;
  if (parts.length === 3 && parts[2] !== '') {
    if (!/^\d+$/.test(parts[2])) return null;
    const f = parseFloat('0.' + parts[2]);
    if (!Number.isFinite(f) || f < 0 || f >= 1) return null;
    frac = f;
  }

  const totalBeats = (bar - 1) * beatsPerBar + (beat - 1) + frac;
  // Walk segments until the cumulative beat count contains `totalBeats`.
  if (anchors && anchors.length > 0) {
    const cum0 = cumulativeBeatsAtAnchor(anchors, 0, bpm, gridOffset);
    if (totalBeats < cum0) return gridOffset + totalBeats * (60 / bpm);
    let cum = cum0;
    for (let i = 0; i < anchors.length; i++) {
      const segBeats = i + 1 < anchors.length
        ? Math.max(0, Math.round((anchors[i + 1].timestamp - anchors[i].timestamp) / (60 / anchors[i].bpm)))
        : Number.POSITIVE_INFINITY;
      if (totalBeats < cum + segBeats) {
        return anchors[i].timestamp + (totalBeats - cum) * (60 / anchors[i].bpm);
      }
      cum += segBeats;
    }
  }
  return gridOffset + totalBeats * (60 / bpm);
}

// Snap an arbitrary time to the nearest grid line at the given subdivision.
// 'beat' = every beat; 'bar' = every bar; 'Nbar' = every N bars (N=2,4,8,16…).
// Negative results are clamped to 0 — annotations live in [0, duration].
//
// In anchored mode (Dynamic / Manual adjustment), the snap is performed
// within the local segment using the bounding anchor's bpm and timestamp
// as the period and origin. The snapped result may cross a segment
// boundary; that's accepted — the visual grid handles the transition.
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
  division: 'beat' | 'bar' | `${number}bar`,
  anchors?: readonly TempoAnchor[],
  overrides?: Readonly<Record<string, number>>,
): number {
  const unit = unitBeats(division, beatsPerBar);
  const anchor = findBoundingAnchor(anchors, time);
  let snappedTime: number;
  let snappedBeatIndex: number;
  if (anchor) {
    const idx = findBoundingAnchorIndex(anchors, time);
    const period = (60 / anchor.bpm) * unit;
    const n = Math.round((time - anchor.timestamp) / period);
    snappedTime = Math.max(0, anchor.timestamp + n * period);
    const cum = cumulativeBeatsAtAnchor(anchors, idx, bpm, gridOffset);
    snappedBeatIndex = cum + n * unit;
  } else {
    const period = (60 / bpm) * unit;
    const n = Math.round((time - gridOffset) / period);
    snappedTime = Math.max(0, gridOffset + n * period);
    snappedBeatIndex = n * unit;
  }
  if (overrides && Number.isInteger(snappedBeatIndex)) {
    const v = overrides[String(snappedBeatIndex)];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  }
  return snappedTime;
}

function unitBeats(division: string, beatsPerBar: number): number {
  if (division === 'beat') return 1;
  if (division === 'bar') return beatsPerBar;
  const m = /^(\d+)bar$/.exec(division);
  return m ? parseInt(m[1], 10) * beatsPerBar : beatsPerBar;
}

export interface GridLine {
  /** Time in seconds. When an override applies at this beat index, `t` is
   *  the override value (not the macro-computed time). */
  t: number;
  /** Beat index from grid origin (negative for beats before bar 1). Fractional for sub-beat lines. */
  beatIndex: number;
  /** True if this beat starts a bar. */
  isBar: boolean;
  /** Bar number, 1-indexed for display (0 if not a bar boundary). */
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
   * Tempo anchors. When provided and non-empty, the grid becomes piecewise
   * constant per segment. Bar numbering remains continuous across segments
   * (so a song never shows two "bar 1"s). When omitted or empty, behavior
   * is identical to the legacy single-tempo path.
   */
  anchors?: readonly TempoAnchor[];
  /**
   * Per-beat overrides (Manual mode). Sparse map keyed by global integer
   * beat index → absolute timestamp in seconds. When provided, the emitter
   * replaces the macro time of any matching integer beat with the override
   * value and marks `GridLine.isOverridden = true`. Sub-beat lines are
   * unaffected — overrides only apply to integer beat indices.
   */
  beatOverrides?: Readonly<Record<string, number>>;
}

/** A single contiguous tempo region, used by the per-region grid emitter. */
interface GridRegion {
  bpm: number;
  origin: number;          // segment's "beat 0" time (= anchor timestamp, or gridOffset)
  beatIndexOffset: number; // cumulative integer beats from global origin to `origin`
  regionMinT: number;
  regionMaxT: number;
  /** When true, lines at exactly `regionMaxT` are not emitted — the next
   *  segment owns that boundary. Used to keep anchor boundaries from
   *  emitting a duplicate line on both sides. */
  excludeRight?: boolean;
}

/**
 * Compute every beat / bar line that intersects the visible window.
 * Walks integer beat indices directly to avoid float drift.
 *
 * When `opts.anchors` is provided, the timeline is divided into regions
 * (one per anchor segment, plus an optional pre-anchor region using the
 * global bpm/gridOffset) and the emitter runs once per region. Bar
 * numbering stays continuous across regions via `beatIndexOffset`.
 */
export function visibleGridLines(opts: VisibleGridOptions): GridLine[] {
  const {
    bpm, gridOffset,
    startTime, endTime,
    clipToZero = true,
    anchors,
  } = opts;

  if (!Number.isFinite(bpm) || bpm <= 0 || endTime <= startTime) return [];

  const minT = clipToZero ? Math.max(0, startTime) : startTime;
  const lines: GridLine[] = [];

  if (!anchors || anchors.length === 0) {
    // Static-BPM path. One region spanning the requested window.
    emitGridLinesForRegion(opts, {
      bpm, origin: gridOffset, beatIndexOffset: 0,
      regionMinT: minT, regionMaxT: endTime,
    }, lines);
    return lines;
  }

  // Anchored path. Pre-anchor region uses the legacy bpm/gridOffset; each
  // subsequent region uses its anchor's bpm and the cumulative beat offset
  // so bar numbering stays continuous. Non-final regions exclude their
  // right boundary so a line at the anchor timestamp is emitted exactly
  // once (by the segment that *starts* there).
  if (minT < anchors[0].timestamp) {
    emitGridLinesForRegion(opts, {
      bpm, origin: gridOffset, beatIndexOffset: 0,
      regionMinT: minT, regionMaxT: Math.min(anchors[0].timestamp, endTime),
      excludeRight: true,
    }, lines);
  }
  for (let i = 0; i < anchors.length; i++) {
    const segStart = anchors[i].timestamp;
    const segEnd = i + 1 < anchors.length ? anchors[i + 1].timestamp : endTime;
    if (segEnd <= startTime || segStart >= endTime) continue;
    emitGridLinesForRegion(opts, {
      bpm: anchors[i].bpm,
      origin: segStart,
      beatIndexOffset: cumulativeBeatsAtAnchor(anchors, i, bpm, gridOffset),
      regionMinT: Math.max(minT, segStart),
      regionMaxT: Math.min(endTime, segEnd),
      excludeRight: i + 1 < anchors.length,  // last segment owns its right edge
    }, lines);
  }
  return lines;
}

/** Shared inner loop. Original single-tempo logic with two adaptations:
 *    - `region.bpm` / `region.origin` replace `bpm` / `gridOffset` for the
 *      step grid, so each segment's beats are spaced by its own tempo.
 *    - `region.beatIndexOffset` is added when computing `n` for the bar
 *      number / phrase math so anchored mode keeps continuous bar
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
  } = opts;
  const { bpm: regionBpm, origin, beatIndexOffset, regionMinT, regionMaxT } = region;
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
    // math so continuity is preserved across anchors.
    const n = nLocal + beatIndexOffset;
    const barIdx = Math.floor(n / beatsPerBar);
    const isBar  = isBeat && (n - barIdx * beatsPerBar === 0);

    // Apply per-beat override (Manual mode). Only integer beats are
    // override-eligible — sub-beats stay on the macro grid even when their
    // bounding beats are pinned. Override moves the position only;
    // bar/phrase classification is derived from `n` and stays put.
    let t = macroT;
    let overridden = false;
    if (beatOverrides && isBeat && Number.isInteger(n)) {
      const v = beatOverrides[String(n)];
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
      into.push({ t, beatIndex: n, isBar: true, barNumber: barIdx + 1, isPhrase, isOverridden: overridden || undefined });
    } else if (div === 1 && beatGroupSize > 1) {
      // Compound-pulse mode: only emit every Nth beat (anchored at beat 0).
      if (!isBeat) continue;
      if (((n % beatGroupSize) + beatGroupSize) % beatGroupSize !== 0) continue;
      const isPhrase = isBar && (((barIdx % phraseBars) + phraseBars) % phraseBars === 0);
      into.push({
        t, beatIndex: n, isBar,
        barNumber: isBar ? barIdx + 1 : 0,
        isPhrase,
        isOverridden: overridden || undefined,
      });
    } else {
      const isPhrase = isBar && (((barIdx % phraseBars) + phraseBars) % phraseBars === 0);
      into.push({
        t, beatIndex: n, isBar,
        barNumber: isBar ? barIdx + 1 : 0,
        isPhrase,
        isSubBeat: !isBeat,
        isOverridden: overridden || undefined,
      });
    }
  }
}
