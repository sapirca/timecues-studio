import type { AnnotationLayer, RiffPatternItem } from '../types/annotationLayer';
import { snapLayerItems } from './laneSnap';

/** The layer types Grid Lock can pull onto the grid when it is turned on.
 *  Cues are not offered: there are thousands of them and a hit can sit
 *  between beats on purpose. Lyrics never snap. */
export const GRID_LOCK_SNAP_TYPES = ['boundaries', 'loops', 'spans', 'riff-patterns'] as const;
export type GridLockSnapType = typeof GRID_LOCK_SNAP_TYPES[number];

/** One item Grid Lock would move: where it is and where it lands. A boundary
 *  has only a start; spans, loops and riff instances carry their end too. */
export interface GridLockMove {
  id: string;
  /** The lane's name, so two lanes of one type can be told apart. */
  lane: string;
  label: string;
  from: { start: number; end?: number };
  to: { start: number; end?: number };
}

export type GridLockPlan = {
  layers: AnnotationLayer[];
  moves: Record<GridLockSnapType, GridLockMove[]>;
};

const MOVED_EPS = 1e-4;

function isGridLockType(type: string): type is GridLockSnapType {
  return (GRID_LOCK_SNAP_TYPES as readonly string[]).includes(type);
}

/** Snap the layers of the given types with `snap`, and list every item that
 *  moved. The dialog previews with this and the confirm applies the same
 *  result, so what the list shows is exactly what happens.
 *
 *  Boundaries, spans and loops go through the lane snap (a span that would
 *  shrink to nothing stays put). A riff instance moves as a whole — its
 *  start snaps and its length rides along — because that length is the
 *  pattern's own content, its node sequence times its repeat count. */
export function planGridLockSnap(
  layers: readonly AnnotationLayer[],
  types: readonly GridLockSnapType[],
  snap: (t: number) => number,
): GridLockPlan {
  const moves: GridLockPlan['moves'] = { boundaries: [], loops: [], spans: [], 'riff-patterns': [] };
  const picked = new Set<string>(types);
  const out = layers.map((layer) => {
    if (!picked.has(layer.type) || !isGridLockType(layer.type)) return layer;
    const list = moves[layer.type];
    if (layer.type === 'riff-patterns') {
      let changed = false;
      const items = (layer.items as RiffPatternItem[]).map((item) => {
        const start = snap(item.start);
        if (Math.abs(start - item.start) <= MOVED_EPS) return item;
        changed = true;
        const end = start + (item.end - item.start);
        list.push({ id: item.id, lane: layer.name, label: item.label,
          from: { start: item.start, end: item.end }, to: { start, end } });
        return { ...item, start, end };
      });
      return changed ? ({ ...layer, items } as AnnotationLayer) : layer;
    }
    const snapped = snapLayerItems(layer, snap).layer;
    if (snapped === layer) return layer;
    const before = layer.items as { id: string; label: string; time?: number; start?: number; end?: number }[];
    const after = snapped.items as typeof before;
    after.forEach((item, i) => {
      const old = before[i];
      if (item === old) return;
      list.push({
        id: item.id, lane: layer.name, label: item.label,
        from: old.time !== undefined ? { start: old.time } : { start: old.start!, end: old.end },
        to: item.time !== undefined ? { start: item.time } : { start: item.start!, end: item.end },
      });
    });
    return snapped;
  });
  return { layers: out, moves };
}
