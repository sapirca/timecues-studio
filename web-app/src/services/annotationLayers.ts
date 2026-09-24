/**
 * Client for the annotation-layers API.
 *
 * One document per song per annotator holds EVERY layer the curator authored
 * for that song — boundaries, cues, spans, loops, patterns, riff-patterns,
 * lyrics. Layer ordering, rename, visibility, colour and items all live in
 * this one file.
 *
 * Backend: web-app/vite.config.ts — /api/annotation-layers/:slug
 */

import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  BoundaryItem,
  RiffCombo,
  RiffNode,
  RiffPatternItem,
  RiffSeqEntry,
} from '../types/annotationLayer';
import {
  emptyDocument, PATTERN_SUBBEATS_PER_BEAT, RIFF_DEFAULT_ENTRY_STEPS,
  RIFF_NODE_COLORS, RIFF_COMBO_COLORS, pickFromPalette, pruneGroups,
} from '../types/annotationLayer';
import type { AnnotationLayerType } from '../types/annotationLayer';
import { annotatorHeaders } from '../utils/annotatorHeaders';

/** Upgrade legacy riff-pattern sequences in-place to the length-carrying entry
 *  model. Pre-2026-08-22 documents stored `combo.sequence` / `item.sequence`
 *  as bare `RiffNode.id | RiffCombo.id` strings with no notion of how long
 *  each occurrence lasts. The new model wraps each reference in
 *  `{ type, lengthSteps }` so siblings can lay out end-to-end at their own
 *  width. We detect legacy sequences by their entries being plain strings and
 *  give each one the flat one-bar fallback (RIFF_DEFAULT_ENTRY_STEPS) — the
 *  same "old entries default to 1 bar" rule used for any other legacy-data
 *  upgrade in this file.
 *
 *  Also upgrades nodes missing `subbeatsPerBeat` (pre-2026-08-22 nodes were
 *  always quarter-of-a-beat) to the `PATTERN_SUBBEATS_PER_BEAT` default so the
 *  per-node subdivision picker has a value to start from. */
function migrateRiffSequences(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  let changed = false;
  const upgradeSeq = (sequence: readonly (string | RiffSeqEntry)[]): RiffSeqEntry[] => {
    if (sequence.length === 0) return sequence as RiffSeqEntry[];
    if (typeof sequence[0] === 'string') {
      changed = true;
      return (sequence as string[]).map((type) => ({ type, lengthSteps: RIFF_DEFAULT_ENTRY_STEPS }));
    }
    return sequence as RiffSeqEntry[];
  };
  const upgradeNodes = (nodes: readonly RiffNode[] | undefined): RiffNode[] =>
    (nodes ?? []).map((n) => {
      if (n.subbeatsPerBeat != null) return n;
      changed = true;
      return { ...n, subbeatsPerBeat: PATTERN_SUBBEATS_PER_BEAT };
    });
  const nextLayers = doc.layers.map((l) => {
    if (l.type !== 'riff-patterns') return l;
    const nodes = upgradeNodes(l.nodes as RiffNode[] | undefined);
    const combos = (l.combos ?? []).map((c) => ({ ...c, sequence: upgradeSeq(c.sequence) })) as RiffCombo[];
    const items = (l.items as RiffPatternItem[]).map((it) => ({ ...it, sequence: upgradeSeq(it.sequence) }));
    return { ...l, nodes, combos, items } as AnnotationLayer;
  });
  return changed ? { ...doc, layers: nextLayers } : doc;
}

/** Rebalance node/combo colors across ALL riff-pattern layers in a document,
 *  one-time, on load. `pickRiffNodeColor`/`pickRiffComboColor` only dedupe a
 *  new node/combo against its own layer's existing ones, so two independent
 *  riff-pattern layers each starting their own count from zero would
 *  previously both land their first node on the palette's first color (e.g.
 *  orange) — making unrelated layers look like the same color on the canvas.
 *  This walks every riff-pattern layer in document order, tracking colors
 *  already assigned by *earlier* layers (and earlier nodes/combos in the same
 *  layer) in a running set, and reassigns the next free palette color whenever
 *  a node/combo's saved color collides with one already claimed. */
function migrateRiffColors(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  let changed = false;
  const usedNodeColors = new Set<string>();
  const usedComboColors = new Set<string>();
  let nodeCount = 0;
  let comboCount = 0;
  const nextLayers = doc.layers.map((l) => {
    if (l.type !== 'riff-patterns') return l;
    const nodes = (l.nodes as RiffNode[] ?? []).map((n) => {
      let color = n.color;
      if (usedNodeColors.has(color)) {
        color = pickFromPalette(RIFF_NODE_COLORS, usedNodeColors, nodeCount);
        changed = true;
      }
      usedNodeColors.add(color);
      nodeCount += 1;
      return color === n.color ? n : { ...n, color };
    });
    const combos = (l.combos ?? []).map((c) => {
      let color = c.color;
      if (color && usedComboColors.has(color)) {
        color = pickFromPalette(RIFF_COMBO_COLORS, usedComboColors, comboCount);
        changed = true;
      }
      if (color) usedComboColors.add(color);
      comboCount += 1;
      return color === c.color ? c : { ...c, color };
    });
    return { ...l, nodes, combos } as AnnotationLayer;
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
    // Run the same legacy-data migrations we apply to single-annotator fetches.
    const out: Record<string, Record<string, AnnotationLayersDocument>> = {};
    for (const [slug, byAnn] of Object.entries(annotations)) {
      out[slug] = {};
      for (const [ann, doc] of Object.entries(byAnn)) {
        out[slug][ann] = pruneGroups(migrateRiffColors(migrateRiffSequences(doc)));
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
    return pruneGroups(migrateRiffColors(migrateRiffSequences(data)));
  } catch {
    return emptyDocument(slug);
  }
}

/** Save the entire layers document. Returns true on success.
 *  Pass `keepalive: true` only for tab-close / unmount flush call sites —
 *  Chromium caps `fetch(..., { keepalive: true })` bodies at ~64KiB and
 *  silently rejects (no network attempt) above that, which was dropping
 *  routine saves once a copied algorithm-output layer pushed the document
 *  over the limit. Regular debounced saves must NOT set it. */
export async function saveLayers(
  slug: string,
  doc: AnnotationLayersDocument,
  opts?: { keepalive?: boolean },
): Promise<boolean> {
  try {
    const stamped: AnnotationLayersDocument = { ...doc, annotated_at: new Date().toISOString() };
    const res = await fetch(`/api/annotation-layers/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(stamped),
      keepalive: opts?.keepalive ?? false,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Boundary-layer helpers ─────────────────────────────────────────────────
//
// Boundaries are an ordinary layer type, but two things still single them out:
// they tile the track (so order matters within a layer), and downstream
// consumers — evaluation, cross-annotator agreement, the dataset export — need
// ONE reference reading per annotator. That reference is the first boundaries
// layer in document order, which is the one the canvas draws at the top.

/** Every boundaries layer in a document, in document order. */
export function boundaryLayers(
  doc: AnnotationLayersDocument | null | undefined,
): AnnotationLayer<'boundaries'>[] {
  return (doc?.layers ?? []).filter(
    (l): l is AnnotationLayer<'boundaries'> => l.type === 'boundaries',
  );
}

/** The reference boundaries layer for a song — first in document order, or
 *  `null` when the annotator has not started any. */
export function primaryBoundaryLayer(
  doc: AnnotationLayersDocument | null | undefined,
): AnnotationLayer<'boundaries'> | null {
  return boundaryLayers(doc)[0] ?? null;
}

/** Time-sorted items of the reference boundaries layer. Boundaries tile, so
 *  every consumer wants them in order; sorting here means no caller has to
 *  defend itself against an out-of-order layer. */
export function primaryBoundaryItems(
  doc: AnnotationLayersDocument | null | undefined,
): BoundaryItem[] {
  const layer = primaryBoundaryLayer(doc);
  if (!layer) return [];
  return [...layer.items].sort((a, b) => a.time - b.time);
}

/** Fetch just the reference boundary items for a song. The convenience most
 *  eval / detector-comparison callers want: they need the curator's reading of
 *  the structure, not the whole document. */
export async function loadBoundaryItems(slug: string): Promise<BoundaryItem[]> {
  return primaryBoundaryItems(await loadLayers(slug));
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
  layers: Partial<Record<AnnotationLayerType, LayerTypeSummary>>;
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
