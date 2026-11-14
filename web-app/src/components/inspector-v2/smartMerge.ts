/**
 * Smart merge — one candidate per place, placed where the music turns.
 *
 * The plain merge is a union: three lanes that heard the same drop a beat
 * apart leave three lines a beat apart, and the annotator drops two by hand.
 * Smart merge does that folding for them, and then asks the song — not the
 * lanes — where the one line should go:
 *
 *   1. CLUSTER. Votes from the member lanes within a bar of the cluster's
 *      first vote are one place (2 s on a song with no grid). A lane that
 *      named the place twice is still one lane in `agreement`.
 *   2. PLACE, strongest reason first, looking half a bar either side of the
 *      votes:
 *        · figure — a rhythmic figure the figure detectors found there: a
 *          drop, a hit, an arrangement change, a breakdown or build edge.
 *          Figures are timed where the stems move; the line goes on the bar
 *          line nearest the figure — the section line is the bar. With a
 *          grid, every candidate lands exactly on a bar line.
 *        · signal — of the bar lines in reach, the one the music turns on
 *          hardest: the largest level step in Volume / Bass / Mids / Highs,
 *          the bar after against the bar before, if it is at least
 *          `SMART_STEP_DB`. With no grid, the largest step itself.
 *        · bar — nothing stands out, so the bar line nearest the votes'
 *          median.
 *        · vote — no grid either: the reported time nearest the median.
 *   3. FOLD candidates closer than `MIN_SECTION_BARS` into the stronger of
 *      the two. A section runs several bars, so two lines a bar apart are one
 *      turn two groups of lanes heard a bar apart — not a one-bar section.
 *      Hand splits are exempt: the annotator put them there on purpose.
 *
 * Every boundary says which of these placed it (`smart`), so a line the
 * annotator doubts can be read, not guessed at. The annotator's own splits
 * are never moved: a hand boundary stays exactly where it was put.
 *
 * Measured 2026-09-29 against the hand-drawn "Boundaries 1" layers of four
 * songs (5am, Alor, Mahalo, Peter the Wolf; 38 boundaries, 3-7 algo lanes
 * each): the union's 180 lines became 85 candidates, precision at ±0.5 s
 * rose from 0.13 to 0.24 (F 0.20 → 0.29) while recall at ±2 beats went only
 * from 0.48 to 0.46, and the hits sit 0.04 s off the hand line (0.21 s in the
 * union). Shifting the grid two beats drops the bar-only placement to F 0.01
 * — the gain is the bar lines. The two-bar minimum section took 104
 * candidates to 85 without losing a single hit; three bars cost one (the hand
 * layers hold real two-bar sections — Peter the Wolf, Arabian Nights) and four
 * cost more. Signals and figures move the score by one boundary either way on
 * this set; they earn their place on a song whose grid is off. Signal steps
 * under 6 dB are ordinary movement inside a section (6, 9 and 12 dB scored the
 * same), so nothing weaker moves a line.
 */

import type { FrameAxis } from '../../utils/frameTime';
import { EDGE_EPS, roundTime } from './boundaryInsert';
import {
  HAND_LANE_ID, applyMergeWork,
  type MergeBoundaryEdit, type MergeSourceLane, type MergedBoundary, type SmartPlacement,
} from './boundaryMerge';

/** A place the song itself marks — a figure detector's cue, or the edge of
 *  one of its spans. */
export interface SmartAnchor {
  time: number;
  label: string;
}

/** One signal's level step at every frame: dB over the window after the
 *  frame minus dB over the window before it. */
export interface LevelStepSignal {
  name: string;
  axis: FrameAxis;
  steps: Float32Array;
}

export interface SmartMergeContext {
  /** The song's beat grid, when it has one. */
  grid?: {
    beatSec: number;
    barSec: number;
    /** The bar line nearest `t` — pinned beats and tempo segments included. */
    snapToBar: (t: number) => number;
  };
  figures?: readonly SmartAnchor[];
  levels?: readonly LevelStepSignal[];
}

/** The smallest level step that counts as the music turning. */
export const SMART_STEP_DB = 6;
/** Cluster reach on a song with no grid — about a bar at 120 BPM. */
export const NO_GRID_REACH_SEC = 2;
/** The shortest section smart merge leaves between two of its candidates. A
 *  section runs several bars; two lines a bar apart are one turn that two
 *  groups of lanes heard a bar apart, not a one-bar section. */
export const MIN_SECTION_BARS = 2;

/**
 * Level steps for each signal, `windowSec` either side of every frame. Levels
 * are mean power (magnitude²) over the window, in dB; a silent window is
 * floored 60 dB under the signal's loudest window so a cut to silence reads
 * as a big step, not an infinite one. Frames without a whole window on both
 * sides step 0.
 */
export function levelStepSignals(
  signals: readonly { name: string; values: ArrayLike<number>; axis: FrameAxis }[],
  windowSec: number,
): LevelStepSignal[] {
  return signals.flatMap(({ name, values, axis }) => {
    const n = Math.min(values.length, axis.count);
    const w = axis.step > 0 ? Math.round(windowSec / axis.step) : 0;
    if (w < 1 || n < 2 * w + 1) return [];
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      prefix[i + 1] = prefix[i] + (Number.isFinite(v) ? v * v : 0);
    }
    let loudest = 0;
    for (let i = w; i <= n; i++) loudest = Math.max(loudest, prefix[i] - prefix[i - w]);
    if (!(loudest > 0)) return [];
    const floor = (loudest / w) * 1e-6;
    const db = (sum: number) => 10 * Math.log10(sum / w + floor);
    const steps = new Float32Array(n);
    for (let i = w; i + w <= n; i++) {
      steps[i] = db(prefix[i + w] - prefix[i]) - db(prefix[i] - prefix[i - w]);
    }
    return [{ name, axis, steps }];
  });
}

/** The largest level step, across all signals, between `from` and `to` —
 *  null when none reaches `minDb`. Only for a song with no grid; with one,
 *  `barLineSteps` asks the bar lines instead. */
export function strongestLevelStep(
  levels: readonly LevelStepSignal[],
  from: number,
  to: number,
  minDb: number = SMART_STEP_DB,
): { time: number; db: number; name: string } | null {
  let best: { time: number; db: number; name: string } | null = null;
  for (const { name, axis, steps } of levels) {
    if (!(axis.step > 0)) continue;
    const i0 = Math.max(0, Math.ceil((from - axis.offset) / axis.step));
    const i1 = Math.min(steps.length - 1, Math.floor((to - axis.offset) / axis.step));
    for (let i = i0; i <= i1; i++) {
      const db = steps[i];
      if (Math.abs(db) >= minDb && (!best || Math.abs(db) > Math.abs(best.db))) {
        best = { time: axis.offset + i * axis.step, db, name };
      }
    }
  }
  return best;
}

/** How far from a bar line a level step still counts as that bar's — a
 *  quarter of a beat, the looseness of a step read off bar-long windows. */
const BAR_STEP_SLACK_BEATS = 0.25;

/** The bar lines from `from` to `to`, each with its largest level step. */
export function barLineSteps(
  levels: readonly LevelStepSignal[],
  grid: NonNullable<SmartMergeContext['grid']>,
  from: number,
  to: number,
): { time: number; db: number; name: string }[] {
  const out: { time: number; db: number; name: string }[] = [];
  const slack = grid.beatSec * BAR_STEP_SLACK_BEATS;
  // Walk the grid by snapping a bar ahead each time, so pinned beats and tempo
  // segments are followed rather than assumed away.
  let bar = grid.snapToBar(Math.max(0, from));
  if (bar < from) bar = grid.snapToBar(bar + grid.barSec);
  for (let guard = 0; bar <= to && guard < 64; guard++) {
    const step = strongestLevelStep(levels, bar - slack, bar + slack, 0);
    out.push(step ? { ...step, time: bar } : { time: bar, db: 0, name: '' });
    const next = grid.snapToBar(bar + grid.barSec);
    if (!(next > bar)) break;
    bar = next;
  }
  return out;
}

function median(sorted: readonly number[]): number {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function nearestTo<T>(items: readonly T[], t: number, at: (x: T) => number): T | undefined {
  let best: T | undefined;
  for (const x of items) if (!best || Math.abs(at(x) - t) < Math.abs(at(best) - t)) best = x;
  return best;
}

/** Where one cluster's single boundary goes, and why. `times` ascending. */
export function placeCluster(
  times: readonly number[],
  ctx: SmartMergeContext,
): { time: number; placement: SmartPlacement; db?: number } {
  const mid = median(times);
  const slack = (ctx.grid?.barSec ?? NO_GRID_REACH_SEC) / 2;
  const from = times[0] - slack;
  const to = times[times.length - 1] + slack;

  const figure = nearestTo((ctx.figures ?? []).filter((f) => f.time >= from && f.time <= to), mid, (f) => f.time);
  if (figure) {
    // A figure is timed where the stems move — a part coming in at its first
    // sound, a build starting a beat or two into its bar. The section line is
    // the bar it belongs to, so on a song with a grid the figure picks the
    // bar and the line goes exactly on it: every smart candidate on a grid
    // sits on a bar line.
    if (ctx.grid) {
      return { time: ctx.grid.snapToBar(figure.time), placement: { kind: 'figure', note: `on “${figure.label}”, on the bar line` } };
    }
    return { time: figure.time, placement: { kind: 'figure', note: `on “${figure.label}”` } };
  }

  const words = (st: { db: number; name: string }) =>
    `${st.name} ${st.db > 0 ? '+' : '−'}${Math.round(Math.abs(st.db))} dB`;
  if (ctx.levels?.length && ctx.grid) {
    // Which of the bar lines in reach does the music turn on hardest?
    let best: { time: number; db: number; name: string } | null = null;
    for (const b of barLineSteps(ctx.levels, ctx.grid, from, to)) {
      if (Math.abs(b.db) >= SMART_STEP_DB && (!best || Math.abs(b.db) > Math.abs(best.db))) best = b;
    }
    if (best) return { time: best.time, db: Math.abs(best.db), placement: { kind: 'signal', note: `${words(best)} across this bar line` } };
  } else if (ctx.levels?.length) {
    const step = strongestLevelStep(ctx.levels, from, to);
    if (step) return { time: step.time, db: Math.abs(step.db), placement: { kind: 'signal', note: words(step) } };
  }

  if (ctx.grid) return { time: ctx.grid.snapToBar(mid), placement: { kind: 'bar', note: 'on the nearest bar line' } };

  const vote = nearestTo(times, mid, (t) => t)!;
  return { time: vote, placement: { kind: 'vote', note: times.length > 1 ? 'the middle vote' : 'as the lane reported it' } };
}

/**
 * The smart reading of the member lanes. Same shape as `mergeBoundaryLanes`
 * — every candidate, ascending, `kept` unless dropped — so the lane, the
 * popover and Save as layer take either one.
 */
export function smartMergeBoundaryLanes(
  lanes: readonly MergeSourceLane[],
  ctx: SmartMergeContext,
  dropped: readonly number[] = [],
  edits: readonly MergeBoundaryEdit[] = [],
  added: readonly number[] = [],
): MergedBoundary[] {
  if (lanes.length === 0) return [];
  const laneRank = new Map([...lanes.map((l, i) => [l.id, i] as const), [HAND_LANE_ID, lanes.length] as const]);
  const byRank = (a: string, b: string) => (laneRank.get(a) ?? 0) - (laneRank.get(b) ?? 0);
  const votes = lanes
    .flatMap((lane) => lane.times.map((time) => ({ laneId: lane.id, time: roundTime(time) })))
    .sort((a, b) => a.time - b.time);

  // 1. Cluster: within a bar of the cluster's FIRST vote, so a run of lanes
  //    each a little later than the last cannot chain a cluster across a
  //    whole section.
  const reach = ctx.grid?.barSec ?? NO_GRID_REACH_SEC;
  const clusters: (typeof votes)[] = [];
  for (const v of votes) {
    const c = clusters[clusters.length - 1];
    if (c && v.time - c[0].time <= reach) c.push(v);
    else clusters.push([v]);
  }

  // 2. Place each.
  const placed = clusters
    .map((c) => {
      const rawTimes = c.map((v) => v.time);
      const { time, placement, db = 0 } = placeCluster(rawTimes, ctx);
      const laneIds = [...new Set(c.map((v) => v.laneId))].sort(byRank);
      return { time: roundTime(Math.max(0, time)), laneIds, rawTimes, smart: placement, db, took: 0 };
    })
    .sort((a, b) => a.time - b.time);

  // 3. Fold candidates closer than a section can be — the same instant, or a
  //    bar apart — into the stronger of each pair, closest pair first: a
  //    figure over a level change over a bare bar line, then more lanes, then
  //    the bigger change, then the earlier line.
  const minGap = (ctx.grid ? ctx.grid.barSec * MIN_SECTION_BARS : NO_GRID_REACH_SEC * MIN_SECTION_BARS) - EDGE_EPS;
  const KIND_RANK = { figure: 3, signal: 2, bar: 1, vote: 0 } as const;
  const stronger = (a: (typeof placed)[number], b: (typeof placed)[number]) =>
    (KIND_RANK[a.smart.kind] - KIND_RANK[b.smart.kind])
    || (a.laneIds.length - b.laneIds.length)
    || (a.db - b.db)
    || (b.time - a.time);
  for (;;) {
    let at = -1;
    for (let i = 0; i + 1 < placed.length; i++) {
      const gap = placed[i + 1].time - placed[i].time;
      if (gap < minGap && (at < 0 || gap < placed[at + 1].time - placed[at].time)) at = i;
    }
    if (at < 0) break;
    const [a, b] = [placed[at], placed[at + 1]];
    const [win, lose] = stronger(a, b) >= 0 ? [a, b] : [b, a];
    // The same instant is agreement, not a fold worth mentioning.
    const sameInstant = Math.abs(a.time - b.time) < EDGE_EPS;
    placed.splice(at, 2, {
      ...win,
      laneIds: [...new Set([...win.laneIds, ...lose.laneIds])].sort(byRank),
      rawTimes: [...win.rawTimes, ...lose.rawTimes].sort((x, y) => x - y),
      took: win.took + lose.took + (sameInstant ? 0 : 1),
    });
  }

  const out: MergedBoundary[] = [];
  const push = (time: number, laneIds: string[], rawTimes: number[], smart?: SmartPlacement) => {
    const prev = out.find((b) => Math.abs(b.time - time) < EDGE_EPS);
    if (prev) {
      const ids = [...new Set([...prev.laneIds, ...laneIds])].sort(byRank);
      const raw = [...prev.rawTimes, ...rawTimes].sort((a, b) => a - b);
      Object.assign(prev, {
        laneIds: ids,
        agreement: ids.length,
        rawTimes: raw,
        spreadSec: raw[raw.length - 1] - raw[0],
      });
      return;
    }
    out.push({
      time, laneIds, agreement: laneIds.length, rawTimes,
      spreadSec: rawTimes[rawTimes.length - 1] - rawTimes[0],
      kept: true,
      ...(smart ? { smart } : {}),
    });
  };
  for (const p of placed) {
    const smart = p.took > 0
      ? { ...p.smart, note: `${p.smart.note} · took in ${p.took} line${p.took > 1 ? 's' : ''} under ${MIN_SECTION_BARS} bars away` }
      : p.smart;
    push(p.time, p.laneIds, p.rawTimes, smart);
  }
  // The annotator's splits, exactly where they were put.
  for (const a of added) push(roundTime(a), [HAND_LANE_ID], [roundTime(a)]);
  out.sort((a, b) => a.time - b.time);
  return applyMergeWork(out, dropped, edits);
}
