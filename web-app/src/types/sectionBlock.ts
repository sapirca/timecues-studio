/**
 * One tile of a section tiling — the shape every "contiguous labeled blocks
 * across the track" surface speaks.
 *
 * Two very different things produce it:
 *   • a stored boundary layer, whose `BoundaryItem`s are structurally
 *     assignable to this (they are a SectionBlock plus a stable `id`), and
 *   • derived tilings with no persistent identity at all — MSAF / ruptures /
 *     allin1 algorithm outputs, custom-detector envelopes, and the auto-guess
 *     review strip.
 *
 * Keeping the derived shape id-less is the point: nothing downstream can
 * mistake an algorithm's momentary opinion for an annotation the curator owns
 * and can edit. Renderers and evaluation take `SectionBlock[]`; only the
 * editors take `BoundaryItem[]`.
 *
 * Ends are implicit — block `i` runs until block `i+1`'s `time`. See
 * `sectionEnd` in components/inspector-v2/sectionConstants.ts.
 */

import type { ItemImportance } from './annotationLayer';

export interface SectionBlock {
  /** Section start, in seconds. */
  time: number;
  /** Musical position: fractional beats from the grid origin. Seconds stay
   *  canonical; see utils/beatAnchoring.ts. */
  beat?: number;
  /** Section vocabulary key — intro | buildup | drop | … | unset. */
  type: string;
  /** Display name. Falls back to the type's label when empty. */
  label: string;
  /** Longer free-form note shown in the boundary edit popover. */
  description?: string;
  /** 'critical' = must detect; 'optional' = nice to have. */
  importance?: ItemImportance;
  /** Alternative valid start times. During evaluation, any candidate within
   *  tolerance counts as a hit. */
  candidates?: number[];
}
