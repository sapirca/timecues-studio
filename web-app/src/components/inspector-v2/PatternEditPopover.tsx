/**
 * Floating edit popover for a single Pattern — thin adapter over the shared
 * AnnotationPointCard. The repeats spinner and sub-beat chip grid render in
 * the card's `extras` slot, above the label so they lead the card.
 */

import { type CSSProperties } from 'react';
import type { AnnotationLayer, PatternItem } from '../../types/annotationLayer';
import { PATTERN_SUBBEATS_PER_BEAT, resolvePatternSteps } from '../../types/annotationLayer';
import type { TempoAnchor } from '../../types/songInfo';
import { BeatChipPicker } from './PatternEditorPanel';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { detectorBadgeLabel } from './shared/detectorBadge';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type PatternAnchor = PopoverAnchor;

export function usePatternEditPopover() {
  return useAnnotationPopover({ width: 360, height: 380 });
}

interface PatternEditPopoverProps {
  layer: AnnotationLayer<'patterns'>;
  pattern: PatternItem;
  /** When true, inputs (label, times, repeats, sub-beat chips) are disabled and
   *  the Delete button is hidden. Used for detector-sourced layers. */
  readOnly?: boolean;
  /** Raw detector output for this pattern — shown as a collapsible JSON block
   *  on read-only cards. */
  rawOutput?: unknown;
  /** Song time-signature numerator — sets the sub-beat chip count
   *  (`beatsPerBar × PATTERN_SUBBEATS_PER_BEAT`). Defaults to 4 when no grid
   *  is configured. */
  beatsPerBar: number;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<PatternItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Play the pattern's full repeated region. */
  onPlay?: () => void;
  onStop?: () => void;
  /** True while audio playback is currently inside the repeated region. */
  isPlaying?: boolean;
  /** Beat-grid context — BPM, gridOffset, and optional tempo anchors. The
   *  `beatsPerBar` prop above is the canonical source for both the chip grid
   *  and the bar.beat input. */
  bpm?: number;
  gridOffset?: number;
  anchors?: readonly TempoAnchor[];
  /** Current playhead — enables the crosshair snap button on each time row. */
  currentTime?: number;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function PatternEditPopover({
  layer, pattern, readOnly = false, rawOutput, beatsPerBar, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, anchors, currentTime,
}: PatternEditPopoverProps) {
  const cycle = Math.max(0, pattern.end - pattern.start);
  const reps = Math.max(1, Math.floor(pattern.repeatCount));
  const regionEnd = pattern.start + reps * cycle;
  const steps = resolvePatternSteps(pattern, beatsPerBar);
  const cycleBeats = Math.round(steps / PATTERN_SUBBEATS_PER_BEAT);

  // Karaoke sweep: map the live playhead to a fractional sub-beat position
  // inside the *current* cycle so the chip grid lights up as each step plays.
  // Resets at the top of every cycle (elapsed mod cycle) to track the loop;
  // null whenever playback isn't inside the repeated region.
  const playheadStep =
    isPlaying && currentTime != null && cycle > 0 &&
    currentTime >= pattern.start && currentTime < regionEnd
      ? ((currentTime - pattern.start) % cycle) / cycle * steps
      : null;

  const extras = (
    <>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-300">
          <span>Repeats</span>
          <input
            type="number"
            min={1}
            max={256}
            value={pattern.repeatCount}
            disabled={readOnly}
            onChange={(e) => {
              const n = Math.max(1, Math.min(256, Math.floor(Number(e.target.value) || 1)));
              onChange({ repeatCount: n });
            }}
            className={`w-16 bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[12px] text-slate-100 focus:outline-none focus:ring-1 focus:ring-fuchsia-400/40 ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
          />
        </label>
        <span className="text-[10px] font-mono text-slate-400" title="Region end (cycle × repeats)">
          → ends {fmtTime(regionEnd)} ({(reps * cycle).toFixed(2)}s)
        </span>
      </div>

      <div>
        <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">
          Sub-beats <span className="normal-case text-slate-400">({steps}/cycle = {cycleBeats} × {PATTERN_SUBBEATS_PER_BEAT} — click to toggle)</span>
        </span>
        <BeatChipPicker
          color={layer.color}
          steps={steps}
          highlighted={pattern.highlightedBeats}
          onChange={(next) => onChange({ highlightedBeats: next })}
          readOnly={readOnly}
          playheadStep={playheadStep}
        />
      </div>
    </>
  );

  return (
    <AnnotationPointCard
      kind="pattern"
      readOnly={readOnly}
      layerName={layer.name}
      badge={readOnly ? detectorBadgeLabel(layer.source) : undefined}
      rawOutput={rawOutput}
      layerColor={layer.color}
      start={pattern.start}
      end={pattern.end}
      label={pattern.label}
      labelPlaceholder="short label (e.g. kick pattern A)"
      description={pattern.description ?? ''}
      importance={pattern.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      anchors={anchors}
      currentTime={currentTime}
      width={360}
      onChange={(patch) => {
        const out: Partial<PatternItem> = {};
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
      extras={extras}
    />
  );
}
