/**
 * Floating edit popover for a single Span — thin adapter over the shared
 * AnnotationPointCard. The actual UI is unified across cues / spans /
 * boundaries / loops / patterns; see AnnotationPointCard.
 */

import { type CSSProperties } from 'react';
import type { AnnotationLayer, SpanItem } from '../../types/annotationLayer';
import type { TempoAnchor } from '../../types/songInfo';
import { useSettings } from '../../context/SettingsContext';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type SpanAnchor = PopoverAnchor;

export function useSpanEditPopover() {
  return useAnnotationPopover({ width: 340, height: 320 });
}

interface SpanEditPopoverProps {
  layer: AnnotationLayer<'spans'>;
  span: SpanItem;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<SpanItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Play this span (seek to start, play through, autopause at end). */
  onPlay?: () => void;
  onStop?: () => void;
  /** True while playback is currently inside this span's [start, end]. */
  isPlaying?: boolean;
  /** Beat-grid context — BPM, gridOffset, time-signature numerator, and
   *  optional tempo anchors. Drive the bar.beat input + bars/beats length. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly TempoAnchor[];
  /** Current playhead — enables the crosshair snap button on each time row. */
  currentTime?: number;
}

export function SpanEditPopover({
  layer, span, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, anchors, currentTime,
}: SpanEditPopoverProps) {
  const { settings } = useSettings();
  const suggestions = settings.spanTaxonomyEnabled ? settings.spanTaxonomy : undefined;
  return (
    <AnnotationPointCard
      kind="span"
      layerName={layer.name}
      layerColor={layer.color}
      start={span.start}
      end={span.end}
      label={span.label}
      labelPlaceholder={suggestions && suggestions.length > 0 ? suggestions.slice(0, 3).join(', ') : 'short label (e.g. violin, pad on)'}
      labelSuggestions={suggestions}
      description={span.description ?? ''}
      importance={span.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      anchors={anchors}
      currentTime={currentTime}
      onChange={(patch) => {
        const out: Partial<SpanItem> = {};
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
