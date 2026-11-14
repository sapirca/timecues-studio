/**
 * Draw on a lane, get an item in that lane.
 *
 * The timeline used to have one gesture everywhere: drag paints the teal
 * highlight, then "+ Add" in the sidebar turns it into whatever the active
 * tab makes, in whichever layer the sidebar has selected. Two steps, and the
 * lane the annotator actually drew on had no say in where the item went.
 *
 * On an editable lane the gesture now IS the edit: a click on a cue lane drops
 * a cue there, a drag on a span / loop / lyrics lane makes a span / loop /
 * line over the dragged stretch — in that lane, whatever tab is open. The teal
 * highlight stays on the player and the signal rows, where there is no item
 * to make and listening to a stretch is the point.
 *
 * Only the active tab's editor panel is mounted, so this cannot go through a
 * panel controller: a drag on a loop lane while the Spans tab is open has no
 * loop panel to ask. It is the same add every panel does — same factory, same
 * duplicate rule (shared/duplicateItem.ts) — written once against the
 * document. Snapping is the caller's: the page snaps each type the way its
 * own adds do (lyrics never).
 */

import {
  newCueItem,
  newLoopItem,
  newLyricsItem,
  newSpanItem,
  type AnnotationLayer,
  type AnnotationLayersDocument,
} from '../../types/annotationLayer';
import { duplicateItemNotice, findItemAtSpot, type SpotFootprint } from './shared/duplicateItem';

/** Layer types a lane gesture can create into. Riff patterns are not here
 *  yet: a riff instance needs a pattern to be an instance of. */
export type LaneCreateType = 'cues' | 'spans' | 'loops' | 'lyrics';

export function isLaneCreateType(type: string): type is LaneCreateType {
  return type === 'cues' || type === 'spans' || type === 'loops' || type === 'lyrics';
}

/** Shorter than this a drag is a slip, not an interval — the panels' rule. */
export const MIN_LANE_ITEM_SEC = 0.05;

export type LaneCreateResult =
  | { kind: 'added'; doc: AnnotationLayersDocument; type: LaneCreateType; layerId: string; itemId: string }
  | { kind: 'duplicate'; type: LaneCreateType; layerId: string; itemId: string; notice: string }
  | { kind: 'none' };

const NONE: LaneCreateResult = { kind: 'none' };

/**
 * Add one item to `layerId` at `t1` (a point: cues) or over `t1..t2` (an
 * interval: spans, loops, lyric lines). Times are used as given — already
 * snapped — apart from ordering and clamping to the song. Returns `none` for
 * a read-only (detector) layer, an unknown layer, a type a lane can't create,
 * or an interval too short to be one.
 */
export function createLaneItem(
  doc: AnnotationLayersDocument,
  layerId: string,
  t1: number,
  t2: number | null,
  duration: number,
): LaneCreateResult {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer || layer.readOnly || !isLaneCreateType(layer.type)) return NONE;
  const type = layer.type;
  const clamp = (t: number) => Math.max(0, duration > 0 ? Math.min(duration, t) : t);

  let item: { id: string };
  let probe: SpotFootprint;
  let footprint: (it: unknown) => SpotFootprint;
  let noun: string;
  if (type === 'cues') {
    const at = clamp(t1);
    item = newCueItem(at, '');
    probe = { at };
    footprint = (it) => ({ at: (it as { time: number }).time });
    noun = 'cue';
  } else {
    if (t2 === null) return NONE;
    const s = clamp(Math.min(t1, t2));
    const e = clamp(Math.max(t1, t2));
    if (e - s < MIN_LANE_ITEM_SEC) return NONE;
    probe = { at: s, end: e };
    if (type === 'lyrics') {
      item = newLyricsItem(s, '', 'line', e);
      footprint = (it) => { const l = it as { time: number; end?: number }; return { at: l.time, end: l.end }; };
      noun = 'lyric line';
    } else {
      item = type === 'spans' ? newSpanItem(s, e) : newLoopItem(s, e);
      footprint = (it) => { const b = it as { start: number; end: number }; return { at: b.start, end: b.end }; };
      noun = type === 'spans' ? 'span' : 'loop';
    }
  }

  const existing = findItemAtSpot<{ id: string }>(layer.items, probe, footprint);
  if (existing) {
    return { kind: 'duplicate', type, layerId, itemId: existing.id, notice: duplicateItemNotice(noun, probe) };
  }
  return {
    kind: 'added',
    type,
    layerId,
    itemId: item.id,
    doc: {
      ...doc,
      layers: doc.layers.map((l) => (l.id === layerId
        ? ({ ...l, items: [...(l.items as readonly unknown[]), item] } as AnnotationLayer)
        : l)),
    },
  };
}

/** A lane-created item that is still only an offer: it draws on its lane and
 *  its card is open, but nothing is saved until the card's Done. Any other way
 *  out of the card drops it. */
export interface LaneDraft {
  type: LaneCreateType;
  layerId: string;
  itemId: string;
  /** Its card has been seen open. Until then a closed card means "not open
   *  yet" (the card opens a frame after the item lands), not "dismissed". */
  opened: boolean;
}

/** `doc` without the item `itemId`, wherever it sits now (the card can move
 *  it to another lane). The same object when there is nothing to remove, so
 *  untouched undo snapshots keep their identity. */
export function withoutItem<D extends AnnotationLayersDocument | null>(doc: D, itemId: string): D {
  if (!doc) return doc;
  const holder = doc.layers.find((l) => (l.items as readonly { id: string }[]).some((it) => it.id === itemId));
  if (!holder) return doc;
  return {
    ...doc,
    layers: doc.layers.map((l) => (l === holder
      ? ({ ...l, items: (l.items as readonly { id: string }[]).filter((it) => it.id !== itemId) } as AnnotationLayer)
      : l)),
  };
}

/** Content equality for undo snapshots. Only run when a draft is dropped, so
 *  the cost of serialising a few dozen documents once is fine. */
export function sameLayersDoc(a: AnnotationLayersDocument | null, b: AnnotationLayersDocument | null): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
