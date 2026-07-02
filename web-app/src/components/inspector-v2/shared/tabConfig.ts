/**
 * Single source of truth for annotation tab labels, ordering, and experimental
 * gating. Consumed by the experimental-gating helpers below and by
 * InspectorPageV2 (state + caps). The type chips themselves now render as the
 * section titles in <UnifiedAnnotationListPanel> via <AnnotationTypeChip>.
 *
 * Adding a new annotation type: add a leaf entry here and (if it lives behind
 * an experimental flag) flip the `experimental` bit. Every entry in TAB_CONFIG
 * is a flat leaf — the old `boundaries → {manual,autoGuess}` sub-chip
 * grouping moved to <AnnotationSourcePicker>, which switches the boundary
 * source for the single `'boundaries'` tab.
 */

/** Top-level annotation tabs the editor exposes. `boundaries` is a single
 *  type; its source (manual/autoGuess/detector) is selected via the
 *  AnnotationSourcePicker dropdown, not via separate tabs. */
export type AnnotationType =
  | 'boundaries'
  | 'cues' | 'spans'
  | 'loops' | 'patterns' // currently experimental
  | 'lyrics';            // experimental (experimentalLyricsFamily)

/** Discriminator for which source authored a boundaries annotation. Used in
 *  the source picker, on-disk file selection, and the per-source viz rows. */
export type BoundarySource = 'manual' | 'autoGuess';

/** Identifies which Settings experimental flag (if any) gates a tab or source.
 *  - `'loopsAndPatterns'` — `experimentalLoopsAndPatterns` */
export type ExperimentalFlagKey = 'loopsAndPatterns' | 'lyrics';

export interface TabLeaf {
  id: AnnotationType;
  label: string;
  /** When set, the tab is hidden unless the matching Settings flag is on. */
  experimental?: ExperimentalFlagKey;
}

/** Ordered top-level annotation-type list. Drives experimental gating; the
 *  matching UI chips render as section titles in the annotation list. */
export const TAB_CONFIG: TabLeaf[] = [
  { id: 'boundaries', label: 'Boundaries' },
  { id: 'cues',       label: 'Cues' },
  { id: 'spans',      label: 'Spans' },
  { id: 'loops',      label: 'Loops',    experimental: 'loopsAndPatterns' },
  { id: 'patterns',   label: 'Patterns', experimental: 'loopsAndPatterns' },
  { id: 'lyrics',     label: 'Lyrics',   experimental: 'lyrics' },
];

/** True when the type is the boundaries tab. */
export function isBoundary(type: AnnotationType): boolean {
  return type === 'boundaries';
}

/** True when the type is one of the multi-layer annotation kinds that share
 *  the AnnotationLayersDocument (cues/spans/loops/patterns). */
export function isLayerType(
  type: AnnotationType,
): type is 'cues' | 'spans' | 'loops' | 'patterns' | 'lyrics' {
  return type === 'cues' || type === 'spans' || type === 'loops' || type === 'patterns' || type === 'lyrics';
}

/** True for the types that participate in the drag-range "+ Add" pending pill.
 *  - Layer kinds with a real t1/t2 span: Spans/Loops/Patterns (always).
 *  - Cues: a range drops two point-cues, one at each end (mirrors Manual).
 *  - Boundaries: Manual only — a range drops two boundaries (t1 and t2,
 *    the latter typed as `unset`) so the user gets a labeled section and a
 *    clean end-cap in one gesture. AutoGuess is review-only and never ranges. */
export function supportsRangePending(
  type: AnnotationType,
  source?: BoundarySource,
): boolean {
  if (type === 'spans' || type === 'loops' || type === 'patterns' || type === 'cues' || type === 'lyrics') return true;
  if (type === 'boundaries') return source === 'manual';
  return false;
}

/** True for boundary modes that accept a single click as a t1-only pending
 *  selection. Manual places points at the cursor; AutoGuess does not.
 *  Non-boundary types never click-pend. */
export function supportsClickPending(
  type: AnnotationType,
  source?: BoundarySource,
): boolean {
  if (type !== 'boundaries') return false;
  return source === 'manual';
}

/** True when the type/source pair uses the pending-selection pill at all
 *  (click OR range). Source is only consulted for boundaries. */
export function supportsPending(
  type: AnnotationType,
  source?: BoundarySource,
): boolean {
  return supportsClickPending(type, source) || supportsRangePending(type, source);
}

/** Returns the experimental flag key that gates a type, or `null`. */
export function experimentalKeyFor(type: AnnotationType): ExperimentalFlagKey | null {
  return TAB_CONFIG.find((n) => n.id === type)?.experimental ?? null;
}

/** True when the type itself is gated by an experimental flag. */
export function isExperimentalType(type: AnnotationType): boolean {
  return experimentalKeyFor(type) !== null;
}
