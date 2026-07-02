/**
 * User-created annotation layers (Cues today; Spans/Lyrics later).
 *
 * These sit alongside the fixed Manual / Eye / AutoGuess tracks on the canvas.
 * Multiple layers of the same type can coexist on a song — e.g. "Kick hits"
 * and "FX triggers" are both Cue layers but render on separate rows with
 * separate items.
 *
 * Persistence: one file per song per annotator at
 *   data/annotations/layers/<annotator>/<slug>.json
 * served by /api/annotation-layers/:slug — see tools/python/custom_server.py.
 */

/** Built-in annotation paradigms. Extensible via the registry in annotations/.
 *
 *  - `cues`   — single timestamped events (shipped).
 *  - `spans`  — labeled intervals that may overlap (shipped).
 *  - `lyrics` — word/line lyric timestamps (deferred — needs Whisper/WhisperX).
 *  - `loops`  — grid-aware seamless-playback regions for auditioning N-bar
 *    phrases. Gated by `experimentalLoopsAndPatterns` Settings flag.
 *  - `patterns` — labeled intervals that visually multiply across the song
 *    (`repeatCount` tiled copies of the cycle). Carry a 4-beat chip set
 *    so the annotator can mark which beats inside the cycle the pattern
 *    accents. Gated by the same `experimentalLoopsAndPatterns` flag as Loops. */
export type AnnotationLayerType = 'cues' | 'spans' | 'lyrics' | 'loops' | 'patterns';

/** Beat-grid snap mode applied when new items are added to a layer. */
export type SnapMode = 'off' | 'beat' | 'bar';

/** Workflow status shown in the shared annotation toolbar pill.
 *  Distinct from the `AnnotationStatus` sidecar in manualAnnotation.ts (which
 *  is a per-slug metadata bundle). This is the storage union — legacy
 *  `ready_for_review` files still load but resave as `in_progress` on next
 *  user change. Live UI display is derived via `derivePillDisplay` below. */
export type AnnotationStage = 'in_progress' | 'ready_for_review' | 'reviewed';

/** What the user sees on the workflow pill. Three states, derived from
 *  (`hasItems` × stored `AnnotationStage`) by `derivePillDisplay`. */
export type AnnotationPillDisplay = 'not_started' | 'in_progress' | 'reviewed';

/** Single source of truth for "what label does the status pill show?" — used
 *  by the editor's StatusPill AND the sidebar popover so they can never
 *  disagree. Rule:
 *    !hasItems                         → 'not_started' (overrides storage —
 *                                        deleting every marker resets the
 *                                        workflow even if the file still
 *                                        says `reviewed`)
 *    hasItems && stage === 'reviewed'  → 'reviewed'
 *    otherwise                         → 'in_progress' (collapses legacy
 *                                        `ready_for_review` storage values) */
export function derivePillDisplay(
  hasItems: boolean,
  stage: AnnotationStage | undefined,
): AnnotationPillDisplay {
  if (!hasItems) return 'not_started';
  if (stage === 'reviewed') return 'reviewed';
  return 'in_progress';
}

/** Per-layer-type workflow status. Lives on AnnotationLayersDocument so the
 *  four layer kinds (cues/spans/loops/patterns) that share the same document
 *  can each carry their own pill independently. */
export type LayerStatusByType = Partial<Record<'cues' | 'spans' | 'loops' | 'patterns' | 'lyrics', AnnotationStage>>;

// ─── Item shapes (one per paradigm) ─────────────────────────────────────────

/** Per-item importance flag — mirrors ManualSection.importance. Omitted ⇒
 *  treated as 'critical'. Optional items are surfaced with a hollow ☆ star
 *  and may be excluded from critical-only evaluation downstream. */
export type ItemImportance = 'critical' | 'optional';

/** Per-layer evaluation mode. Lives on `AnnotationLayer` (and on
 *  `ManualAnnotation` for boundaries) and is toggled by the annotator next to
 *  the importance-weight slider in the eval panel.
 *
 *  - `'full-annotation'` (default) — every gold item must be matched. Unmatched
 *    gold items are misses. Standard recall/precision semantics. Use when the
 *    annotator is committing to a complete, exhaustive labelling of the track.
 *  - `'multiple-candidates'` — the whole layer is treated as a set of
 *    *alternative* annotations for the same underlying truth. Matching ANY
 *    one item in the layer satisfies the layer; the rest are not penalised
 *    as misses. Use when the annotator is exploring alternatives and only ONE
 *    entry is the "right" answer at evaluation time.
 *
 *  This is layer-level, separate from per-item `candidates`. Both can coexist:
 *  candidates are alternates WITHIN one annotation; mode is alternates ACROSS
 *  the whole layer. See `deep_research/evaluation_notes.md` for the full
 *  contract. */
export type LayerEvalMode = 'full-annotation' | 'multiple-candidates';

/** A single timestamped event (kick hit, FX trigger, clap, lyric word). */
export interface CueItem {
  /** Stable identifier — uuid. */
  id: string;
  /** Seconds from track start. Frontend uses seconds; backend serializes ms. */
  time: number;
  /** Short text rendered next to the tick on hover and in the editor list. */
  label: string;
  /** Longer free-form note shown only when the cue is selected in the editor. */
  description?: string;
  /** Critical (default, ★) vs. optional (☆). Missing ⇒ 'critical'. */
  importance?: ItemImportance;
  /** Alternative valid times in seconds. During evaluation any candidate within
   *  tolerance counts as a hit — mirrors ManualSection.candidates. */
  candidates?: number[];
}

/** A labeled time interval. May overlap with other spans on the same layer.
 *  Backend-supported but the user-facing UI lives behind a feature flag —
 *  see the Span TODO in tools/python/custom_api.py. */
export interface SpanItem {
  id: string;
  /** Seconds from track start. */
  start: number;
  /** Seconds from track start. Must be > start. */
  end: number;
  label: string;
  description?: string;
  importance?: ItemImportance;
  /** Alternative valid `[start, end]` intervals. During evaluation, matching ANY
   *  candidate counts as a hit; the matched candidate is consumed (no
   *  double-count). Mirrors `ManualSection.candidates` and `CueItem.candidates`. */
  candidates?: [number, number][];
}

/** Word- or line-level lyric timestamp. */
export interface LyricsItem {
  id: string;
  time: number;
  /** Only set when kind === 'line'; absent for word-level. */
  end?: number;
  text: string;
  kind: 'word' | 'line';
}

// A LoopItem is a labeled INTERVAL with grid-aware seamless-playback
// affordances. While labeling loops or sanity-checking that a structural
// boundary is clean, an annotator hears how an N-bar phrase loops back on
// itself — boundaries snap to bars and to zero-crossings so the rhythmic
// signature can be verified without manual slicing.
//
// The full paradigm lives behind the `experimentalLoopsAndPatterns`
// Settings flag: the editor (LoopEditorPanel), the canvas row
// (LoopLayerRow), the playback engine (useLoopPlayback) and the L / P
// hotkeys are all gated by it. Loop-output custom detectors are likewise
// hidden from the registry when the flag is off.
//
// The bars field is a UX convenience — store start/end in seconds (the
// canonical coordinate). bars is recomputed from the active BPM whenever
// the loop is rendered.
export interface LoopItem {
  id: string;
  /** Seconds from track start. */
  start: number;
  /** Seconds from track start. Must be > start. */
  end: number;
  label: string;
  description?: string;
  /** Cached bar length (end - start, in bars) for quick display. Recompute on BPM change. */
  bars?: number;
  /** Whether to snap loop boundaries to zero-crossings during playback. */
  snapZeroCross?: boolean;
  importance?: ItemImportance;
  /** Alternative valid `[start, end]` intervals. Same semantics as
   *  `SpanItem.candidates`. */
  candidates?: [number, number][];
}

/** Sub-beats per beat — each beat splits into this many "quarter-of-a-beat"
 *  steps (16th notes when a beat = quarter note). Steps per cycle = the song's
 *  beats-per-bar × this constant (16 for 4/4, 12 for 3/4, 20 for 5/4 …). */
export const PATTERN_SUBBEATS_PER_BEAT = 4;

/** Fallback steps per cycle = beatsPerBar × PATTERN_SUBBEATS_PER_BEAT. Used
 *  only when a pattern doesn't declare its own `stepsPerCycle` (user-created
 *  or legacy items); detector patterns carry an explicit grid — see
 *  `resolvePatternSteps`. */
export function patternStepsPerCycle(beatsPerBar: number): number {
  const n = Math.max(1, Math.floor(beatsPerBar || 4));
  return n * PATTERN_SUBBEATS_PER_BEAT;
}

/** The number of sub-steps in a pattern's cycle — the index space of its
 *  `highlightedBeats`. Prefers the pattern's own declared `stepsPerCycle`
 *  (set by the detector that emitted it); falls back to the song-bar formula
 *  for user-created / legacy patterns that don't declare one. */
export function resolvePatternSteps(
  item: Pick<PatternItem, 'stepsPerCycle'>,
  beatsPerBar: number,
): number {
  const declared = item.stepsPerCycle;
  if (declared !== undefined && Number.isFinite(declared) && declared >= 1) {
    return Math.floor(declared);
  }
  return patternStepsPerCycle(beatsPerBar);
}

/** A labeled interval that visually multiplies into `repeatCount` tiled copies.
 *  Distinct from Spans (no repetition) and Loops (single seamless playback) —
 *  patterns represent a repeating musical motif (e.g. a 1-bar kick pattern
 *  repeated 8× through a section). `start`/`end` describe ONE cycle; the row
 *  renders `repeatCount` adjacent tiles starting at `start`.
 *
 *  `highlightedBeats` carries 0-based step indices (0..patternStepsPerCycle-1)
 *  of sub-beats inside the cycle the user wants to emphasise — used to
 *  schedule audio ticks at those sub-beat positions in every repetition. */
export interface PatternItem {
  id: string;
  /** Cycle start, seconds from track start. */
  start: number;
  /** Cycle end, seconds from track start. Must be > start. The cycle duration
   *  is `(end - start)`; the full repeated region ends at
   *  `start + repeatCount * (end - start)`. */
  end: number;
  label: string;
  description?: string;
  /** How many times this cycle repeats in the song. Must be >= 1. */
  repeatCount: number;
  /** 0-based step indices inside one cycle (0..stepsPerCycle-1) that are
   *  emphasised. Empty = no steps emphasised. Multi-select. */
  highlightedBeats: number[];
  /** How many sub-steps the cycle is divided into — the index space of
   *  `highlightedBeats`. Set by the detector that emitted the pattern so the
   *  grid reflects the model's resolution. Absent on user-created / legacy
   *  patterns, which fall back to `beatsPerBar × PATTERN_SUBBEATS_PER_BEAT`
   *  (see `resolvePatternSteps`). */
  stepsPerCycle?: number;
  /** Marker for the sub-beat grid model (16th-note resolution). Absent on
   *  pre-2026-05-20 documents which stored beat indices (0..3); the loader
   *  upgrades those by multiplying highlightedBeats × PATTERN_SUBBEATS_PER_BEAT
   *  and stamping this flag. Always `true` on newly created items. */
  subbeatGrid?: boolean;
  importance?: ItemImportance;
  /** Alternative valid `[start, end]` cycle intervals. Same semantics as
   *  `SpanItem.candidates`. */
  candidates?: [number, number][];
}

/** Map a layer type to the shape of its items. */
export type LayerItem<T extends AnnotationLayerType> =
  T extends 'cues'     ? CueItem     :
  T extends 'spans'    ? SpanItem    :
  T extends 'lyrics'   ? LyricsItem  :
  T extends 'loops'    ? LoopItem    :
  T extends 'patterns' ? PatternItem :
  never;

// ─── Layer + Document ───────────────────────────────────────────────────────

export interface AnnotationLayer<T extends AnnotationLayerType = AnnotationLayerType> {
  /** Stable across renames. */
  id: string;
  /** User-visible name shown in the Annotations dropdown and editor header. */
  name: string;
  type: T;
  /** Canvas show/hide toggle. */
  visible: boolean;
  /** CSS hex color used for ticks/intervals on this layer. */
  color: string;
  /** Snap mode applied when new items are added. */
  snap: SnapMode;
  items: LayerItem<T>[];
  /** True when the layer is derived from a custom detector run rather than
   *  authored by the annotator. Editors must disable add/edit/delete on
   *  read-only layers; the canvas renders them identically. */
  readOnly?: boolean;
  /** Origin marker used by the merge logic. `'user'` = persisted in
   *  annotation-layers; `'detector:<name>'` = re-derived each render from
   *  the detector's cached envelope. Optional for forward compat. */
  source?: 'user' | `detector:${string}`;
  /** Detector name this layer was *copied* from via "Copy to manual layer".
   *  Distinct from `source: 'detector:<name>'` (which marks ephemeral, not-
   *  persisted detector mirrors): a layer with `importedFrom` is a normal
   *  persisted manual layer that just happens to remember where its seed
   *  points came from. The annotator edits it freely; the original detector
   *  output is untouched. UI may show a "from <X>" badge. */
  importedFrom?: string;
  /** Demucs stem a detector-sourced layer was built from ("vocals" | "drums" |
   *  "bass" | "other" | "guitar" | "piano"), or "mix" for whole-track
   *  detectors. Drives the lane label's stem tag and the highlight shown while
   *  that stem is auditioned. Only set on read-only detector layers; undefined
   *  on user-authored ones. */
  sourceStem?: 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano' | 'mix';
  /** The detector's one-line manifest `description` — the algorithm/heuristic
   *  this layer's items came from (e.g. "RMS energy presence of the vocals
   *  Demucs stem"). Surfaced in the lane's ⓘ info popover. Only set on
   *  read-only detector layers; undefined on user-authored ones. */
  sourceDescription?: string;
  /** Per-layer evaluation mode. Default `'full-annotation'` when omitted —
   *  pre-Phase-2 documents on disk don't have this field. See `LayerEvalMode`. */
  mode?: LayerEvalMode;
}

/** The single per-song-per-annotator document persisted by the layers API. */
export interface AnnotationLayersDocument {
  song: string;
  /** ISO timestamp of last save. */
  annotated_at: string;
  /** Ordered as displayed on the canvas; drag-reorder mutates this list. */
  layers: AnnotationLayer[];
  /** Workflow status per layer type (cues/spans/loops/patterns). Missing keys
   *  read as 'in_progress'. Set by the shared annotation toolbar's status pill. */
  statusByType?: LayerStatusByType;
}

// ─── Factories ──────────────────────────────────────────────────────────────

export function emptyDocument(song: string): AnnotationLayersDocument {
  return { song, annotated_at: new Date().toISOString(), layers: [], statusByType: {} };
}

/** Read the status for a layer type from a document, defaulting to in_progress
 *  when the field is missing (older files on disk pre-status-pill). */
export function getLayerStatus(
  doc: AnnotationLayersDocument | null | undefined,
  type: keyof LayerStatusByType,
): AnnotationStage {
  return doc?.statusByType?.[type] ?? 'in_progress';
}

/** Set the status for a layer type, returning a new document. */
export function setLayerStatus(
  doc: AnnotationLayersDocument,
  type: keyof LayerStatusByType,
  stage: AnnotationStage,
): AnnotationLayersDocument {
  return {
    ...doc,
    statusByType: { ...(doc.statusByType ?? {}), [type]: stage },
  };
}

/** Palette used by `newCueLayer` when the caller doesn't pass an explicit color. */
const DEFAULT_LAYER_COLORS = [
  '#34d399', // emerald
  '#60a5fa', // sky
  '#fbbf24', // amber
  '#f472b6', // pink
  '#a78bfa', // violet
  '#22d3ee', // cyan
] as const;

export function pickDefaultLayerColor(existingLayers: AnnotationLayer[]): string {
  const used = new Set(existingLayers.map((l) => l.color));
  for (const c of DEFAULT_LAYER_COLORS) if (!used.has(c)) return c;
  return DEFAULT_LAYER_COLORS[existingLayers.length % DEFAULT_LAYER_COLORS.length];
}

export function newCueLayer(name: string, color: string): AnnotationLayer<'cues'> {
  return {
    id: newId(),
    name,
    type: 'cues',
    visible: true,
    color,
    snap: 'beat',
    items: [],
  };
}

/** Backend-supported but gated by the experimental-annotation-types flag in
 *  Settings (see the Span TODO in tools/python/custom_api.py). */
export function newSpanLayer(name: string, color: string): AnnotationLayer<'spans'> {
  return {
    id: newId(),
    name,
    type: 'spans',
    visible: true,
    color,
    snap: 'beat',
    items: [],
  };
}

/** Scaffolding only — see the Loops TODO above LoopItem. The factory is here
 *  so a Loops layer round-trips through saveLayers/loadLayers today even
 *  though no UI for it exists yet. */
export function newLoopLayer(name: string, color: string): AnnotationLayer<'loops'> {
  return {
    id: newId(),
    name,
    type: 'loops',
    visible: true,
    color,
    snap: 'bar',  // Loops default to bar-snap; cues default to beat-snap.
    items: [],
  };
}

/** Backend-supported, gated by the experimentalLyricsFamily Settings flag.
 *  Lyrics layers default to no snap — word timestamps are sub-beat and should
 *  not be quantized to the grid. */
export function newLyricsLayer(name: string, color: string): AnnotationLayer<'lyrics'> {
  return {
    id: newId(),
    name,
    type: 'lyrics',
    visible: true,
    color,
    snap: 'off',
    items: [],
  };
}

export function newCueItem(time: number, label = '', description = ''): CueItem {
  return { id: newId(), time, label, description };
}

/** A new lyric item. `end` is only meaningful for `kind === 'line'`. */
export function newLyricsItem(
  time: number,
  text = '',
  kind: 'word' | 'line' = 'word',
  end?: number,
): LyricsItem {
  return { id: newId(), time, text, kind, ...(end !== undefined ? { end } : {}) };
}

export function newSpanItem(start: number, end: number, label = '', description = ''): SpanItem {
  return { id: newId(), start, end, label, description };
}

/** Experimental — gated by experimentalLoopsAndPatterns Settings flag. */
export function newPatternLayer(name: string, color: string): AnnotationLayer<'patterns'> {
  return {
    id: newId(),
    name,
    type: 'patterns',
    visible: true,
    color,
    snap: 'bar',  // Patterns default to bar-snap since the cycle is typically one bar.
    items: [],
  };
}

export function newPatternItem(
  start: number,
  end: number,
  label = '',
  description = '',
  repeatCount = 2,
): PatternItem {
  return {
    id: newId(),
    start,
    end,
    label,
    description,
    repeatCount: Math.max(1, Math.floor(repeatCount)),
    highlightedBeats: [],
    subbeatGrid: true,
  };
}

/** uuid via crypto.randomUUID when available; cheap fallback otherwise. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
