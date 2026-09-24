/**
 * Where a boundary goes when the annotator marks ONE point in time.
 *
 * Boundaries tile: an item is a section START and runs until the next item.
 * A single mark therefore can't mean "start a section here" without leaving
 * the music before it unannotated — which is what the annotator sees as a
 * hole at the head of the lane. So a single mark means the opposite:
 *
 *   the point is where the section you are annotating ENDS.
 *
 * The section runs from wherever the annotated region left off (0 on an empty
 * layer, the last boundary otherwise) up to the mark, and a trailing `unset`
 * cap is pushed at the mark so the rest of the track stays explicitly
 * undecided rather than being swallowed. Mark again later and that cap is
 * promoted to a real section — so tapping along to the music lays down
 * sections back-to-back, each one closed by the tap that ends it.
 *
 * Marks that land inside the already-annotated region are a different
 * gesture: there is nothing to fill in, so they split at the point and the
 * piece after it becomes the new section.
 *
 * Pure and id-minting only — every add path (playhead "+ Add", the M
 * shortcut, the click-only pending pill) funnels through here so the rule is
 * written once.
 */

import type { BoundaryItem } from '../../types/annotationLayer';
import { newId } from '../../types/annotationLayer';
import { UNSET_TYPE, sectionLabel } from './sectionConstants';

/** Type/label a freshly added section wears until the annotator types it. */
export const NEW_SECTION_TYPE = 'drop';
export const NEW_SECTION_LABEL = 'Drop';

/** Two times closer than this are the same edge (50 ms) — the tolerance the
 *  range-add already uses when deciding whether an endpoint is novel. */
export const EDGE_EPS = 0.05;

const byTime = (a: BoundaryItem, b: BoundaryItem) => a.time - b.time;

/** Milliseconds are the storage resolution; keep add paths from writing
 *  float dust into the document. */
export function roundTime(t: number): number {
  return Math.round(t * 1000) / 1000;
}

export function makeBoundaryItem(time: number, type: string, label: string): BoundaryItem {
  return { id: newId(), time, type, label };
}

export function makeSectionItem(time: number): BoundaryItem {
  return makeBoundaryItem(time, NEW_SECTION_TYPE, NEW_SECTION_LABEL);
}

export function makeUnsetCap(time: number): BoundaryItem {
  return makeBoundaryItem(time, UNSET_TYPE, sectionLabel(UNSET_TYPE));
}

/** Turn a cap into a real section in place, keeping its time and everything
 *  else it carries (beat anchor, description) so the shared edge can't
 *  jitter and nothing the annotator typed is dropped. */
export function promoteCap(item: BoundaryItem): BoundaryItem {
  return { ...item, type: NEW_SECTION_TYPE, label: NEW_SECTION_LABEL };
}

/**
 * Add a boundary for a single marked point. Returns `prev` unchanged when the
 * mark lands on a boundary that already exists.
 */
export function insertBoundaryAtPoint(
  prev: readonly BoundaryItem[],
  rawTime: number,
): BoundaryItem[] {
  const t = roundTime(rawTime);

  if (prev.length === 0) {
    // A mark at the very start has no stretch in front of it to close, so it
    // is the one case where the point IS a section start.
    if (t <= EDGE_EPS) return [makeSectionItem(0)];
    return [makeSectionItem(0), makeUnsetCap(t)];
  }

  const next = [...prev];
  if (next.some((s) => Math.abs(s.time - t) < EDGE_EPS)) return [...prev];

  const last = next[next.length - 1];
  if (t > last.time) {
    // Past the end of the annotated region: the stretch that was still open
    // closes here. An `unset` last item was the cap left by the previous
    // mark — it becomes the section this mark just ended.
    if (last.type === UNSET_TYPE) next[next.length - 1] = promoteCap(last);
    next.push(makeUnsetCap(t));
    return next;
  }

  // Inside the annotated region: a plain split.
  next.push(makeSectionItem(t));
  return next.sort(byTime);
}

/**
 * Which instant a point-add commits at.
 *
 *  - `live` is the media clock, read at the moment of the click. It is the
 *    only honest answer while the transport is running: the React
 *    `currentTime` prop is the same number one rAF coalesce, one setState and
 *    one inspector re-render later, so committing on it marks where the
 *    playhead WAS.
 *  - `pendingPoint` is the click-pending pill's own time, when one is showing.
 *    A pill is a mark the annotator dropped at some earlier moment; once
 *    playback has carried the cursor away from it, the cursor is what they are
 *    listening to when they press ADD, so the cursor wins. Within EDGE_EPS the
 *    pill wins instead — it holds the snapped value the click seeked to, which
 *    is exact where the media clock lands a few ms off it.
 *  - `fallback` (the prop) is used only when there is no live clock to read.
 */
export function resolvePointAddTime(args: {
  live?: number | null;
  fallback: number;
  pendingPoint?: number | null;
}): number {
  const { live, fallback, pendingPoint } = args;
  const cursor = live != null && Number.isFinite(live) ? live : fallback;
  if (pendingPoint != null && Math.abs(pendingPoint - cursor) < EDGE_EPS) return pendingPoint;
  return cursor;
}
