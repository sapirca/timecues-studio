/**
 * Floating edit popover for a single boundary (ManualSection) — thin adapter
 * over the shared AnnotationPointCard. The section-type dropdown lives in the
 * card's `extras` slot (rendered above Label so Type leads the card).
 * Boundaries are single-point markers, so the End ms field is non-editable:
 * it shows the next boundary's time (or the song duration when this is the
 * last one) as a context-only read-out.
 */

import { type CSSProperties } from 'react';
import type { ManualSection } from '../../types/manualAnnotation';
import type { TempoAnchor } from '../../types/songInfo';
import { useSettings } from '../../context/SettingsContext';
import { sectionColor, getSectionTypes, sectionLabel } from './sectionConstants';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type BoundaryAnchor = PopoverAnchor;

export function useBoundaryEditPopover() {
  return useAnnotationPopover({ width: 340, height: 360 });
}

interface BoundaryEditPopoverProps {
  /** 0-based index — used for header numbering ("Boundary #3"). */
  index: number;
  section: ManualSection;
  /** Time of the next boundary, or the track duration if this is the last
   *  one. Displayed as a non-editable End ms read-out. */
  endTime: number;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  /** Patch fields. `time` maps to the section's start; `type` is boundary-only. */
  onChange: (patch: Partial<ManualSection>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Play a 0.5s preview starting at section.time. */
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
  /** Beat-grid context — BPM, gridOffset, time-signature numerator, and
   *  optional tempo anchors. Drive the bar.beat input + length read-out. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly TempoAnchor[];
  /** Current playhead — enables the crosshair snap button on the Start row. */
  currentTime?: number;
  /** When provided, a "Split" button is rendered on the footer next to Delete.
   *  Only enabled when the playhead sits strictly inside this boundary's
   *  segment (Manual section editor). */
  onSplit?: () => void;
  canSplit?: boolean;
}

export function BoundaryEditPopover({
  index, section, endTime, popoverRef, positionStyle,
  onChange, onDelete, onClose,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, anchors, currentTime,
  onSplit, canSplit,
}: BoundaryEditPopoverProps) {
  const { settings } = useSettings();
  const sectionTypes = getSectionTypes(settings.sectionTypeVocabulary);
  const color = sectionColor(section.type);

  const splitButton = onSplit ? (
    <button
      type="button"
      onClick={() => { if (canSplit) { onSplit(); onClose(); } }}
      disabled={!canSplit}
      title={canSplit ? 'Split at the current playhead' : 'Move playhead inside this section to split'}
      className={`px-2 py-1 rounded text-[10px] uppercase tracking-wider border transition-colors ${
        canSplit
          ? 'border-transparent text-sky-300 hover:text-sky-200 hover:bg-sky-500/10'
          : 'border-transparent text-slate-600 cursor-not-allowed'
      }`}
    >
      Split
    </button>
  ) : null;

  const extras = (
    <div className="flex items-center gap-2">
      <label className="text-[9px] uppercase tracking-wider text-slate-300 w-10 shrink-0">Type</label>
      <select
        value={section.type}
        onChange={(e) => {
          const nextType = e.target.value;
          // Mirror the existing rename-on-type-change behaviour used by
          // updateSection: when the type changes, refresh the auto-generated
          // label so "drop 1" doesn't linger on a section retyped to "buildup".
          onChange({ type: nextType, label: sectionLabel(nextType) });
        }}
        className="flex-1 min-w-0 bg-[#0a0b0d] border border-white/[0.08] text-[11px] font-mono uppercase tracking-wider rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400/40 cursor-pointer"
        style={{ color }}
      >
        {sectionTypes.map((t) => (
          <option key={t} value={t} className="bg-[#14171d] text-slate-200 normal-case tracking-normal">{t}</option>
        ))}
      </select>
    </div>
  );

  return (
    <AnnotationPointCard
      kind="boundary"
      layerName={`Boundary #${index + 1}`}
      layerColor={color}
      start={section.time}
      end={endTime}
      endEditable={false}
      label={section.label}
      labelPlaceholder="label"
      description={section.description ?? ''}
      importance={section.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      anchors={anchors}
      currentTime={currentTime}
      onChange={(patch) => {
        const out: Partial<ManualSection> = {};
        if (patch.start !== undefined) out.time = patch.start;
        if (patch.label !== undefined) out.label = patch.label;
        if (patch.description !== undefined) out.description = patch.description;
        if (patch.importance !== undefined) out.importance = patch.importance;
        // End is non-editable for boundaries (segment end = next boundary's time).
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
      footerLeftExtras={splitButton}
    />
  );
}
