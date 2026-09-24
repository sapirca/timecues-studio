/**
 * Floating edit popover for a single Span — thin adapter over the shared
 * AnnotationPointCard. The actual UI is unified across cues / spans /
 * boundaries / loops; see AnnotationPointCard.
 */

import { type CSSProperties } from 'react';
import type { AnnotationLayer, SpanItem } from '../../types/annotationLayer';
import { useSettings } from '../../context/SettingsContext';
import { AnnotationPointCard, forwardCardPatch } from './shared/AnnotationPointCard';
import { prominenceSection } from './shared/ProminenceControl';
import { pulseSection } from './shared/PulseControl';
import { envelopeSection } from './shared/EnvelopeControl';
import { parseEnergySpanExport } from '../../utils/energySpan';
import { detectorBadgeLabel } from './shared/detectorBadge';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type SpanAnchor = PopoverAnchor;

export function useSpanEditPopover() {
  return useAnnotationPopover({ width: 340, height: 360 });
}

interface SpanEditPopoverProps {
  layer: AnnotationLayer<'spans'>;
  span: SpanItem;
  /** When true, inputs are disabled and the Delete button is hidden.
   *  Used for detector-sourced layers where edits don't make sense. */
  readOnly?: boolean;
  /** Raw detector output for this span — shown as a collapsible JSON block on
   *  read-only cards. */
  rawOutput?: unknown;
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
   *  Drive the bar.beat input + bars/beats length. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Resolved grid segments — keeps the bar.beat readout in step with a
   *  split grid, where each segment counts in its own meter from its own bar 1. */
  segments?: readonly import('../../utils/gridSegments').ResolvedSegment[];
  /** Current playhead — enables the crosshair snap button on each time row. */
  currentTime?: number;
}

export function SpanEditPopover({
  layer, span, readOnly = false, rawOutput, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, segments, currentTime,
}: SpanEditPopoverProps) {
  const { settings } = useSettings();
  const suggestions = settings.spanTaxonomyEnabled ? settings.spanTaxonomy : undefined;
  // A span saved by the ⚡ Energy popover carries its measurement in the
  // description. That span gets the Envelope readout where an authored span
  // gets Prominence — one block, whichever one this span has something to say
  // with. See EnvelopeControl for why they're alternatives and not both.
  const energy = parseEnergySpanExport(span.description);
  return (
    <AnnotationPointCard
      kind="span"
      sections={[
        energy
          ? envelopeSection({ data: energy, start: span.start, end: span.end, color: layer.color })
          : prominenceSection({
            points: span.prominence,
            start: span.start,
            end: span.end,
            currentTime,
            color: layer.color,
            readOnly,
            onChange: (points) => onChange({ prominence: points }),
          }),
        // Pulse sits alongside Prominence on an AUTHORED span — how fast the
        // stretch hits is orthogonal to how far forward it sits — but an
        // ⚡ Energy span never gets it. That span is a measurement of a level
        // over time, made by the tool; a pulse is a claim about rhythm, made
        // by ear. Offering the two on one card invites reading the envelope as
        // if it said something about rate, which it does not.
        ...(energy ? [] : [pulseSection({
          rate: span.pulse,
          color: layer.color,
          bpm,
          beatsPerBar,
          readOnly,
          onChange: (pulse) => onChange({ pulse }),
        })]),
      ]}
      readOnly={readOnly}
      layerName={layer.name}
      layerColor={layer.color}
      badge={readOnly ? detectorBadgeLabel(layer.source) : undefined}
      rawOutput={rawOutput}
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
      segments={segments}
      currentTime={currentTime}
      onChange={forwardCardPatch<SpanItem>(onChange)}
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
