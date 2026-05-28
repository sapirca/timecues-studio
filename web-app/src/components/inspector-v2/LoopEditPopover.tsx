/**
 * Floating edit popover for a single Loop — thin adapter over the shared
 * AnnotationPointCard. Play button uses the loop icon (↻) and triggers
 * seamless looping playback in the parent.
 */

import { type CSSProperties } from 'react';
import type { AnnotationLayer, LoopItem } from '../../types/annotationLayer';
import type { TempoAnchor } from '../../types/songInfo';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type LoopAnchor = PopoverAnchor;

export function useLoopEditPopover() {
  return useAnnotationPopover({ width: 340, height: 320 });
}

interface LoopEditPopoverProps {
  layer: AnnotationLayer<'loops'>;
  loop: LoopItem;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<LoopItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Start seamless looping playback of [loop.start, loop.end]. */
  onPlay?: () => void;
  onStop?: () => void;
  /** True while this loop is the currently looping item. */
  isPlaying?: boolean;
  /** Beat-grid context — BPM, gridOffset, time-signature numerator, and
   *  optional tempo anchors. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly TempoAnchor[];
  /** Current playhead — enables the crosshair snap button on each time row. */
  currentTime?: number;
}

export function LoopEditPopover({
  layer, loop, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, anchors, currentTime,
}: LoopEditPopoverProps) {
  return (
    <AnnotationPointCard
      kind="loop"
      layerName={layer.name}
      layerColor={layer.color}
      start={loop.start}
      end={loop.end}
      label={loop.label}
      labelPlaceholder="short label (e.g. drop, breakdown)"
      description={loop.description ?? ''}
      importance={loop.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      anchors={anchors}
      currentTime={currentTime}
      onChange={(patch) => {
        const out: Partial<LoopItem> = {};
        if (patch.start !== undefined) out.start = patch.start;
        if (patch.end !== undefined) out.end = patch.end;
        if (patch.label !== undefined) out.label = patch.label;
        if (patch.description !== undefined) out.description = patch.description;
        if (patch.importance !== undefined) out.importance = patch.importance;
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
