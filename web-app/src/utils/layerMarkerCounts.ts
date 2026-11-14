import type { AnnotationLayer } from '../types/annotationLayer';

/** How many markers a lane holds, and how they split by kind — what the lane
 *  card answers so nobody has to count ticks on the canvas.
 *
 *  "Kind" is the item's label (kick / snare / hat on a drum-hits lane, the
 *  section name on a boundary lane). Detectors that describe each item write
 *  "Rise · bass · 1-bar climb" — kind first, detail after — so only the part
 *  before the first " · " counts, or every item would be its own kind. A
 *  lyrics lane splits by word vs line, since its labels are the lyrics. */
export interface LayerMarkerCounts {
  total: number;
  /** Plural noun for `total` on this layer type ("markers", "sections"…). */
  noun: string;
  /** Most frequent first, ties alphabetical. Empty labels count as "unlabelled". */
  kinds: { kind: string; count: number }[];
}

const NOUN: Record<AnnotationLayer['type'], string> = {
  boundaries: 'boundaries',
  cues: 'markers',
  spans: 'spans',
  loops: 'loops',
  lyrics: 'lyrics',
  'riff-patterns': 'riffs',
};

export const UNLABELLED_KIND = 'unlabelled';

/** The kind one item counts under (see LayerMarkerCounts). */
export function markerKind(type: AnnotationLayer['type'], item: unknown): string {
  const it = item as { label?: string; kind?: string };
  const raw = type === 'lyrics'
    ? (it.kind === 'line' ? 'lines' : 'words')
    : (it.label ?? '').split(' · ')[0].trim();
  return raw || UNLABELLED_KIND;
}

export function layerMarkerCounts(layer: Pick<AnnotationLayer, 'type' | 'items'>): LayerMarkerCounts {
  const byKind = new Map<string, number>();
  for (const item of layer.items) {
    const kind = markerKind(layer.type, item);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const kinds = [...byKind]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return { total: layer.items.length, noun: NOUN[layer.type], kinds };
}
