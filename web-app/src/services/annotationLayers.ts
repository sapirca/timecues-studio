/**
 * Client for the annotation-layers API.
 *
 * One document per song per annotator holds EVERY layer the curator authored
 * for that song — boundaries, cues, spans, loops, riff-patterns, lyrics. Layer ordering, rename, visibility, colour and items all live in
 * this one file.
 *
 * Backend: web-app/vite.config.ts — /api/annotation-layers/:slug
 */

import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  BoundaryItem,
  RiffNode,
} from '../types/annotationLayer';
import {
  emptyDocument, newId,
  RIFF_NODE_COLORS, RIFF_COMBO_COLORS, pickFromPalette, pruneGroups, withLyricSpans,
} from '../types/annotationLayer';
import type { AnnotationLayerType } from '../types/annotationLayer';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { resolveVocalRuns, type VocalRunGrid } from '../utils/vocalRuns';
import { toStoredLayers, withSecondsFromBeats } from '../utils/beatTimebase';

/** Every lyric is a span. Layers saved before that held words with no `end`
 *  (added by hand) or a zero-length one (an aligner's open-ended last word, a
 *  short word snapped onto one beat); each gets a real length on load. */
function migrateLyricSpans(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  let changed = false;
  const nextLayers = doc.layers.map((l) => {
    if (l.type !== 'lyrics') return l;
    const items = withLyricSpans(l.items as AnnotationLayer<'lyrics'>['items']);
    if (items === l.items) return l;
    changed = true;
    return { ...l, items } as AnnotationLayer;
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
        // A file the doc cannot place (beats, no grid) is left out of the
        // cross-annotator read rather than shown with marks at nowhere.
        try {
          out[slug][ann] = pruneGroups(migrateLyricSpans(migrateRiffColors(withSecondsFromBeats(doc))));
        } catch { /* skipped */ }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Load `slug`'s layers for EDITING. The empty document means only one thing
 *  here — the song has no layer file yet. Anything else (the server didn't
 *  answer, answered an error, sent something that isn't a layers document)
 *  throws, because an editor that shows a failed load as an empty song gets
 *  saved as one: the next edit writes that emptiness over every layer the
 *  file held. */
export async function loadLayersForEdit(slug: string): Promise<AnnotationLayersDocument> {
  const res = await fetch(`/api/annotation-layers/${encodeURIComponent(slug)}`, {
    headers: annotatorHeaders(),
  });
  if (!res.ok) throw new Error(`layers load failed: HTTP ${res.status}`);
  const data = (await res.json()) as AnnotationLayersDocument | null;
  if (data === null) return emptyDocument(slug);
  if (!Array.isArray(data.layers)) throw new Error('layers load failed: not a layers document');
  // A Grid Lock save stores beats only; everything in the app works in
  // seconds, so they are read off the file's own grid here (and stripped
  // again by saveLayers). Throws on a beats file with no grid — see above.
  return pruneGroups(migrateLyricSpans(migrateRiffColors(withSecondsFromBeats(data))));
}

/** Load all annotation layers for `slug`, for READING (tables, export).
 *  Returns an empty document (not null) on any failure, so a reader renders
 *  something; never save what this returns — use loadLayersForEdit. */
export async function loadLayers(slug: string): Promise<AnnotationLayersDocument> {
  try {
    return await loadLayersForEdit(slug);
  } catch {
    return emptyDocument(slug);
  }
}

/** `conflict`: the file moved on since `baseRev` — another tab, window or
 *  device saved this song — and the write was refused rather than let this
 *  page's copy replace theirs. */
export type SaveLayersResult = { ok: true; rev: number } | { ok: false; conflict: boolean };

/** Save the entire layers document.
 *
 *  Every save names the revision it was edited from (If-Match), `baseRev`
 *  or else the `rev` the document was loaded with; a document that never had
 *  a file is revision 0. The server refuses the write when its file is at
 *  any other revision. Without that a whole-document save is last-write-wins:
 *  a second tab still holding an older copy of the song, or a page whose load
 *  failed and showed it empty, replaced every layer added since.
 *
 *  Pass `keepalive: true` only for tab-close / unmount flush call sites —
 *  Chromium caps `fetch(..., { keepalive: true })` bodies at ~64KiB and
 *  silently rejects (no network attempt) above that, which was dropping
 *  routine saves once a copied algorithm-output layer pushed the document
 *  over the limit. Regular debounced saves must NOT set it. */
export async function saveLayers(
  slug: string,
  doc: AnnotationLayersDocument,
  opts?: { keepalive?: boolean; baseRev?: number },
): Promise<SaveLayersResult> {
  const baseRev = opts?.baseRev ?? doc.rev ?? 0;
  try {
    // `toStoredLayers` writes a beats document (Grid Lock) by its beats
    // alone; a seconds document goes as it is. Whoever loaded the document
    // keeps its timebase, so re-saving a song from elsewhere (the sidebar's
    // mark-reviewed) cannot quietly turn a beats file back into seconds.
    const stamped: AnnotationLayersDocument = toStoredLayers({ ...doc, annotated_at: new Date().toISOString() });
    const res = await fetch(`/api/annotation-layers/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json', 'If-Match': String(baseRev) }),
      body: JSON.stringify(stamped),
      keepalive: opts?.keepalive ?? false,
    });
    if (!res.ok) return { ok: false, conflict: res.status === 409 && (await isStaleRevision(res)) };
    const body = (await res.json().catch(() => null)) as { rev?: unknown } | null;
    return { ok: true, rev: typeof body?.rev === 'number' ? body.rev : baseRev + 1 };
  } catch {
    return { ok: false, conflict: false };
  }
}

/** A 409 is also how a shared song's edit lock refuses a write; only the
 *  revision check says `stale revision`. */
async function isStaleRevision(res: Response): Promise<boolean> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === 'stale revision';
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

/** Copy an authored layer to a new layer right below it, named "<name> copy".
 *  Everything comes along — items, riff node/combo library, vocal runs, group —
 *  and only the layer gets a new id: item, node and run ids are scoped to their
 *  own layer, so the copy's can match the original's without colliding. The
 *  copy is never locked — it is the take you are about to change.
 *  Read-only detector lanes are re-derived each render; those copy through
 *  "Copy to manual layer" instead. */
export function duplicateLayer(
  doc: AnnotationLayersDocument,
  layerId: string,
  copyId: string = newId(),
): AnnotationLayersDocument {
  const at = doc.layers.findIndex((l) => l.id === layerId);
  if (at < 0 || doc.layers[at].readOnly) return doc;
  const source = doc.layers[at];
  const copy = structuredClone({ ...source, id: copyId, name: `${source.name} copy`, locked: undefined }) as AnnotationLayer;
  const layers = doc.layers.slice();
  layers.splice(at + 1, 0, copy);
  return { ...doc, layers };
}

/** True when `sourceId` can be folded into `targetId`: two different authored
 *  layers of the same type. Read-only detector lanes are re-derived each render
 *  and never persisted, so there is nothing to merge into or out of. Riff
 *  patterns are left out: their instances point into a per-layer node and combo
 *  library by id, and two libraries cannot be joined without renaming every
 *  reference — a bigger operation than "move these items over". */
export function canMergeLayers(
  doc: AnnotationLayersDocument,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return false;
  const source = doc.layers.find((l) => l.id === sourceId);
  const target = doc.layers.find((l) => l.id === targetId);
  return !!source && !!target
    && source.type === target.type
    && source.type !== 'riff-patterns'
    && !source.readOnly && !target.readOnly;
}

/** Fold every item of `sourceId` into `targetId` and drop the source layer.
 *
 *  The target keeps its name, colour, group and position; the merged items are
 *  sorted by time. An item that is an exact copy of one already in the target
 *  (same times, same label, same everything but the id) is dropped rather than
 *  drawn twice — two copies of one detector lane are the common case. A source
 *  item whose id the target already uses gets a fresh one.
 *
 *  Lyrics carry their vocal runs over. When neither layer has stored runs there
 *  is nothing to carry, and the merged words derive their runs as usual; when
 *  either has, both sides' resolved runs are stored, so prominence the annotator
 *  already levelled on either voice survives the merge. `grid` is what the
 *  unstored side derives its runs against. */
export function mergeLayers(
  doc: AnnotationLayersDocument,
  sourceId: string,
  targetId: string,
  grid?: VocalRunGrid,
): AnnotationLayersDocument {
  if (!canMergeLayers(doc, sourceId, targetId)) return doc;
  const source = doc.layers.find((l) => l.id === sourceId)!;
  const target = doc.layers.find((l) => l.id === targetId)!;

  type AnyItem = { id: string; time?: number; start?: number };
  const contentKey = (it: AnyItem) => JSON.stringify({ ...it, id: undefined });
  const targetItems = target.items as readonly AnyItem[];
  const seenKeys = new Set(targetItems.map(contentKey));
  const usedIds = new Set(targetItems.map((it) => it.id));
  const moved: AnyItem[] = [];
  for (const it of source.items as readonly AnyItem[]) {
    const key = contentKey(it);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const id = usedIds.has(it.id) ? newId() : it.id;
    usedIds.add(id);
    moved.push(id === it.id ? it : { ...it, id });
  }
  const at = (it: AnyItem) => it.time ?? it.start ?? 0;
  const items = [...targetItems, ...moved].sort((a, b) => at(a) - at(b));

  const patch: Partial<AnnotationLayer> = { items: items as AnnotationLayer['items'] };
  if (target.type === 'lyrics' && (target.vocalRuns || source.vocalRuns)) {
    const runIds = new Set<string>();
    patch.vocalRuns = [...resolveVocalRuns(target, grid), ...resolveVocalRuns(source, grid)]
      .map((r) => {
        const run = runIds.has(r.id) ? { ...r, id: newId() } : r;
        runIds.add(run.id);
        return run;
      })
      .sort((a, b) => a.start - b.start);
  }

  return {
    ...doc,
    layers: doc.layers
      .filter((l) => l.id !== sourceId)
      .map((l) => (l.id === targetId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
  };
}
