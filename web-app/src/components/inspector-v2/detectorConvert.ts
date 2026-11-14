/**
 * Shared conversion from a custom detector's envelope items into the editable
 * user-layer item shapes. Lives in its own module (not in DetectorOutputReview)
 * so both the review panel and InspectorPageV2's "Copy → Manual" button can
 * import it without tripping the react-refresh "only export components" rule.
 *
 * Boundaries were once excluded here, because they lived in ManualAnnotation as
 * SectionBlock[] rather than in the layers document. Since the refactor they
 * are an ordinary layer type with their own item shape, so they convert like
 * every other category.
 */
import type {
  CustomOutputKind,
  CustomRegistryEntry,
  CustomResultEnvelope,
  CustomBoundaryItem,
  CustomCueItem,
  CustomSpanItem,
  CustomLoopItem,
  CustomLyricsItem,
  CustomLyricsEnvelope,
} from '../../types/customScript';
import { struckHitFields } from '../../utils/drumHits';
import {
  newId,
  PULSE_OPTIONS,
  type BoundaryItem,
  type CueItem,
  type SpanItem,
  type LoopItem,
  type LyricsItem,
  type SoundEnvelope,
} from '../../types/annotationLayer';

/** A detector span as the layer doc holds it, minus the id — the one mapping
 *  shared by the read-only detector lane and Copy → Manual, so a field a
 *  detector sets reaches both or neither. An ⚡ Energy blob in `description`
 *  is what makes the lane draw the envelope; `pulse` selects the Pulse chip
 *  and draws the ticks. A value outside the vocabulary is dropped rather than
 *  passed through, since the picker has no chip to show it on. */
export function detectorSpanFields(s: CustomSpanItem): Omit<SpanItem, 'id'> {
  return {
    start: s.start_ms / 1000,
    end: (s.start_ms + s.duration_ms) / 1000,
    label: s.label ?? '',
    ...(s.color ? { color: s.color } : {}),
    ...(s.description ? { description: s.description } : {}),
    ...(s.pulse && (PULSE_OPTIONS as readonly string[]).includes(s.pulse)
      ? { pulse: s.pulse } : {}),
  };
}

import { normalizeSectionType } from './sectionConstants';

/** A detector word's onsets and envelope in the editor's shape (seconds, text
 *  only where a syllable was laid) — the one mapping, for the review lane and
 *  the copy. */
export function detectorLyricsOnsets(l: CustomLyricsItem): Pick<LyricsItem, 'onsets' | 'envelope'> {
  return {
    ...(l.onsets?.length
      ? { onsets: l.onsets.map((o) => ({ time: o.time_ms / 1000, ...(o.text ? { text: o.text } : {}) })) }
      : {}),
    ...(l.envelope ? { envelope: detectorEnvelope(l.envelope) } : {}),
  };
}

/** A detector envelope (ms) in the editor's shape (seconds). */
export function detectorEnvelope(e: CustomLyricsEnvelope): SoundEnvelope {
  return {
    start: e.start_ms / 1000, peak: e.peak_ms / 1000, decayEnd: e.decay_end_ms / 1000,
    release: e.release_ms / 1000, end: e.end_ms / 1000, peakDb: e.peak_db,
    ...(e.sustain_db != null ? { sustainDb: e.sustain_db } : {}),
  };
}

export type ReviewableCategory ='cues' | 'spans' | 'loops' | 'lyrics' | 'boundaries';

/** The detector item kinds this module accepts. Deliberately NOT every
 *  `CustomOutputKind`: a `pattern` item becomes riff nodes and instances (see
 *  patternToRiff.ts) or a groove lane's bars (drumGrooves.ts) — a whole lane
 *  rather than a list of rows to accept or reject one at a time, so it has no
 *  place in the review flow. */
export type ReviewableItem =
  | CustomBoundaryItem
  | CustomCueItem
  | CustomSpanItem
  | CustomLoopItem
  | CustomLyricsItem;

/** Convert a slice of detector items into the matching user-layer item shape.
 *  All time fields are converted from ms (custom envelope) to seconds (layer
 *  doc). Per-item ids are minted fresh — the layer-doc id space is uuid, and
 *  the detector envelope's index-based keys would collide on a second copy.
 *
 *  A boundary's `type` is read from its label through `normalizeSectionType`,
 *  the same path an import takes: a detector naming a section in the active
 *  vocabulary gets that type, and anything else lands on `unset` while keeping
 *  the written label, rather than asserting a specific type it never claimed. */
export function convertDetectorItems(
  category: ReviewableCategory,
  items: ReviewableItem[],
): BoundaryItem[] | CueItem[] | SpanItem[] | LoopItem[] | LyricsItem[] | null {
  if (category === 'cues') {
    return (items as CustomCueItem[]).map<CueItem>((c) => ({
      id: newId(),
      time: c.time_ms / 1000,
      label: c.label ?? '',
      description: c.description ?? undefined,
      candidates: c.candidates && c.candidates.length > 0
        ? c.candidates.map((ms) => ms / 1000)
        : undefined,
      ...struckHitFields(c),
    }));
  }
  if (category === 'spans') {
    return (items as CustomSpanItem[]).map<SpanItem>((s) => ({
      id: newId(),
      ...detectorSpanFields(s),
    }));
  }
  if (category === 'loops') {
    return (items as CustomLoopItem[]).map<LoopItem>((l) => ({
      id: newId(),
      start: l.start_ms / 1000,
      end: (l.start_ms + l.duration_ms) / 1000,
      label: l.label ?? '',
      snapZeroCross: l.snap_zero_cross ?? undefined,
      ...(l.color ? { color: l.color } : {}),
    }));
  }
  if (category === 'lyrics') {
    return (items as CustomLyricsItem[]).map<LyricsItem>((l) => ({
      id: newId(),
      time: l.time_ms / 1000,
      text: l.text ?? '',
      kind: l.kind,
      ...(l.end_ms != null ? { end: l.end_ms / 1000 } : {}),
      ...detectorLyricsOnsets(l),
    }));
  }
  if (category === 'boundaries') {
    return (items as CustomBoundaryItem[]).map<BoundaryItem>((b) => ({
      id: newId(),
      time: b.time_ms / 1000,
      type: normalizeSectionType(b.label ?? undefined),
      label: b.label ?? '',
      importance: b.importance ?? undefined,
      candidates: b.candidates && b.candidates.length > 0
        ? b.candidates.map((ms) => ms / 1000)
        : undefined,
      ...(b.color ? { color: b.color } : {}),
    }));
  }
  return null;
}


/** The layer a detector's output is copied into, by output kind. A pattern has
 *  none: a groove lane is read-only, and nothing copies into a riff layer. */
export const DETECTOR_COPY_CATEGORY: Partial<Record<CustomOutputKind, ReviewableCategory>> = {
  boundary: 'boundaries', cue: 'cues', span: 'spans', loop: 'loops', lyrics: 'lyrics',
};

/** What a finished run of `det` should do to the annotator's layers under
 *  `is_annotation`: nothing (`null`), or copy into a new layer of `category`
 *  named `label` — unless `held`, when they already hold a copy, which a
 *  re-run never touches (they may have edited it). `importedFrom` is the name
 *  every copy of a detector carries, by hand (`label`, `label (✓ accepted)`)
 *  or automatic. */
export function planDetectorAutoCopy(
  det: Pick<CustomRegistryEntry, 'name' | 'label' | 'output_kind' | 'is_annotation'> | undefined,
  env: { fatal: CustomResultEnvelope['fatal']; items: readonly unknown[] },
  layers: readonly { importedFrom?: string }[],
): { category: ReviewableCategory; label: string; held: boolean } | null {
  if (!det?.is_annotation || env.fatal || env.items.length === 0) return null;
  const category = DETECTOR_COPY_CATEGORY[det.output_kind];
  if (!category) return null;
  const label = det.label || det.name;
  const held = layers.some((l) => l.importedFrom === label || l.importedFrom === `${label} (✓ accepted)`);
  return { category, label, held };
}
