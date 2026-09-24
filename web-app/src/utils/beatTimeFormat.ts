import { formatBeatPosition, getBarBeatOrigin } from './beatGrid';
import type { BarBeatOrigin, SnapDivision } from './beatGrid';
import type { SnapMode } from '../types/annotationLayer';
// Type-only, so nothing of the component module is pulled in at runtime — the
// unit union is declared next to the selector that offers it.
import type { BeatGridUnit } from '../components/inspector-v2/SharedVizPanel';

export type BeatTimeFormat = 'bar-beat' | 'decimal-bars';

/** Format seconds as a beat-relative string.
 *  'bar-beat'     → "Bar 3 · Beat 2"
 *  'decimal-bars' → "2.25 bars  (Bar 3 · Beat 2)" */
export function formatBeatTime(
  t: number,
  bpm: number,
  gridOffset: number,
  beatsPerBar: number,
  format: BeatTimeFormat = 'bar-beat',
  origin: BarBeatOrigin = getBarBeatOrigin(),
): string {
  const { bar, beat, fracBars } = formatBeatPosition(t, bpm, gridOffset, beatsPerBar, origin);
  const barBeat = `Bar ${bar} · Beat ${beat}`;
  if (format === 'decimal-bars') {
    return `${fracBars.toFixed(2)} bars  (${barBeat})`;
  }
  return barBeat;
}

/** Map a SnapMode to the snapTimeToGrid division string. 'magnetic' rides the
 *  1/16 grid — the finest line a listener still hears as a rhythmic position —
 *  and gets its pull limited by `magneticToleranceSec` instead of by a coarser
 *  division. */
export function snapModeToDivision(mode: SnapMode): SnapDivision {
  switch (mode) {
    case 'bar':      return 'bar';
    case '1/2beat':  return '1/2beat';
    case '1/4beat':  return '1/4beat';
    case 'magnetic': return '1/4beat';
    default:         return 'beat';
  }
}

/** Widest gap 'magnetic' will close, in seconds.
 *
 *  Capped at 40 ms because that is roughly where a karaoke highlight starts
 *  looking out of sync with the voice — a correction bigger than that is no
 *  longer invisible. Also capped at a quarter of the 1/16 spacing so the mode
 *  keeps its meaning at fast tempi: at 180 BPM a 1/16 is only 83 ms, and a
 *  flat 40 ms window would swallow every position and silently become an
 *  always-snap. */
export function magneticToleranceSec(bpm: number): number {
  if (!(bpm > 0)) return 0;
  const sixteenthSec = (60 / bpm) / 4;
  return Math.min(0.04, sixteenthSec * 0.25);
}

/**
 * Map a visible beat-grid unit to the snap division that honours it.
 * Called when the grid is visible and no layer-specific snap mode overrides.
 *
 * The rule is that every line the user can SEE must be a place the snap can
 * land. Sub-beat units therefore map to themselves, one for one. They used to
 * be flattened onto the nearest binary rung, and for the triplets that was not
 * an approximation but a different grid: with `1/3 beat · triplet` drawn, snap
 * ran at 1/2 beat, so an annotation dropped between two visible triplet lines
 * was pulled to a halfway point where no line exists — the grid said one thing
 * and the snap did another.
 *
 * Coarser-than-beat units keep snapping to 'bar': there the relation still
 * holds (every 4-bar line IS a bar line), and landing only every fourth bar
 * would be a worse tool than the one it replaces.
 */
export function beatGridUnitToSnapDivision(unit: string): SnapDivision {
  switch (unit) {
    case '32nd':          return '1/8beat';
    case '16th-triplet':  return '1/6beat';
    case '16th':          return '1/4beat';
    case '8th-triplet':   return '1/3beat';
    case '8th':           return '1/2beat';
    case 'bar':
    case '2bar':
    case '4bar':
    case '8bar':
    case '16bar':         return 'bar';
    // 'compound-beat' draws a line every 3 beats and snaps to every beat: the
    // drawn lines are still landing spots, and a pulse this wide is a reading
    // aid, not a quantiser anyone wants their marks rounded to.
    case 'beat':
    case 'compound-beat':
    default:              return 'beat';
  }
}

/** Human label for a beat-grid unit — the Grid selector's own wording,
 *  shared with anything that has to tell the user which unit is in force
 *  (the Grid Lock confirmation, for one). */
export function beatGridUnitLabel(unit: BeatGridUnit): string {
  // Labels are beat-relative so they stay accurate across time signatures.
  // In 4/4 these line up with classical 1/16, 1/8, 1/4, … note values; in
  // 6/8 (where the BPM counts 8ths) "1/2 beat" really is a 16th note.
  switch (unit) {
    case '32nd':          return '1/8 beat';
    case '16th-triplet':  return '1/6 beat · triplet';
    case '16th':          return '1/4 beat';
    case '8th-triplet':   return '1/3 beat · triplet';
    case '8th':           return '1/2 beat';
    case 'beat':          return 'Beat';
    case 'compound-beat': return 'Compound (×3 beats)';
    case 'bar':           return 'Bar';
    case '2bar':          return '2 Bars';
    case '4bar':          return '4 Bars (Phrase)';
    case '8bar':          return '8 Bars (Block)';
    case '16bar':         return '16 Bars';
  }
}

/** Human label for a SnapMode granularity (used in layer settings UI). */
export function snapModeLabel(mode: SnapMode): string {
  switch (mode) {
    case 'off':      return 'Off';
    case 'magnetic': return 'Magnetic';
    case 'bar':      return '1 Bar';
    case 'beat':     return '1 Beat';
    case '1/2beat':  return '½ Beat';
    case '1/4beat':  return '¼ Beat';
  }
}

/** Tooltip for the bar.beat field and its column header. The worked example
 *  has to count the way the user's grid counts, otherwise it teaches the wrong
 *  syntax under a zero-based origin — so both surfaces share this one string. */
export function barBeatHelpTitle(origin: BarBeatOrigin): string {
  const bar = 1 + origin, beat = 2 + origin;
  return `bar.beat — e.g. ${bar}.${beat} = bar ${bar} beat ${beat}; ` +
    `${bar}.${beat}.5 = halfway between beat ${beat} and ${beat + 1}. ` +
    `Bars and beats count from ${origin} — change that under ` +
    `Settings → Annotations — display → First bar / first beat numbered.`;
}

/** Compact "which convention is this?" tag for column headers and badges. */
export function barBeatOriginTag(origin: BarBeatOrigin): string {
  return `from ${origin}`;
}
