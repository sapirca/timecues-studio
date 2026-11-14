import {
  newId, pickDefaultLayerColor,
  type AnnotationLayer, type AnnotationLayersDocument,
} from '../types/annotationLayer';
import { canMergeLayers } from './annotationLayers';
import { markerKind } from '../utils/layerMarkerCounts';
import { formatClockTime } from '../utils/clockTime';

// The actions of an authored lane's ⋮ menu beyond rename / duplicate / delete:
// merge it into another lane, split it into one lane per kind, copy what plays
// in the highlighted region to a new lane, and lock it against edits. Each is
// a pure document → document function, so the page applies it as one edit and
// ⌘Z takes it back whole.

/** The fields a lock leaves editable — how the lane is shown and filed, never
 *  what it says. Everything else (items, riff library, vocal runs, …) is
 *  frozen while `locked` is on. */
const LOCK_FREE_KEYS = new Set<string>(['name', 'visible', 'color', 'groupId', 'locked', 'snap']);

function lockedContent(layer: AnnotationLayer): string {
  // Top-level keys only: a riff node's own name and colour are content.
  return JSON.stringify(Object.entries(layer).filter(([k]) => !LOCK_FREE_KEYS.has(k)));
}

/** The locked layer `next` would change the contents of, or null when the edit
 *  leaves every locked layer as it was. A layer that stops being locked in the
 *  same edit, or is deleted, is not "changed": unlocking is how you edit it
 *  again, and deleting a lane asks first. The page refuses the whole edit when
 *  this returns a layer — a half-applied edit is worse than none, since a
 *  cross-lane move would drop the item from one lane and not land it on the
 *  other. */
export function lockedLayerEdited(
  prev: AnnotationLayersDocument | null,
  next: AnnotationLayersDocument | null,
): AnnotationLayer | null {
  if (!prev || !next || prev === next) return null;
  for (const before of prev.layers) {
    if (!before.locked) continue;
    const after = next.layers.find((l) => l.id === before.id);
    if (!after || !after.locked || after === before) continue;
    if (lockedContent(after) !== lockedContent(before)) return before;
  }
  return null;
}

/** The lanes `layerId` can be merged into: the same type, authored, and
 *  neither side locked. */
export function mergeTargets(doc: AnnotationLayersDocument, layerId: string): AnnotationLayer[] {
  const source = doc.layers.find((l) => l.id === layerId);
  if (!source || source.locked) return [];
  return doc.layers.filter((t) => !t.locked && canMergeLayers(doc, layerId, t.id));
}

/** Layer types whose label names a kind of hit or region (kick / snare, Rise /
 *  Drop). A lyrics label is the words, a boundary label is the section and a
 *  riff instance points into its own layer's library, so those don't split. */
const SPLITTABLE_TYPES = new Set<AnnotationLayer['type']>(['cues', 'spans', 'loops']);

/** The kinds `splitLayerByKind` would make lanes of, most items first — empty
 *  when the lane can't be split or holds only one kind. */
export function splitKinds(layer: AnnotationLayer): string[] {
  if (layer.readOnly || layer.locked || !SPLITTABLE_TYPES.has(layer.type)) return [];
  const counts = new Map<string, number>();
  for (const it of layer.items) {
    const k = markerKind(layer.type, it);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size < 2) return [];
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** Replace a lane with one lane per kind, in its place, named "<name> · <kind>"
 *  and kept in its group. The biggest kind keeps the lane's id and colour, so
 *  what pointed at the lane (the ADD+ target, a focused item) still lands. */
export function splitLayerByKind(
  doc: AnnotationLayersDocument,
  layerId: string,
  makeId: () => string = newId,
): AnnotationLayersDocument {
  const at = doc.layers.findIndex((l) => l.id === layerId);
  if (at < 0) return doc;
  const source = doc.layers[at];
  const kinds = splitKinds(source);
  if (kinds.length === 0) return doc;
  const others = doc.layers.filter((l) => l.id !== layerId);
  const parts: AnnotationLayer[] = [];
  kinds.forEach((kind, i) => {
    const items = source.items.filter((it) => markerKind(source.type, it) === kind);
    parts.push({
      ...source,
      id: i === 0 ? source.id : makeId(),
      name: `${source.name} · ${kind}`,
      color: i === 0 ? source.color : pickDefaultLayerColor([...others, ...parts]),
      items: structuredClone(items),
    } as AnnotationLayer);
  });
  const layers = doc.layers.slice();
  layers.splice(at, 1, ...parts);
  return { ...doc, layers };
}

type Timed = { time?: number; start?: number; end?: number };
const itemStart = (it: Timed) => it.start ?? it.time ?? 0;
const itemEnd = (it: Timed) => it.end ?? itemStart(it);

/** Items of `layer` that sound inside [lo, hi]: a point inside it, or a ranged
 *  item overlapping it. Ranged items are kept whole, never cut at the edge —
 *  their contents are pinned to the audio, so a cut would move nothing but
 *  would stop saying where the sound ends. */
export function itemsInRegion<T extends AnnotationLayer>(layer: T, lo: number, hi: number): T['items'] {
  return (layer.items as Timed[]).filter((it) => itemEnd(it) >= lo && itemStart(it) <= hi) as T['items'];
}

/** Copy what plays in [lo, hi] to a new lane right below the source, named
 *  "<name> 0:30–0:45". Everything else about the lane comes along (riff
 *  library, group); a lyrics lane keeps the stored vocal runs that overlap. The
 *  copy is never locked. */
export function copyLayerRegion(
  doc: AnnotationLayersDocument,
  layerId: string,
  lo: number,
  hi: number,
  copyId: string = newId(),
): AnnotationLayersDocument {
  const at = doc.layers.findIndex((l) => l.id === layerId);
  if (at < 0 || doc.layers[at].readOnly) return doc;
  const source = doc.layers[at];
  const items = itemsInRegion(source, lo, hi);
  if (items.length === 0) return doc;
  const copy = structuredClone({
    ...source,
    id: copyId,
    name: `${source.name} ${regionLabel(lo, hi)}`,
    items,
    locked: undefined,
    ...(source.vocalRuns ? { vocalRuns: source.vocalRuns.filter((r) => r.end >= lo && r.start <= hi) } : {}),
  }) as AnnotationLayer;
  const layers = doc.layers.slice();
  layers.splice(at + 1, 0, copy);
  return { ...doc, layers };
}

/** "0:30–0:45" — how a region is named on a lane and in the menu. */
export function regionLabel(lo: number, hi: number): string {
  return `${formatClockTime(lo, 0)}–${formatClockTime(hi, 0)}`;
}
