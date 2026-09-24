/**
 * Vocal runs — the stretches where the voice is actually singing, derived from
 * a lyrics layer's word timings.
 *
 * The Prominence lane asks "who is in front over these bars", and answers it by
 * reading a `prominence` envelope off each durational item. A lyrics layer has
 * no such item to read: it holds a few hundred word-level instants, which is a
 * sampling of one instrument rather than a list of independently placed parts.
 * Feeding the words in directly would put a 200ms block on the Lead tier per
 * syllable — several hundred of them, none individually meaningful, and none
 * merged by `levelRegions` (it only collapses regions held by the SAME items,
 * and consecutive words never are).
 *
 * The unit that is meaningful is the sung stretch. Two choruses either side of
 * an instrumental break are two runs, so the lane draws two blocks and draws
 * nothing over the break — as opposed to one run spanning the whole song, where
 * the break would have to be spelled as a `silent` stretch and would therefore
 * draw a block on the Silent tier claiming the voice was annotated as resting
 * there. It wasn't; it just wasn't singing.
 *
 * Three rules make the derivation match what the ear hears:
 *
 *  - Split on a gap of `gapBars` or more (default 2). One bar of rest between
 *    lines is ordinary phrasing INSIDE a verse; splitting there shatters one
 *    chorus into four blocks. Two bars reads as the voice having stopped. The
 *    threshold is in bars rather than seconds so it tracks tempo, and it is
 *    adjustable because the line between a long breath and a short break is
 *    genuinely per-song.
 *
 *  - Snap the edges outward to the bar. A run that starts on its first syllable
 *    starts late: pickups and anacrusis are normal, so the block would sit a
 *    beat behind the chorus it belongs to and fail to line up with the
 *    boundaries lane. The end goes forward for the matching reason — the last
 *    note rings past the last word's timestamp.
 *
 *  - Never let the snap fuse two runs. Snapping outward can push one run's end
 *    past the next run's start; when it does, both are pulled back to the gap's
 *    midpoint, which keeps the runs disjoint and ordered without silently
 *    swallowing the break that separated them in the first place.
 *
 * Derivation is pure and deterministic, so a layer with no stored `vocalRuns`
 * still has stable run ids to be the target of an edit. The first edit
 * materializes the whole list (see `materializeVocalRuns`) so that later lyric
 * corrections cannot renumber a run the annotator has already annotated.
 */

import {
  PROMINENCE_EPSILON,
  type AnnotationLayer,
  type LyricsItem,
  type VocalRun,
} from '../types/annotationLayer';
import { segmentAtTime, type ResolvedSegment } from './gridSegments';

/** Gap that separates one run from the next, in bars.
 *
 *  Two, not one: a bar's rest between lines is normal phrasing inside a verse,
 *  and at one bar a single chorus comes apart into a block per line. */
export const DEFAULT_VOCAL_RUN_GAP_BARS = 2;

/** Bounds offered by the layer's gap control. Below 0.5 every breath splits;
 *  above 8 a verse and the chorus after it fuse into one block. */
export const MIN_VOCAL_RUN_GAP_BARS = 0.5;
export const MAX_VOCAL_RUN_GAP_BARS = 8;

/** The beat grid the snap reads. All optional: a song with no usable tempo
 *  still gets runs, just without bar-aligned edges. */
export interface VocalRunGrid {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  segments?: readonly ResolvedSegment[];
}

export interface VocalRunOptions {
  /** Gap that starts a new run, in bars. Defaults to DEFAULT_VOCAL_RUN_GAP_BARS. */
  gapBars?: number;
}

/** Seconds per bar at `t`, following a tempo split when there is one. Returns 0
 *  when the song has no usable tempo, which every caller reads as "no grid". */
function barLengthAt(t: number, grid: VocalRunGrid | undefined): number {
  if (grid?.segments && grid.segments.length > 0) {
    const seg = segmentAtTime(grid.segments, t);
    if (seg && seg.beatDur > 0) return seg.beatDur * seg.beatsPerBar;
  }
  const bpm = grid?.bpm;
  if (!bpm || bpm <= 0) return 0;
  return (60 / bpm) * (grid?.beatsPerBar ?? 4);
}

/** Bar line at or before `t`, and the one at or after it.
 *
 *  Computed from the segment's own origin rather than through
 *  `snapTimeToGrid`, which rounds to the NEAREST line — floor and ceil are what
 *  an outward snap needs, and deriving them from a rounded value takes a
 *  half-bar step whose direction depends on where the rounding landed. */
function barBounds(t: number, grid: VocalRunGrid | undefined): { floor: number; ceil: number } | null {
  const bar = barLengthAt(t, grid);
  if (bar <= 0) return null;
  let origin = grid?.gridOffset ?? 0;
  if (grid?.segments && grid.segments.length > 0) {
    const seg = segmentAtTime(grid.segments, t);
    if (seg) origin = seg.start;
  }
  const n = Math.floor((t - origin) / bar + 1e-9);
  const floor = origin + n * bar;
  return { floor, ceil: floor + bar };
}

/** Snap `t` back to its bar line. A time already sitting on one stays put —
 *  without the epsilon, floating-point noise drops it a whole bar. */
function snapBarFloor(t: number, grid: VocalRunGrid | undefined): number {
  const b = barBounds(t, grid);
  if (!b) return t;
  return Math.max(0, b.ceil - t <= PROMINENCE_EPSILON ? b.ceil : b.floor);
}

/** Snap `t` forward to the next bar line, leaving a time already on one alone. */
function snapBarCeil(t: number, grid: VocalRunGrid | undefined): number {
  const b = barBounds(t, grid);
  if (!b) return t;
  return t - b.floor <= PROMINENCE_EPSILON ? b.floor : b.ceil;
}

/** The stretch one lyric item occupies. Words are instants; only `kind: 'line'`
 *  items carry an `end`, and a malformed one that ends before it starts is read
 *  as the instant it starts on rather than as a negative span. */
function spanOf(item: LyricsItem): { start: number; end: number } {
  const start = item.time;
  const end = item.end !== undefined && item.end > item.time ? item.end : item.time;
  return { start, end };
}

/** Deterministic id for a derived run, keyed to its start in milliseconds.
 *
 *  Deterministic because a run that is not materialized yet must still be
 *  addressable: the lane hands an id back to the applier, which only then
 *  writes the list to disk. Keyed to the start rather than to the index so that
 *  correcting one word's timing early in the song does not renumber every run
 *  after it. */
export function derivedVocalRunId(start: number): string {
  return `vrun@${Math.round(start * 1000)}`;
}

/**
 * Group a lyrics layer's items into sung stretches.
 *
 * Items need not arrive sorted — generated lyrics usually are, hand-corrected
 * ones often aren't after a retime.
 */
export function deriveVocalRuns(
  items: readonly LyricsItem[] | undefined,
  grid?: VocalRunGrid,
  opts?: VocalRunOptions,
): VocalRun[] {
  if (!items || items.length === 0) return [];
  const spans = items
    .map(spanOf)
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) return [];

  const gapBars = Math.max(
    MIN_VOCAL_RUN_GAP_BARS,
    Math.min(MAX_VOCAL_RUN_GAP_BARS, opts?.gapBars ?? DEFAULT_VOCAL_RUN_GAP_BARS),
  );

  // Raw stretches first, in lyric coordinates: split wherever the silence
  // between one item's end and the next item's start reaches the threshold.
  // The threshold is measured in bars AT THE GAP, so a tempo change mid-song
  // doesn't make the same musical rest count as two different gaps.
  const raw: { start: number; end: number }[] = [];
  for (const s of spans) {
    const cur = raw[raw.length - 1];
    if (!cur) { raw.push({ ...s }); continue; }
    const bar = barLengthAt(cur.end, grid);
    // With no tempo, fall back to a fixed 4s: the threshold still has to mean
    // something, and 2 bars of 4/4 at 120 BPM is exactly that.
    const gapSec = bar > 0 ? bar * gapBars : 4;
    if (s.start - cur.end >= gapSec) raw.push({ ...s });
    else cur.end = Math.max(cur.end, s.end);
  }

  // Then push the edges out to the bar lines around them.
  //
  // A run of ONE word is the case that needs watching: its raw extent is a
  // single instant, and when that instant sits exactly on a bar line both the
  // floor and the ceil land on it, leaving a run of zero length that would be
  // dropped entirely — a word sung alone would disappear from the lane rather
  // than occupy the bar it was sung in. So an empty snap is given the bar it
  // opens on. With no tempo there is no bar to give it, and a second is the
  // least arbitrary stand-in for one sung word.
  const snapped = raw.map((r) => {
    const start = snapBarFloor(r.start, grid);
    let end = snapBarCeil(r.end, grid);
    if (end - start <= PROMINENCE_EPSILON) {
      const bar = barLengthAt(start, grid);
      end = start + (bar > 0 ? bar : 1);
    }
    return { start, end, rawStart: r.start, rawEnd: r.end };
  });

  // An outward snap at both ends can close a gap that was real. Where it does,
  // both edges retreat to the middle of the ORIGINAL silence, so the runs stay
  // disjoint and the break stays visible.
  for (let i = 0; i < snapped.length - 1; i++) {
    const a = snapped[i];
    const b = snapped[i + 1];
    if (a.end <= b.start + PROMINENCE_EPSILON) continue;
    const mid = (a.rawEnd + b.rawStart) / 2;
    a.end = Math.max(a.rawEnd, Math.min(a.end, mid));
    b.start = Math.min(b.rawStart, Math.max(b.start, mid));
  }

  return snapped
    .filter((r) => r.end - r.start > PROMINENCE_EPSILON)
    .map((r) => ({ id: derivedVocalRunId(r.start), start: r.start, end: r.end }));
}

/**
 * The runs a lyrics layer HAS: what it stored, or what its words imply.
 *
 * Stored runs win outright and are never re-derived behind the annotator's
 * back. A lyric correction after the runs were materialized leaves them as they
 * were until "Re-derive runs" is asked for — the alternative is an edit to one
 * word silently reshaping blocks the annotator had already levelled.
 */
export type VocalRunLayer = Pick<
  AnnotationLayer, 'type' | 'items' | 'vocalRuns' | 'vocalRunGapBars'
>;

export function resolveVocalRuns(
  layer: VocalRunLayer,
  grid?: VocalRunGrid,
  opts?: VocalRunOptions,
): VocalRun[] {
  if (layer.type !== 'lyrics') return [];
  if (layer.vocalRuns) return layer.vocalRuns.filter((r) => r.end - r.start > PROMINENCE_EPSILON);
  return deriveVocalRuns(layer.items as readonly LyricsItem[], grid, {
    gapBars: opts?.gapBars ?? layer.vocalRunGapBars,
  });
}

/** True when the layer's runs are only derived — nothing is on disk yet. */
export function vocalRunsAreDerived(
  layer: Pick<AnnotationLayer, 'type' | 'vocalRuns'>,
): boolean {
  return layer.type === 'lyrics' && !layer.vocalRuns;
}

/**
 * Freeze the currently-resolved runs onto the layer, so ids stop depending on
 * the word timings. Called by the first edit that writes to any run; a layer
 * that already has stored runs is returned untouched.
 */
export function materializeVocalRuns(
  layer: VocalRunLayer,
  grid?: VocalRunGrid,
  opts?: VocalRunOptions,
): VocalRun[] {
  return resolveVocalRuns(layer, grid, opts);
}

/**
 * Cut one run in two at `t`, keeping each half's share of the envelope.
 *
 * The escape hatch that makes an automatic threshold acceptable: no single gap
 * value gets every song right, so the annotator must be able to say "the voice
 * does stop here" where the derivation didn't see it. The second half's
 * envelope is re-based to its own start, since a `ProminencePoint.t` is always
 * item-relative.
 */
export function splitVocalRun(runs: readonly VocalRun[], runId: string, t: number): VocalRun[] {
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx < 0) return [...runs];
  const run = runs[idx];
  if (t - run.start <= PROMINENCE_EPSILON || run.end - t <= PROMINENCE_EPSILON) return [...runs];

  const head: VocalRun = {
    ...run,
    end: t,
    prominence: run.prominence?.filter((p) => run.start + p.t < t - PROMINENCE_EPSILON),
  };
  // The tail opens at whatever level was in effect at the cut, so splitting a
  // run changes where its blocks END and nothing about what they SAY.
  const carried = run.prominence?.filter((p) => run.start + p.t <= t + PROMINENCE_EPSILON).pop();
  const tailPoints = (run.prominence ?? [])
    .filter((p) => run.start + p.t > t + PROMINENCE_EPSILON)
    .map((p) => ({ ...p, t: run.start + p.t - t }));
  const tail: VocalRun = {
    id: derivedVocalRunId(t),
    start: t,
    end: run.end,
    prominence: carried || tailPoints.length > 0
      ? [...(carried ? [{ t: 0, level: carried.level }] : []), ...tailPoints]
      : undefined,
  };
  return [...runs.slice(0, idx), head, tail, ...runs.slice(idx + 1)];
}

/**
 * Join a run to the one after it, closing the gap between them.
 *
 * The other half of the escape hatch: the threshold over-split, and what looked
 * like two stretches is one long phrase. The survivor keeps the FIRST run's
 * envelope and id — merging is "this kept going", so the block the annotator
 * already levelled should not change identity underneath them — and the second
 * run's breakpoints are re-based onto it.
 */
export function mergeVocalRunWithNext(runs: readonly VocalRun[], runId: string): VocalRun[] {
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx < 0 || idx >= runs.length - 1) return [...runs];
  const a = runs[idx];
  const b = runs[idx + 1];
  const shifted = (b.prominence ?? []).map((p) => ({ ...p, t: b.start + p.t - a.start }));
  const merged: VocalRun = {
    ...a,
    end: Math.max(a.end, b.end),
    prominence: a.prominence || shifted.length > 0
      ? [...(a.prominence ?? []), ...shifted]
      : undefined,
  };
  return [...runs.slice(0, idx), merged, ...runs.slice(idx + 2)];
}
