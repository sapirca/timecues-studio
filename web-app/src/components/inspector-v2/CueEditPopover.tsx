/**
 * Floating edit popover for a single Cue.
 *
 * Opened by clicking a tick mark on a Cue layer row. Anchored near the click,
 * closes on outside-click or Escape. This file is a thin adapter — the actual
 * UI lives in the shared AnnotationPointCard, which is reused by every
 * annotation kind (cues, spans, boundaries, loops, patterns) and by the
 * read-only detector-output review.
 */

import { type CSSProperties } from 'react';
import type { AnnotationLayer, CueItem } from '../../types/annotationLayer';
import type { TempoAnchor } from '../../types/songInfo';
import { useSettings } from '../../context/SettingsContext';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type CueAnchor = PopoverAnchor;

export function useCueEditPopover() {
  return useAnnotationPopover({ width: 320, height: 320 });
}

interface CueEditPopoverProps {
  layer: AnnotationLayer<'cues'>;
  cue: CueItem;
  /** When true, inputs are disabled and the Delete button is hidden.
   *  Used for detector-sourced layers where edits don't make sense. */
  readOnly?: boolean;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<CueItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Play a 0.5s preview starting at cue.time. */
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

export function CueEditPopover({
  layer, cue, readOnly = false, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, anchors, currentTime,
}: CueEditPopoverProps) {
  const { settings } = useSettings();
  const suggestions = settings.cueTaxonomyEnabled ? settings.cueTaxonomy : undefined;
  return (
    <AnnotationPointCard
      kind="cue"
      layerName={layer.name}
      layerColor={layer.color}
      badge={readOnly ? 'detector' : undefined}
      start={cue.time}
      label={cue.label}
      labelPlaceholder={suggestions && suggestions.length > 0 ? suggestions.slice(0, 3).join(', ') : 'short label'}
      labelSuggestions={suggestions}
      description={cue.description ?? ''}
      importance={cue.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      anchors={anchors}
      currentTime={currentTime}
      readOnly={readOnly}
      width={320}
      onChange={(patch) => {
        const out: Partial<CueItem> = {};
        if (patch.start !== undefined) out.time = patch.start;
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
