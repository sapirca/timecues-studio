/**
 * Floating edit popover for a single Cue.
 *
 * Opened by clicking a tick mark on a Cue layer row. Anchored near the click,
 * closes on outside-click or Escape. This file is a thin adapter — the actual
 * UI lives in the shared AnnotationPointCard, which is reused by every
 * annotation kind (cues, spans, boundaries, loops) and by the
 * read-only detector-output review.
 */

import { useState, type CSSProperties } from 'react';
import type { AnnotationLayer, CueItem } from '../../types/annotationLayer';
import { useSettings } from '../../context/SettingsContext';
import { AnnotationPointCard, type CardLaneMove } from './shared/AnnotationPointCard';
import { detectorBadgeLabel } from './shared/detectorBadge';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';
import type { CardSectionSpec } from './shared/CardSection';
import { ItemColorControl } from './shared/ItemColorControl';
import { midiNoteName } from '../../utils/drumHits';

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
  /** Raw detector output for this cue — shown as a collapsible JSON block on
   *  read-only cards. */
  rawOutput?: unknown;
  /** Other lanes of this type to move the item to, from the header. */
  laneMove?: CardLaneMove;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<CueItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Done on a draft item — see AnnotationPointCard's `onDone`. */
  onDone?: () => void;
  /** Play a 0.5s preview starting at cue.time. */
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
}

export function CueEditPopover({
  layer, cue, readOnly = false, rawOutput, laneMove, popoverRef, positionStyle,
  onChange, onDelete, onClose, onDone,
  onPlay, onStop, isPlaying,
  bpm, gridOffset, beatsPerBar, segments,
}: CueEditPopoverProps) {
  const { settings } = useSettings();
  const suggestions = settings.cueTaxonomyEnabled ? settings.cueTaxonomy : undefined;
  return (
    <AnnotationPointCard
      kind="cue"
      layerName={layer.name}
      laneMove={laneMove}
      layerColor={layer.color}
      badge={readOnly ? detectorBadgeLabel(layer.source) : undefined}
      rawOutput={rawOutput}
      start={cue.time}
      label={cue.label}
      labelPlaceholder={suggestions && suggestions.length > 0 ? suggestions.slice(0, 3).join(', ') : 'short label'}
      labelSuggestions={suggestions}
      description={cue.description ?? ''}
      importance={cue.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      segments={segments}
      readOnly={readOnly}
      width={320}
      sections={[hitSection(cue, layer.color, readOnly, onChange)]}
      onChange={(patch) => {
        // Cues store their position as `time`, so this one still maps by hand.
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
      onDone={onDone}
      popoverRef={popoverRef}
      positionStyle={positionStyle}
    />
  );
}

/** The struck-hit fields — decay, velocity, level, note, colour — as one
 *  foldable section. All optional.
 *  Every cue carries them the same way, whoever set them: a detector fills
 *  them in, a copy keeps them, and here you can set or change them by hand.
 *  Empty means "not set", and the lane draws the cue exactly as before. */
function hitSection(
  cue: CueItem,
  laneColor: string,
  readOnly: boolean,
  onChange: (patch: Partial<CueItem>) => void,
): CardSectionSpec {
  // Decay leads: it is the one field the lane also lets you drag, so the
  // folded summary is where a dragged value is read back in numbers.
  const set = [
    cue.decay !== undefined && `rings ${Math.round(cue.decay * 1000)} ms`,
    cue.velocity !== undefined && `velocity ${cue.velocity}`,
    cue.levelDb !== undefined && `${cue.levelDb.toFixed(1)} dB`,
    cue.color !== undefined && 'own colour',
    cue.note !== undefined && midiNoteName(cue.note),
  ].filter(Boolean);
  return {
    id: 'cue-hit',
    title: 'Hit',
    defaultOpen: false,
    summary: set.length > 0 ? set.join(' · ') : 'not set',
    content: (
      <div className="flex flex-col gap-1.5">
        <NumberField
          key={`d:${cue.id}:${cue.decay ?? ''}`}
          label="Decay ms"
          hint="How long the hit rings before it fades. The lane draws it as a faint tail after the tick — drag the nub at the tail's end (or just right of a tick with none) to set it there."
          value={cue.decay !== undefined ? Math.round(cue.decay * 1000) : undefined}
          min={1} step={10} integer
          placeholder="—"
          readOnly={readOnly}
          onCommit={(v) => onChange({ decay: v === undefined ? undefined : v / 1000 })}
        />
        <NumberField
          key={`v:${cue.id}:${cue.velocity ?? ''}`}
          label="Velocity"
          hint="1-127 · how hard it was struck, against the same instrument's hardest hit. The tick stands this tall."
          value={cue.velocity}
          min={1} max={127} step={1} integer
          placeholder="—"
          readOnly={readOnly}
          onCommit={(v) => onChange({ velocity: v })}
        />
        <NumberField
          key={`l:${cue.id}:${cue.levelDb ?? ''}`}
          label="Level dB"
          hint="0 or below · this hit's level against the loudest hit in the track."
          value={cue.levelDb}
          max={0} step={0.1}
          placeholder="—"
          readOnly={readOnly}
          onCommit={(v) => onChange({ levelDb: v })}
        />
        <NumberField
          key={`n:${cue.id}:${cue.note ?? ''}`}
          label="Note"
          hint="0-127 · MIDI note number of the hit's pitch (60 = middle C, C4)."
          value={cue.note}
          min={0} max={127} step={1} integer
          placeholder="—"
          readOnly={readOnly}
          onCommit={(v) => onChange({ note: v })}
          after={cue.note !== undefined ? midiNoteName(cue.note) : undefined}
        />
        <ItemColorControl
          color={cue.color}
          fallbackColor={laneColor}
          readOnly={readOnly}
          onChange={(color) => onChange({ color })}
        />
      </div>
    ),
  };
}

/** A number input that keeps what you type while you type it and commits on
 *  blur / Enter: a value outside the bounds is refused (the field snaps back),
 *  and an empty field commits `undefined` — "not set". The caller keys it on
 *  the stored value, so an outside change (undo, another cue) re-seeds it. */
function NumberField({
  label, hint, value, min, max, step, integer = false, placeholder, readOnly, onCommit, after,
}: {
  label: string;
  hint: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step: number;
  integer?: boolean;
  placeholder: string;
  readOnly: boolean;
  onCommit: (v: number | undefined) => void;
  /** Read-out shown after the input (e.g. the note name). */
  after?: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const commit = () => {
    const t = text.trim();
    if (t === '') { if (value !== undefined) onCommit(undefined); return; }
    const n = Number(t);
    const ok = Number.isFinite(n) && (!integer || Number.isInteger(n))
      && (min === undefined || n >= min) && (max === undefined || n <= max);
    if (ok && n !== value) onCommit(n);
    else if (!ok) setText(value === undefined ? '' : String(value));
  };
  return (
    <label className="flex items-center gap-2 text-[11px] text-slate-300" title={hint}>
      <span className="w-16 shrink-0">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min} max={max} step={step}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className={`w-20 bg-[#0a0b0d] border border-white/[0.06] rounded px-1.5 py-0.5 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/40 ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
      />
      {after && <span className="text-[10px] text-slate-400">{after}</span>}
    </label>
  );
}
