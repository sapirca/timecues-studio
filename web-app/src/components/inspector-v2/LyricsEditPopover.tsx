/**
 * Floating edit popover for a single Lyrics item — thin adapter over the shared
 * AnnotationPointCard. Opened by clicking a word/line on a Lyrics layer row.
 *
 * Lyrics carry `text` (mapped to the card's Label), a `time` and an `end`:
 * every lyric is a span, word or line, so the card always shows both ends. Lyrics have no importance
 * field, so it is hidden; the description is a free-form note like any other
 * item's. Detector-sourced layers open read-only.
 */

import { type CSSProperties } from 'react';
import { LYRIC_DEFAULT_SEC, type AnnotationLayer, type LyricsItem } from '../../types/annotationLayer';
import { AnnotationPointCard, type CardLaneMove } from './shared/AnnotationPointCard';
import { detectorBadgeLabel } from './shared/detectorBadge';
import { adsrSection, type AdsrSectionProps } from './shared/adsrSection';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type LyricsAnchor = PopoverAnchor;

export function useLyricsEditPopover() {
  return useAnnotationPopover({ width: 320, height: 320 });
}

interface LyricsEditPopoverProps {
  layer: AnnotationLayer<'lyrics'>;
  item: LyricsItem;
  /** When true, inputs are disabled and the Delete button is hidden.
   *  Used for detector-sourced layers where edits don't make sense. */
  readOnly?: boolean;
  /** Raw detector output for this lyric — shown as a collapsible JSON block on
   *  read-only cards. */
  rawOutput?: unknown;
  /** Other lanes of this type to move the item to, from the header. */
  laneMove?: CardLaneMove;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<LyricsItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Done on a draft item — see AnnotationPointCard's `onDone`. */
  onDone?: () => void;
  /** Play a 0.5s preview at the lyric's time. */
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
  /** BPM, grid offset and time-signature numerator — power the
   *  bar.beat input next to the seconds field. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Resolved grid segments — keeps the bar.beat readout in step with a
   *  split grid, where each segment counts in its own meter from its own bar 1. */
  segments?: readonly import('../../utils/gridSegments').ResolvedSegment[];
  /** Extract ADSR for this lyric — see adsrSection. */
  adsr?: Omit<AdsrSectionProps, 'envelope'>;
}

export function LyricsEditPopover({
  layer, item, readOnly = false, rawOutput, laneMove, popoverRef, positionStyle,
  onChange, onDelete, onClose, onDone,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, segments, adsr,
}: LyricsEditPopoverProps) {
  const isLine = item.kind === 'line';
  // Layers are repaired on load (withLyricSpans), so `end` is always there;
  // the fallback only guards an item that skipped that path.
  const end = item.end ?? item.time + LYRIC_DEFAULT_SEC;
  return (
    <AnnotationPointCard
      kind="lyrics"
      sections={adsr || item.envelope
        ? [adsrSection({ envelope: item.envelope, sources: [], extracting: false, ...adsr })]
        : []}
      readOnly={readOnly}
      layerName={layer.name}
      laneMove={laneMove}
      layerColor={layer.color}
      badge={readOnly ? `${item.kind} · ${detectorBadgeLabel(layer.source)}` : item.kind}
      rawOutput={rawOutput}
      start={item.time}
      end={end}
      label={item.text}
      labelPlaceholder={isLine ? 'line text' : 'word'}
      description={item.description ?? ''}
      hideImportance
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      segments={segments}
      onChange={(patch) => {
        const out: Partial<LyricsItem> = {};
        if (patch.label !== undefined) out.text = patch.label;
        if (patch.description !== undefined) out.description = patch.description;
        if (patch.start !== undefined) out.time = patch.start;
        if (patch.end !== undefined) out.end = patch.end;
        if (Object.keys(out).length > 0) onChange(out);
      }}
      onDelete={onDelete}
      onPlay={onPlay}
      onStop={onStop}
      isPlaying={isPlaying}
      onClose={onClose}
      onDone={onDone}
      popoverRef={popoverRef}
      positionStyle={positionStyle}
    />
  );
}
