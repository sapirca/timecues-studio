import type { AnnotationLayer, BoundaryItem, CueItem, LoopItem, SpanItem } from '../types/annotationLayer';

/** Layer types a lane can be snapped as a whole: the ones whose items are
 *  plain times. Lyrics never snap (a sung word is timed to the voice), and a
 *  riff pattern's notes are pinned to the audio inside it, so moving its
 *  edges would be a lie about where the sound is. */
export const SNAPPABLE_LANE_TYPES = ['boundaries', 'cues', 'spans', 'loops'] as const;
export type SnappableLaneType = typeof SNAPPABLE_LANE_TYPES[number];

export function isSnappableLane(layer: AnnotationLayer): boolean {
  return (SNAPPABLE_LANE_TYPES as readonly string[]).includes(layer.type);
}

const MOVED_EPS = 1e-4;

/** Every item of `layer` moved by `snap` — times, edges and their
 *  candidates — and how many items actually moved. A span or loop whose two
 *  edges would land on the same beat is left as it was rather than squeezed
 *  to nothing. Other layer types come back unchanged. */
export function snapLayerItems(
  layer: AnnotationLayer,
  snap: (t: number) => number,
): { layer: AnnotationLayer; moved: number } {
  let moved = 0;
  if (layer.type === 'boundaries' || layer.type === 'cues') {
    const items = (layer.items as (BoundaryItem | CueItem)[]).map((item) => {
      const time = snap(item.time);
      if (Math.abs(time - item.time) <= MOVED_EPS) return item;
      moved++;
      return { ...item, time, candidates: item.candidates?.map((c) => snap(c)) };
    });
    return { layer: moved ? ({ ...layer, items } as AnnotationLayer) : layer, moved };
  }
  if (layer.type === 'spans' || layer.type === 'loops') {
    const items = (layer.items as (SpanItem | LoopItem)[]).map((item) => {
      const start = snap(item.start);
      const end = snap(item.end);
      if (end - start <= MOVED_EPS) return item;
      if (Math.abs(start - item.start) <= MOVED_EPS && Math.abs(end - item.end) <= MOVED_EPS) return item;
      moved++;
      return {
        ...item, start, end,
        candidates: item.candidates?.map(([s, e]) => [snap(s), snap(e)] as [number, number]),
      };
    });
    return { layer: moved ? ({ ...layer, items } as AnnotationLayer) : layer, moved };
  }
  return { layer, moved: 0 };
}
