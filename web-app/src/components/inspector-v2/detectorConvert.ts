/**
 * Shared conversion from a custom detector's envelope items into the editable
 * user-layer item shapes. Lives in its own module (not in DetectorOutputReview)
 * so both the review panel and InspectorPageV2's "Copy → Manual" button can
 * import it without tripping the react-refresh "only export components" rule.
 *
 * Boundaries are intentionally excluded here: they live in ManualAnnotation as
 * SectionBlock[], not in the layers document, so the caller converts those
 * separately.
 */
import type {
  CustomBoundaryItem,
  CustomCueItem,
  CustomSpanItem,
  CustomLoopItem,
  CustomLyricsItem,
} from '../../types/customScript';
import { struckHitFields } from '../../utils/drumHits';
import {
  newId,
  type CueItem,
  type SpanItem,
  type LoopItem,
  type LyricsItem,
} from '../../types/annotationLayer';

export type ReviewableCategory = 'cues' | 'spans' | 'loops' | 'lyrics' | 'boundaries';

/** The detector item kinds this module accepts. Deliberately NOT every
 *  `CustomOutputKind`: a `pattern` item becomes riff nodes and instances (see
 *  drumGrooveToRiff.ts), which is a whole layer rather than a list of rows to
 *  accept or reject one at a time, so it has no place in the review flow. */
export type ReviewableItem =
  | CustomBoundaryItem
  | CustomCueItem
  | CustomSpanItem
  | CustomLoopItem
  | CustomLyricsItem;

/** Convert a slice of detector items into the matching user-layer item shape.
 *  Returns null for the 'boundaries' category (no manual-layer equivalent).
 *  All time fields are converted from ms (custom envelope) to seconds (layer
 *  doc). Per-item ids are minted fresh — the layer-doc id space is uuid, and
 *  the detector envelope's index-based keys would collide on a second copy. */
export function convertDetectorItems(
  category: ReviewableCategory,
  items: ReviewableItem[],
): CueItem[] | SpanItem[] | LoopItem[] | LyricsItem[] | null {
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
      start: s.start_ms / 1000,
      end: (s.start_ms + s.duration_ms) / 1000,
      label: s.label ?? '',
    }));
  }
  if (category === 'loops') {
    return (items as CustomLoopItem[]).map<LoopItem>((l) => ({
      id: newId(),
      start: l.start_ms / 1000,
      end: (l.start_ms + l.duration_ms) / 1000,
      label: l.label ?? '',
      snapZeroCross: l.snap_zero_cross ?? undefined,
    }));
  }
  if (category === 'lyrics') {
    return (items as CustomLyricsItem[]).map<LyricsItem>((l) => ({
      id: newId(),
      time: l.time_ms / 1000,
      text: l.text ?? '',
      kind: l.kind,
      ...(l.end_ms != null ? { end: l.end_ms / 1000 } : {}),
    }));
  }
  return null; // boundaries — no manual-layer equivalent
}
