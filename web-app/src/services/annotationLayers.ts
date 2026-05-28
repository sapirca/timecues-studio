/**
 * Client for the annotation-layers API.
 *
 * Mirrors the pattern of services/manualAnnotations.ts but stores one document
 * per song per annotator that holds ALL user-created layers (Cues today;
 * Spans/Lyrics later) for that song.
 *
 * Backend: tools/python/custom_server.py — /api/annotation-layers/:slug
 */

import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  PatternItem,
} from '../types/annotationLayer';
import { emptyDocument, PATTERN_SUBBEATS_PER_BEAT } from '../types/annotationLayer';
import { annotatorHeaders } from '../utils/annotatorHeaders';

/** Upgrade legacy pattern items in-place to the sub-beat grid model.
 *  Pre-2026-05-20 documents stored `highlightedBeats` as 0..3 beat indices
 *  (PATTERN_BEATS_PER_CYCLE=4). The new model uses 0..(beatsPerBar*4-1)
 *  sub-beat indices. We detect legacy items by the absence of the
 *  `subbeatGrid` flag and multiply each value by PATTERN_SUBBEATS_PER_BEAT so
 *  old beat 1 (index 0) still ticks at the down-beat, old beat 3 (index 2)
 *  still ticks at sub-beat 8, etc. */
function migratePatternLayers(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  let changed = false;
  const nextLayers = doc.layers.map((l) => {
    if (l.type !== 'patterns') return l;
    const items = (l.items as PatternItem[]).map((it) => {
      if (it.subbeatGrid === true) return it;
      changed = true;
      return {
        ...it,
        highlightedBeats: (it.highlightedBeats ?? []).map((b) => b * PATTERN_SUBBEATS_PER_BEAT),
        subbeatGrid: true,
      };
    });
    return { ...l, items } as AnnotationLayer;
  });
  return changed ? { ...doc, layers: nextLayers } : doc;
}

/** Cross-annotator bulk read — researcher/admin only. Returns
 *  `{ slug: { annotatorId: doc } }` for every annotator that has any layers.
 *  Empty `{}` on auth failure (caller falls back to current-annotator only). */
export async function loadAllAnnotatorLayers(): Promise<Record<string, Record<string, AnnotationLayersDocument>>> {
  try {
    const res = await fetch('/api/bulk-annotation-layers?scope=all', {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { annotations?: Record<string, Record<string, AnnotationLayersDocument>> };
    const annotations = data.annotations ?? {};
    // Run the same legacy-pattern migration we apply to single-annotator fetches.
    const out: Record<string, Record<string, AnnotationLayersDocument>> = {};
    for (const [slug, byAnn] of Object.entries(annotations)) {
      out[slug] = {};
      for (const [ann, doc] of Object.entries(byAnn)) {
        out[slug][ann] = migratePatternLayers(doc);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Load all annotation layers for `slug`. Returns an empty document (not
 *  null) when the song has no layer file yet — callers can render an empty
 *  layer list immediately. */
export async function loadLayers(slug: string): Promise<AnnotationLayersDocument> {
  try {
    const res = await fetch(`/api/annotation-layers/${encodeURIComponent(slug)}`, {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return emptyDocument(slug);
    const data = (await res.json()) as AnnotationLayersDocument | null;
    if (!data || !Array.isArray(data.layers)) return emptyDocument(slug);
    return migratePatternLayers(data);
  } catch {
    return emptyDocument(slug);
  }
}

/** Save the entire layers document. Returns true on success.
 *  `keepalive: true` lets the request survive tab close / unmount flushes. */
export async function saveLayers(slug: string, doc: AnnotationLayersDocument): Promise<boolean> {
  try {
    const stamped: AnnotationLayersDocument = { ...doc, annotated_at: new Date().toISOString() };
    const res = await fetch(`/api/annotation-layers/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(stamped, null, 2),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Per-type summary returned by GET /api/annotation-layers (LIST). One entry
 *  per song that has a layers document on disk for the current annotator.
 *  Powers the song-list overall-annotation indicator + status popover. */
export interface LayerTypeSummary {
  count: number;
  status: 'in_progress' | 'ready_for_review' | 'reviewed';
}

export interface SongLayerStatuses {
  slug: string;
  layers: Partial<Record<'cues' | 'spans' | 'loops' | 'patterns' | 'lyrics', LayerTypeSummary>>;
}

/** List per-song layer summaries for the current annotator. Returns a Record
 *  keyed by slug so callers can do a single lookup per row. Missing slug =
 *  no layer document on disk (i.e. user has not started any user-created
 *  annotation for that song). */
export async function loadAllLayerStatuses(): Promise<Record<string, SongLayerStatuses>> {
  try {
    const res = await fetch('/api/annotation-layers', { headers: annotatorHeaders() });
    if (!res.ok) return {};
    const data = (await res.json()) as SongLayerStatuses[] | null;
    if (!Array.isArray(data)) return {};
    const out: Record<string, SongLayerStatuses> = {};
    for (const entry of data) {
      if (entry && typeof entry.slug === 'string') out[entry.slug] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** Delete the entire layers document for `slug`. Used when the curator wants
 *  to wipe their per-song layer state. */
export async function deleteLayers(slug: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/annotation-layers/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: annotatorHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Immutable helpers for document mutation ────────────────────────────────
//
// Editor panels call these to produce a new document; nothing in this module
// mutates the input. Each helper returns a fresh AnnotationLayersDocument so
// React state updates compare cleanly by reference.

export function addLayer(
  doc: AnnotationLayersDocument,
  layer: AnnotationLayer,
): AnnotationLayersDocument {
  return { ...doc, layers: [...doc.layers, layer] };
}

export function removeLayer(
  doc: AnnotationLayersDocument,
  layerId: string,
): AnnotationLayersDocument {
  return { ...doc, layers: doc.layers.filter((l) => l.id !== layerId) };
}

export function updateLayer(
  doc: AnnotationLayersDocument,
  layerId: string,
  patch: Partial<AnnotationLayer>,
): AnnotationLayersDocument {
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
  };
}

/** Move `layerId` to the given index, preserving the relative order of the
 *  remaining layers. Used by drag-reorder. */
export function reorderLayers(
  doc: AnnotationLayersDocument,
  layerId: string,
  toIndex: number,
): AnnotationLayersDocument {
  const fromIndex = doc.layers.findIndex((l) => l.id === layerId);
  if (fromIndex < 0 || toIndex < 0 || toIndex >= doc.layers.length || fromIndex === toIndex) {
    return doc;
  }
  const next = doc.layers.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return { ...doc, layers: next };
}
