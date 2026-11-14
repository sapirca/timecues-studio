/**
 * Floating edit popover for a single Loop — thin adapter over the shared
 * AnnotationPointCard. Play button uses the loop-play icon and triggers
 * seamless looping playback in the parent.
 */

import { colorSection } from './shared/colorSection';
import { type CSSProperties } from 'react';
import type { AnnotationLayer, LoopItem } from '../../types/annotationLayer';
import { AnnotationPointCard, forwardCardPatch, type CardLaneMove } from './shared/AnnotationPointCard';
import { prominenceSection } from './shared/ProminenceControl';
import { detectorBadgeLabel } from './shared/detectorBadge';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type LoopAnchor = PopoverAnchor;

export function useLoopEditPopover() {
  return useAnnotationPopover({ width: 340, height: 360 });
}

interface LoopEditPopoverProps {
  layer: AnnotationLayer<'loops'>;
  loop: LoopItem;
  /** When true, inputs are disabled and the Delete button is hidden.
   *  Used for detector-sourced layers where edits don't make sense. */
  readOnly?: boolean;
  /** Raw detector output for this loop — shown as a collapsible JSON block on
   *  read-only cards. */
  rawOutput?: unknown;
  /** Other lanes of this type to move the item to, from the header. */
  laneMove?: CardLaneMove;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<LoopItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Done on a draft item — see AnnotationPointCard's `onDone`. */
  onDone?: () => void;
  /** Start seamless looping playback of [loop.start, loop.end]. */
  onPlay?: () => void;
  onStop?: () => void;
  /** True while this loop is the currently looping item. */
  isPlaying?: boolean;
  /** Beat-grid context — BPM, gridOffset, time-signature numerator, and
   */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Resolved grid segments — keeps the bar.beat readout in step with a
   *  split grid, where each segment counts in its own meter from its own bar 1. */
  segments?: readonly import('../../utils/gridSegments').ResolvedSegment[];
}

export function LoopEditPopover({
  layer, loop, readOnly = false, rawOutput, laneMove, popoverRef, positionStyle,
  onChange, onDelete, onClose, onDone,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, segments,
}: LoopEditPopoverProps) {
  return (
    <AnnotationPointCard
      kind="loop"
      readOnly={readOnly}
      sections={[prominenceSection({
        points: loop.prominence,
        start: loop.start,
        end: loop.end,
        color: layer.color,
        readOnly,
        onChange: (points) => onChange({ prominence: points }),
      }), colorSection({ color: loop.color, fallbackColor: layer.color, readOnly, onChange: (color) => onChange({ color }) })]}
      layerName={layer.name}
      laneMove={laneMove}
      layerColor={layer.color}
      badge={readOnly ? detectorBadgeLabel(layer.source) : undefined}
      rawOutput={rawOutput}
      start={loop.start}
      end={loop.end}
      label={loop.label}
      labelPlaceholder="short label (e.g. drop, breakdown)"
      description={loop.description ?? ''}
      importance={loop.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      segments={segments}
      onChange={forwardCardPatch<LoopItem>(onChange)}
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
