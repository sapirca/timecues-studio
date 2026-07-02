/**
 * Unified annotation point card.
 *
 * One component renders the floating edit popover for every annotation kind
 * (cues, spans, boundaries, loops, patterns) and is also reused by the
 * custom-detector review panel in read-only mode. Replaces the four
 * near-identical popovers that previously lived in
 * Cue/Span/Loop/Pattern EditPopover.tsx and the inline popover in
 * EyeEditorPanel.tsx.
 *
 * Kind-specific bits (semantic accent colour, play-icon, end-time presence,
 * extra inputs like pattern repeats / sub-beat chips) are parameterised; the
 * shell layout (header → extras → label → time editor → length read-out →
 * description → footer) is identical across all kinds.
 */

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ItemImportance } from '../../../types/annotationLayer';
import type { TempoAnchor } from '../../../types/songInfo';
import { beatDuration } from '../../../utils/beatGrid';
import { BarBeatInput } from '../BarBeatInput';
import { CrosshairIcon } from '../CrosshairIcon';
import { ImportanceStar } from './ImportanceStar';

export type AnnotationCardKind = 'cue' | 'span' | 'boundary' | 'loop' | 'pattern' | 'lyrics';

interface KindTheme {
  /** Tailwind class for input focus ring. */
  focusRing: string;
  /** Tailwind classes for the Play button (idle state). */
  playIdle: string;
  /** Tailwind classes for the Done button. */
  done: string;
  /** ▶ for one-shot, ↻ for seamless loop. */
  playIcon: string;
  /** Tooltip on the play button. */
  playTitle: string;
}

// Full class names (no string concat) so Tailwind's JIT picks them up.
const KIND_THEME: Record<AnnotationCardKind, KindTheme> = {
  cue: {
    focusRing: 'focus:ring-cyan-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-cyan-300 hover:text-cyan-200 hover:border-cyan-400/40',
    done: 'bg-cyan-500/20 border-cyan-400/40 text-cyan-200 hover:bg-cyan-500/30',
    playIcon: '▶',
    playTitle: 'Play a 0.5s preview at this cue',
  },
  span: {
    focusRing: 'focus:ring-emerald-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-emerald-300 hover:text-emerald-200 hover:border-emerald-400/40',
    done: 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/30',
    playIcon: '▶',
    playTitle: 'Play this span (seek to start, autopause at end)',
  },
  boundary: {
    focusRing: 'focus:ring-violet-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-violet-300 hover:text-violet-200 hover:border-violet-400/40',
    done: 'bg-violet-500/20 border-violet-400/40 text-violet-200 hover:bg-violet-500/30',
    playIcon: '▶',
    playTitle: 'Play a 0.5s preview at this boundary',
  },
  loop: {
    focusRing: 'focus:ring-fuchsia-400/40',
    playIdle: 'bg-fuchsia-500/15 border-fuchsia-400/30 text-fuchsia-200 hover:bg-fuchsia-500/25',
    done: 'bg-fuchsia-500/20 border-fuchsia-400/40 text-fuchsia-200 hover:bg-fuchsia-500/30',
    playIcon: '↻',
    playTitle: 'Loop-play this interval seamlessly',
  },
  pattern: {
    focusRing: 'focus:ring-fuchsia-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-fuchsia-300 hover:text-fuchsia-200 hover:border-fuchsia-400/40',
    done: 'bg-fuchsia-500/20 border-fuchsia-400/40 text-fuchsia-200 hover:bg-fuchsia-500/30',
    playIcon: '▶',
    playTitle: 'Play repeated region',
  },
  lyrics: {
    focusRing: 'focus:ring-sky-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-sky-300 hover:text-sky-200 hover:border-sky-400/40',
    done: 'bg-sky-500/20 border-sky-400/40 text-sky-200 hover:bg-sky-500/30',
    playIcon: '▶',
    playTitle: 'Play a 0.5s preview at this lyric',
  },
};

const KIND_NOUN: Record<AnnotationCardKind, string> = {
  cue: 'cue', span: 'span', boundary: 'boundary', loop: 'loop', pattern: 'pattern', lyrics: 'lyric',
};

export interface AnnotationPointCardProps {
  kind: AnnotationCardKind;

  // ─── Header ────────────────────────────────────────────────────────────
  /** Layer name shown in the header — caller controls numbering ("Spans 1"). */
  layerName: string;
  layerColor: string;
  /** Optional badge after the layer name (eg "detector" for read-only cards). */
  badge?: string;

  // ─── Time ─────────────────────────────────────────────────────────────
  /** Seconds from track start. Always present. */
  start: number;
  /** Seconds from track start. Absent for cues (single point). */
  end?: number;
  /** When true, the End ms input is editable. False for boundaries (end is
   *  computed from the next boundary). Ignored when `end` is undefined. */
  endEditable?: boolean;

  // ─── Content ──────────────────────────────────────────────────────────
  label: string;
  labelPlaceholder?: string;
  /** Datalist suggestions (taxonomy autocomplete). */
  labelSuggestions?: readonly string[];
  description: string;
  descriptionPlaceholder?: string;
  importance?: ItemImportance;
  /** Raw, unmapped model output for this item (the detector's emitted object).
   *  When present, a collapsible "Raw model output" JSON block is shown below
   *  the description. Only supplied for read-only detector / algorithm cards. */
  rawOutput?: unknown;

  // ─── Beat-grid context ────────────────────────────────────────────────
  /** Beats per minute. Drives the bar.beat input and the bars+beats length row.
   *  When absent both fall back to disabled / read-only seconds. */
  bpm?: number;
  /** Seconds offset of bar 1 beat 1 from t=0 (Song Info gridOffset). */
  gridOffset?: number;
  /** Time-signature numerator. Defaults to 4 when omitted. */
  beatsPerBar?: number;
  /** Optional tempo anchors for dynamic/manual grids. When supplied, the
   *  bar.beat conversion walks per-segment BPM rather than the global one. */
  anchors?: readonly TempoAnchor[];
  /** Current playhead in seconds — when supplied, each editable time row
   *  gets a crosshair button that snaps that field to the playhead. */
  currentTime?: number;

  // ─── Flags ────────────────────────────────────────────────────────────
  /** Inputs disabled + delete hidden + importance hidden. */
  readOnly?: boolean;
  /** Hide the importance star even when not read-only (eg detector cards). */
  hideImportance?: boolean;
  /** Hide the delete button even when not read-only. */
  hideDelete?: boolean;
  /** Hide the description textarea (eg algo-output cards where the detector
   *  never emits a description field). */
  hideDescription?: boolean;

  // ─── Callbacks ────────────────────────────────────────────────────────
  onChange: (patch: {
    label?: string;
    description?: string;
    start?: number;
    end?: number;
    importance?: ItemImportance;
  }) => void;
  onDelete?: () => void;
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
  onClose: () => void;

  // ─── Layout ───────────────────────────────────────────────────────────
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  /** Width in px. Default 340. Pattern cards pass 360 for the sub-beat grid. */
  width?: number;

  // ─── Slots ────────────────────────────────────────────────────────────
  /** Rendered at the top of the body, above Label (eg boundary's type
   *  dropdown, pattern's repeats + sub-beat chips). */
  extras?: ReactNode;
  /** Rendered between the description and the footer (eg snap-to-playhead row). */
  belowDescription?: ReactNode;
  /** Rendered next to the Done button in the footer (eg detector accept/reject). */
  footerExtras?: ReactNode;
  /** Rendered next to the Delete button on the left of the footer (eg the
   *  Manual section's "Split at playhead" affordance). */
  footerLeftExtras?: ReactNode;
  /** Override the Done button label (eg "Close" for read-only). */
  doneLabel?: string;
}

// ─── Formatting helpers ─────────────────────────────────────────────────

/** Editable timestamp row — `[label] [seconds] [bar.beat] [⊕ snap]`.
 *  Matches the Section editor row layout so that boundaries/spans/loops/etc.
 *  all share one visual language. Seconds is the canonical store; bar.beat
 *  is a parallel view that round-trips through the grid. */
function TimeRow({
  label, valueSec, onChangeSec, focusRing, readOnly, disabled,
  bpm, gridOffset, beatsPerBar, anchors,
  minSeconds, currentTime,
}: {
  label: string;
  valueSec: number;
  onChangeSec: (sec: number) => void;
  focusRing: string;
  readOnly?: boolean;
  disabled?: boolean;
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly TempoAnchor[];
  minSeconds?: number;
  currentTime?: number;
}) {
  const locked = readOnly || disabled;
  const canSnap = !locked && currentTime !== undefined && Number.isFinite(currentTime);
  const inputBase = `bg-[#0a0b0d] border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:ring-1 ${focusRing} disabled:text-slate-600 disabled:cursor-not-allowed`;
  return (
    <div className="flex items-center gap-2">
      <label className="text-[10px] uppercase tracking-wider text-slate-300 w-12 shrink-0">{label}</label>
      <input
        type="number"
        value={Number.isFinite(valueSec) ? Math.round(valueSec * 1000) / 1000 : 0}
        min={minSeconds ?? 0}
        step={0.001}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          const clamped = minSeconds != null ? Math.max(minSeconds, next) : Math.max(0, next);
          onChangeSec(clamped);
        }}
        className={`flex-1 min-w-0 ${inputBase} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
      />
      <BarBeatInput
        value={valueSec}
        onChange={onChangeSec}
        bpm={bpm}
        gridOffset={gridOffset ?? 0}
        beatsPerBar={beatsPerBar ?? 4}
        anchors={anchors}
        disabled={locked}
        minSeconds={minSeconds}
        className={`w-20 shrink-0 ${inputBase} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
      />
      <button
        type="button"
        onClick={() => { if (canSnap) onChangeSec(Math.max(minSeconds ?? 0, currentTime!)); }}
        disabled={!canSnap}
        className={`shrink-0 w-7 h-7 flex items-center justify-center rounded border transition-colors ${
          canSnap
            ? 'border-amber-400/40 bg-amber-500/10 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20 hover:border-amber-400/60'
            : 'border-white/[0.04] text-slate-700 cursor-not-allowed'
        }`}
        title={canSnap ? `Snap ${label.toLowerCase()} to playhead` : 'Playhead unavailable'}
      >
        <CrosshairIcon size={13} />
      </button>
    </div>
  );
}

/** Editable length row — `[bars] [beats] =N beats`. Recomputes end from start
 *  using the supplied BPM. Disabled when end is read-only or BPM is missing. */
function LengthRow({
  start, end, beatsPerBar, bpm, focusRing, disabled, onChangeEnd,
}: {
  start: number;
  end: number;
  beatsPerBar: number;
  bpm?: number;
  focusRing: string;
  disabled?: boolean;
  onChangeEnd: (sec: number) => void;
}) {
  const bpmReady = !!bpm && bpm > 0;
  const beatSec = bpmReady ? beatDuration(bpm as number) : 0;
  const totalBeatsRaw = bpmReady && beatSec > 0 ? (end - start) / beatSec : 0;
  const wholeBeats = Math.max(0, Math.round(totalBeatsRaw));
  const bars  = Math.floor(wholeBeats / beatsPerBar);
  const beats = wholeBeats - bars * beatsPerBar;
  const setLength = (newBars: number, newBeats: number) => {
    if (!bpmReady || disabled) return;
    const beatsTotal = Math.max(0, Math.round(newBars) * beatsPerBar + Math.round(newBeats));
    const newEnd = Math.round((start + beatsTotal * beatSec) * 1000) / 1000;
    onChangeEnd(newEnd);
  };
  const locked = disabled || !bpmReady;
  const title = disabled ? 'End is not editable for this annotation kind'
    : !bpmReady ? 'Set BPM in Song Info to edit length in bars/beats'
    : 'Length in bars + beats — updates the end time';
  const inputBase = `bg-[#0a0b0d] border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:ring-1 ${focusRing}`;
  return (
    <div className="flex items-center gap-2" title={title}>
      <label className="text-[10px] uppercase tracking-wider text-slate-300 w-12 shrink-0">Length</label>
      <div className="flex-1 min-w-0 flex items-center gap-1">
        <input
          type="number"
          value={bars}
          step={1}
          min={0}
          disabled={locked}
          onChange={(e) => setLength(Number(e.target.value), beats)}
          className={`w-14 min-w-0 ${inputBase} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
        />
        <span className="text-[10px] text-slate-400 font-mono">bars</span>
        <input
          type="number"
          value={beats}
          step={1}
          min={0}
          max={Math.max(0, beatsPerBar - 1)}
          disabled={locked}
          onChange={(e) => setLength(bars, Number(e.target.value))}
          className={`w-12 min-w-0 ${inputBase} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
        />
        <span className="text-[10px] text-slate-400 font-mono">beats</span>
        <span className="ml-auto text-[9px] text-slate-400 font-mono" title={`${wholeBeats} total beats (${beatsPerBar} beats/bar)`}>
          ={wholeBeats} beats
        </span>
      </div>
      <span className="shrink-0 w-7" />
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────

export function AnnotationPointCard({
  kind,
  layerName, layerColor, badge,
  start, end, endEditable = true,
  label, labelPlaceholder, labelSuggestions,
  description, descriptionPlaceholder,
  importance, rawOutput,
  bpm, gridOffset, beatsPerBar, anchors, currentTime,
  readOnly = false, hideImportance = false, hideDelete = false, hideDescription = false,
  onChange, onDelete, onPlay, onStop, isPlaying = false, onClose,
  popoverRef, positionStyle, width = 340,
  extras, belowDescription, footerExtras, footerLeftExtras, doneLabel,
}: AnnotationPointCardProps) {
  const theme = KIND_THEME[kind];
  const noun = KIND_NOUN[kind];
  const datalistId = useId();
  const hasEnd = end !== undefined;
  const showLengthRow = hasEnd && endEditable;
  const showDelete = !readOnly && !hideDelete && !!onDelete;
  const showStar = !readOnly && !hideImportance;

  // ─── Draggable + viewport-aware position ──────────────────────────────
  // `positionStyle` (from useAnnotationPopover) seeds the placement, but it is
  // clamped against an *estimated* card height, so a tall card (loops, spans)
  // can still hang off the bottom of the page. Once the card has mounted we
  // re-clamp against the real rendered size — pulling it up so the footer stays
  // on-screen — and from then on let the user drag it around by the header.
  const MARGIN = 12;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Identity of the seed position — changes when a new item opens (new anchor),
  // which is our cue to re-seat the card; a re-render mid-edit must not.
  const seedKey = `${String(positionStyle.left)}|${String(positionStyle.top)}|${String(positionStyle.transform ?? '')}`;
  const lastSeedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (lastSeedRef.current === seedKey) return;
    lastSeedRef.current = seedKey;
    const el = popoverRef.current;
    if (typeof window === 'undefined' || !el) return;
    const w = el.offsetWidth || width;
    const h = el.offsetHeight || 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Seed left/top from the hook (numeric when click-anchored, centered otherwise).
    const seedLeft = typeof positionStyle.left === 'number' ? positionStyle.left : (vw - w) / 2;
    const seedTop = typeof positionStyle.top === 'number' ? positionStyle.top : (vh - h) / 2;
    setPos({
      left: clamp(seedLeft, MARGIN, vw - w - MARGIN),
      top: clamp(seedTop, MARGIN, vh - h - MARGIN),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Don't hijack clicks on the close button (or any future header control).
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPos({
        left: clamp(ev.clientX - grabX, MARGIN, vw - w - MARGIN),
        top: clamp(ev.clientY - grabY, MARGIN, vh - h - MARGIN),
      });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const resolvedStyle: CSSProperties = pos
    ? { position: 'fixed', left: pos.left, top: pos.top, width }
    : { ...positionStyle, width };

  return (
    <div
      ref={popoverRef}
      style={resolvedStyle}
      className="z-50 bg-[#1e242e] border border-white/[0.16] rounded-md shadow-[0_0_28px_rgba(148,163,184,0.30),0_20px_45px_-12px_rgba(0,0,0,0.75)] p-3 space-y-2"
    >
      {/* Header — doubles as the drag handle for repositioning the card. */}
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex items-center gap-2 pb-1.5 border-b border-white/[0.04] cursor-move select-none"
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
          style={{ background: layerColor, boxShadow: `0 0 6px ${layerColor}66` }}
        />
        <span
          className="text-[10px] uppercase tracking-wider font-medium truncate"
          style={{ color: layerColor }}
        >
          {layerName}
        </span>
        {badge && (
          <span
            className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-300 border border-slate-600/30"
            title={readOnly ? `Generated by "${badge}" — read-only detector / algorithm output` : undefined}
          >
            {badge}
          </span>
        )}
        <button
          onClick={onClose}
          className="w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-slate-100 hover:bg-white/[0.06] text-[12px] ml-auto"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {/* Kind-specific extras at the top so the Type dropdown (boundaries) /
       *  Repeats + sub-beat chips (patterns) lead the card before Label. */}
      {extras}

      {/* Label */}
      <label className="block">
        <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">Label</span>
        <input
          autoFocus={!readOnly}
          value={label}
          readOnly={readOnly}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={labelPlaceholder ?? `short label`}
          spellCheck={false}
          list={labelSuggestions && labelSuggestions.length > 0 ? datalistId : undefined}
          className={`w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[12px] text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 ${theme.focusRing} ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
        />
        {labelSuggestions && labelSuggestions.length > 0 && (
          <datalist id={datalistId}>
            {labelSuggestions.map((v) => <option key={v} value={v} />)}
          </datalist>
        )}
      </label>

      {/* Column legend so the seconds / bar.beat columns are self-explanatory. */}
      <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-300 font-mono">
        <span className="w-12 shrink-0" />
        <span className="flex-1 min-w-0">seconds</span>
        <span className="w-20 shrink-0 cursor-help" title="bar.beat — e.g. 2.3 = bar 2 beat 3; 2.3.5 = halfway between beat 3 and 4">bar.beat</span>
        <span className="w-7 shrink-0" />
      </div>

      <TimeRow
        label="Start"
        valueSec={start}
        onChangeSec={(sec) => onChange({ start: sec })}
        focusRing={theme.focusRing}
        readOnly={readOnly}
        bpm={bpm}
        gridOffset={gridOffset}
        beatsPerBar={beatsPerBar}
        anchors={anchors}
        currentTime={currentTime}
      />
      {hasEnd && (
        <TimeRow
          label="End"
          valueSec={end!}
          onChangeSec={(sec) => onChange({ end: sec })}
          focusRing={theme.focusRing}
          readOnly={readOnly}
          disabled={!endEditable}
          bpm={bpm}
          gridOffset={gridOffset}
          beatsPerBar={beatsPerBar}
          anchors={anchors}
          minSeconds={start}
          currentTime={currentTime}
        />
      )}
      {showLengthRow && (
        <LengthRow
          start={start}
          end={end!}
          beatsPerBar={beatsPerBar ?? 4}
          bpm={bpm}
          focusRing={theme.focusRing}
          disabled={readOnly}
          onChangeEnd={(sec) => onChange({ end: sec })}
        />
      )}

      {/* Description */}
      {!hideDescription && (
        <label className="block">
          <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">Description</span>
          <textarea
            value={description}
            readOnly={readOnly}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder={descriptionPlaceholder ?? (readOnly ? '— (read-only — detector output)' : `Longer free-form note about this ${noun}…`)}
            rows={3}
            spellCheck={false}
            className={`w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 ${theme.focusRing} resize-none ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
          />
        </label>
      )}

      {/* Raw model output — the detector's emitted object for this exact item,
       *  before the UI mapped it onto the annotation shape. Collapsed by
       *  default; read-only detector / algorithm cards only. */}
      {rawOutput !== undefined && (
        <details className="block">
          <summary className="cursor-pointer select-none text-[9px] uppercase tracking-wider text-slate-300 hover:text-slate-100">
            Raw model output
          </summary>
          <pre className="mt-1 max-h-44 overflow-auto bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[10px] leading-relaxed font-mono text-slate-300 whitespace-pre-wrap break-words">
            {(() => {
              try { return JSON.stringify(rawOutput, null, 2); }
              catch { return String(rawOutput); }
            })()}
          </pre>
        </details>
      )}

      {belowDescription}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1.5 border-t border-white/[0.04] gap-1.5">
        <div className="flex items-center gap-1">
          {showDelete ? (
            <button
              onClick={() => { onDelete?.(); onClose(); }}
              className="px-3 py-1 rounded text-[10px] uppercase tracking-wider border transition-colors bg-red-500/20 border-red-400/40 text-red-200 hover:bg-red-500/30"
              title={`Delete this ${noun} (⌘Z to undo)`}
            >
              Delete
            </button>
          ) : readOnly ? (
            <span className="text-[10px] text-slate-400 italic">Read-only — sourced from a custom detector run.</span>
          ) : null}
          {footerLeftExtras}
        </div>
        <div className="flex items-center gap-1.5">
          {footerExtras}
          {showStar && (
            <ImportanceStar
              importance={importance}
              onToggle={() => onChange({ importance: importance === 'optional' ? 'critical' : 'optional' })}
            />
          )}
          {onPlay && (
            <button
              onClick={() => (isPlaying ? onStop?.() : onPlay())}
              className={`px-2.5 py-1 rounded text-[11px] border transition-colors ${
                isPlaying
                  ? 'bg-red-500/20 border-red-400/40 text-red-300 hover:bg-red-500/30'
                  : theme.playIdle
              }`}
              title={isPlaying ? 'Stop playback' : theme.playTitle}
            >
              {isPlaying ? '⏹' : theme.playIcon}
            </button>
          )}
          <button
            onClick={onClose}
            className={`px-3 py-1 rounded text-[10px] uppercase tracking-wider border ${theme.done}`}
          >
            {doneLabel ?? (readOnly ? 'Close' : 'Done')}
          </button>
        </div>
      </div>
    </div>
  );
}
