/**
 * "There is already one exactly here" — the check every add path runs before
 * it commits a new item.
 *
 * Two adds land on the same instant far more often than a timeline suggests.
 * Pause the transport and the clock stops moving, so a double-press of M (or
 * a second click of "+ Add" that the annotator isn't sure registered) reads
 * the same time twice. Turn snap or Grid Lock on and it happens during
 * playback too: every time inside a beat rounds to that beat, so two taps a
 * tenth of a second apart become one identical time.
 *
 * The second item then lands exactly on top of the first and hides it. The
 * annotator sees one marker, the document holds two, and the duplicate
 * surfaces much later — in an export, or as a phantom disagreement in an
 * evaluation score. Nothing about the canvas can show it, which is why the
 * add has to refuse rather than the drawing.
 *
 * "Same spot" is literal: the same millisecond, which is the document's
 * storage resolution (times serialize to integer ms). Anything an annotator
 * can hear as two separate events still goes in. That is deliberately NOT the
 * 50 ms `EDGE_EPS` the boundary layer uses — boundaries tile, so two section
 * starts that close are a contradiction, whereas two cues 30 ms apart are a
 * flam and a perfectly real thing to mark.
 *
 * A point and an interval that begin together are different spots (a word and
 * a line lyric at the same syllable), so only like compares with like.
 */

import { formatClockTime } from '../../../utils/clockTime';

/** Same millisecond ⇒ same spot. See the note above on why it isn't wider. */
export const SAME_SPOT_EPS = 0.001;

/** Where an item sits: a point in time, or an interval when `end` is set. */
export interface SpotFootprint {
  at: number;
  end?: number | null;
}

function coincides(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_SPOT_EPS;
}

/** Do these two footprints occupy the same spot on the timeline? */
export function isSameSpot(a: SpotFootprint, b: SpotFootprint): boolean {
  if (!coincides(a.at, b.at)) return false;
  const aEnd = a.end ?? null;
  const bEnd = b.end ?? null;
  // One is a point and the other an interval — they start together but are
  // not the same annotation.
  if (aEnd === null || bEnd === null) return aEnd === bEnd;
  return coincides(aEnd, bEnd);
}

/**
 * The item already sitting where `probe` wants to go, if any. Search one
 * layer's items only: the same cue time in two different layers is the whole
 * point of having layers ("Kick hits" and "FX triggers" both fire on the
 * downbeat), so it is never a duplicate.
 */
export function findItemAtSpot<T>(
  items: readonly T[],
  probe: SpotFootprint,
  footprintOf: (item: T) => SpotFootprint,
): T | undefined {
  return items.find((item) => isSameSpot(footprintOf(item), probe));
}

/**
 * One-line notice for the add that didn't happen. Says what was already
 * there and what happened instead, because a button that does nothing reads
 * as a broken button. `instead` covers the layers that can't select the item
 * they found (boundaries have no per-item focus).
 */
export function duplicateItemNotice(
  kind: string,
  probe: SpotFootprint,
  instead = 'selected it instead of stacking a second one on top',
): string {
  const where = probe.end != null
    ? `${formatClockTime(probe.at, 3)}–${formatClockTime(probe.end, 3)}`
    : formatClockTime(probe.at, 3);
  return `A ${kind} is already at ${where} in this layer — ${instead}.`;
}
