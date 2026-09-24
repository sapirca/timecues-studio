/**
 * Where a pulse's ticks actually fall.
 *
 * A `PulseRate` is one word about a whole stretch of music — "eighths through
 * here" — and the ticks that illustrate it are computed on demand from the
 * song's own grid, never written down. That is the reason the feature is a
 * single value rather than a list of hits: the ticks follow the grid, so
 * trimming the span, re-fitting the beats, or cutting a new tempo segment
 * underneath it all leave the annotation true. A stored list would go on
 * claiming hits at times the audio no longer has.
 *
 * Derivation goes through `visibleGridLines` rather than a local
 * `start + n * period` loop so a pulse lands on exactly the same lines the
 * grid overlay draws — beat overrides, the grid offset and split tempo
 * segments included. Anything else and a span marked "1/4 beat" would sit a
 * few milliseconds off the grid it is describing.
 */

import { visibleGridLines } from './beatGrid';
import type { ResolvedSegment } from './gridSegments';
import {
  PULSE_RATE_INFO,
  PULSE_SILENT,
  isTickingPulse,
  pulsePeriodBeats,
  type PulseRate,
  type PulseTickingRate,
} from '../types/annotationLayer';

/** Grid-emitter settings for one pulse rate. Mirrors `resolveBeatGrid` in
 *  SharedVizPanel, which turns the identical strings into the same two knobs
 *  for the visible grid — the shared vocabulary is what keeps a pulse drawn on
 *  the lines the user is already looking at. */
export function pulseGridOptions(
  rate: PulseTickingRate,
): { subBeatDivision?: number; barGroupSize?: number } {
  switch (rate) {
    case '32nd':         return { subBeatDivision: 8 };
    case '16th-triplet': return { subBeatDivision: 6 };
    case '16th':         return { subBeatDivision: 4 };
    case '8th-triplet':  return { subBeatDivision: 3 };
    case '8th':          return { subBeatDivision: 2 };
    case 'bar':          return { barGroupSize: 1 };
    case 'beat':         return {};
  }
}

/** Seconds between two ticks of `rate`, or `null` without a tempo to measure
 *  against. The readout under the picker — "a pulse" is abstract until it is
 *  also "every 250 ms". Uses the macro tempo, so on a grid with per-beat
 *  overrides or tempo segments this is the nominal spacing, not a promise
 *  about any particular pair of ticks. */
export function pulseIntervalSec(
  rate: PulseRate,
  bpm: number | undefined,
  beatsPerBar = 4,
): number | null {
  // Silence has no interval to state — not an interval of zero, which would
  // read as "infinitely fast" everywhere this feeds a readout.
  if (!isTickingPulse(rate)) return null;
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;
  return pulsePeriodBeats(rate, beatsPerBar) * (60 / bpm);
}

/** Ticks a pulse this fast would put in one bar. Says the rate in the unit
 *  people count in, next to the milliseconds. Silence puts zero there, which
 *  is the literal truth about it. */
export function pulseTicksPerBar(rate: PulseRate, beatsPerBar = 4): number {
  if (!isTickingPulse(rate)) return 0;
  const bars = pulsePeriodBeats(rate, beatsPerBar) / Math.max(1, beatsPerBar);
  return bars > 0 ? 1 / bars : 0;
}

/** Above this many ticks in one span, the marks are closer together than any
 *  screen can separate them and drawing them costs a DOM node each. Callers
 *  get an empty list and say the rate in words instead — see `pulseTickTimes`. */
export const PULSE_MAX_TICKS = 512;

export interface PulseTickOptions {
  rate: PulseRate;
  /** Window to fill, in track seconds. */
  start: number;
  end: number;
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Manual-mode per-beat overrides, same map the grid overlay takes. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Resolved tempo segments, so a pulse inside a split grid ticks at the
   *  tempo in force where it sits rather than the track's opening one. */
  segments?: readonly ResolvedSegment[];
  /** Cap on how many ticks to return. Defaults to `PULSE_MAX_TICKS`. */
  maxTicks?: number;
}

/**
 * Tick times (seconds, ascending) for `rate` inside `[start, end]`.
 *
 * Empty for `'silent'`, whose whole claim is that nothing hits here; empty
 * when there is no usable tempo — a pulse is a statement about the grid,
 * and without one there is nothing to draw it against — and empty again when
 * the window would hold more than `maxTicks`. That second case returns nothing
 * rather than a thinned-out subset on purpose: the ticks ARE the rate, so
 * dropping every other one would draw a pulse half as fast as the annotation
 * says. A caller that gets an empty list from a span it knows has a pulse
 * should fall back to naming the rate.
 */
export function pulseTickTimes(opts: PulseTickOptions): number[] {
  const { rate, start, end, bpm, gridOffset = 0, beatsPerBar = 4 } = opts;
  if (!isTickingPulse(rate)) return [];
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return [];
  if (!(end > start)) return [];

  // Cheap upfront rejection: emitting a quarter-hour of 32nds only to count
  // them and throw them away is a lot of work to reach an empty array.
  const period = pulseIntervalSec(rate, bpm, beatsPerBar);
  const max = opts.maxTicks ?? PULSE_MAX_TICKS;
  if (period != null && period > 0 && (end - start) / period > max + 1) return [];

  const lines = visibleGridLines({
    bpm,
    gridOffset,
    beatsPerBar,
    startTime: start,
    endTime: end,
    beatOverrides: opts.beatOverrides,
    segments: opts.segments,
    ...pulseGridOptions(rate),
  });

  const ticks: number[] = [];
  for (const line of lines) {
    if (line.t < start || line.t > end) continue;
    ticks.push(line.t);
    if (ticks.length > max) return [];
  }
  return ticks;
}

/** One-line description of what a pulse means here, for a band tooltip or a
 *  card: "1/2 beat · every 250 ms · 8 per bar". Degrades to just the label
 *  when the song has no tempo yet, and says silence in words rather than in
 *  milliseconds — "every ∞ ms, 0 per bar" would be a joke, not a readout. */
export function pulseReadout(
  rate: PulseRate,
  bpm: number | undefined,
  beatsPerBar = 4,
): string {
  const label = PULSE_RATE_INFO[rate].label;
  if (rate === PULSE_SILENT) return `${label} · nothing hits here`;
  const interval = pulseIntervalSec(rate, bpm, beatsPerBar);
  if (interval == null) return label;
  const ms = interval * 1000;
  const every = ms >= 1000 ? `${interval.toFixed(2)} s` : `${Math.round(ms)} ms`;
  const perBar = pulseTicksPerBar(rate, beatsPerBar);
  return `${label} · every ${every} · ${perBar} per bar`;
}
