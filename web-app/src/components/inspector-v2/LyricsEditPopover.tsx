/**
 * Floating edit popover for a single Lyrics item — thin adapter over the shared
 * AnnotationPointCard. Opened by clicking a word/line on a Lyrics layer row.
 *
 * Lyrics carry `text` (mapped to the card's Label) and a `time`; line-level
 * items also carry an `end`, so they render as a range while word-level items
 * render as a single point (like a cue). Lyrics have no importance or
 * description fields, so both are hidden. Detector-sourced layers open
 * read-only.
 */

import { type CSSProperties } from 'react';
import type { AnnotationLayer, LyricsItem } from '../../types/annotationLayer';
import type { TempoAnchor } from '../../types/songInfo';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { detectorBadgeLabel } from './shared/detectorBadge';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type LyricsAnchor = PopoverAnchor;

export function useLyricsEditPopover() {
  return useAnnotationPopover({ width: 320, height: 280 });
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
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<LyricsItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Play a 0.5s preview at the lyric's time. */
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
  /** BPM, grid offset, time-signature numerator, and tempo anchors — power the
   *  bar.beat input next to the seconds field. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly TempoAnchor[];
  /** Current playhead — enables the crosshair snap button on the time row. */
  currentTime?: number;
}

export function LyricsEditPopover({
  layer, item, readOnly = false, rawOutput, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, anchors, currentTime,
}: LyricsEditPopoverProps) {
  const isLine = item.kind === 'line';
  return (
    <AnnotationPointCard
      kind="lyrics"
      readOnly={readOnly}
      layerName={layer.name}
      layerColor={layer.color}
      badge={readOnly ? `${item.kind} · ${detectorBadgeLabel(layer.source)}` : item.kind}
      rawOutput={rawOutput}
      start={item.time}
      end={isLine ? item.end : undefined}
      label={item.text}
      labelPlaceholder={isLine ? 'line text' : 'word'}
      description=""
      hideImportance
      hideDescription
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      anchors={anchors}
      currentTime={currentTime}
      onChange={(patch) => {
        const out: Partial<LyricsItem> = {};
        if (patch.label !== undefined) out.text = patch.label;
        if (patch.start !== undefined) out.time = patch.start;
        if (patch.end !== undefined && isLine) out.end = patch.end;
        if (Object.keys(out).length > 0) onChange(out);
      }}
      onDelete={onDelete}
      onPlay={onPlay}
      onStop={onStop}
      isPlaying={isPlaying}
      onClose={onClose}
      popoverRef={popoverRef}
      positionStyle={positionStyle}
    />
  );
}
