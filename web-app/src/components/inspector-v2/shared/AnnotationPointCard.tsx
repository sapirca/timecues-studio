/**
 * Unified annotation point card.
 *
 * One component renders the floating edit popover for every annotation kind
 * (cues, spans, boundaries, loops) and is also reused by the
 * custom-detector review panel in read-only mode. Replaces the four
 * near-identical popovers that previously lived in
 * Cue/Span/Loop EditPopover.tsx and the inline popover in
 * EyeEditorPanel.tsx.
 *
 * Kind-specific bits (semantic accent colour, play-icon, end-time presence,
 * extra inputs like riff repeats / sub-beat chips) are parameterised; the
 * shell layout is identical across all kinds:
 *
 *   header → extras (always-visible one-liners) → label → collapsible
 *   sections (the caller's own, then Timing / Description / Raw output) →
 *   footer
 *
 * Everything below the label lives in a named, foldable `CardSection` — the
 * card had otherwise become one long unlabelled column that no amount of
 * scrolling made legible, especially on the riff instances, where a sequence
 * tree, a prominence editor and a repeats spinner all pile on above the
 * ordinary label/time/description rows. Fold state is per section id and
 * persists, so a block you never use stays out of the way on every kind that
 * has one.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ItemImportance } from '../../../types/annotationLayer';
import { beatDuration } from '../../../utils/beatGrid';
import { BarBeatInput } from '../BarBeatInput';
import { barBeatHelpTitle, barBeatOriginTag } from '../../../utils/beatTimeFormat';
import { useBarBeatOrigin } from '../../../context/SettingsContext';
import { CrosshairIcon } from '../CrosshairIcon';
import { LoopPlayIcon } from '../LoopPlayIcon';
import { CardSection, setCardSectionOpen, useCardSectionOpen, type CardSectionSpec } from './CardSection';
import { useProminenceStrip } from './ProminenceLane';
import { ImportanceStar } from './ImportanceStar';

export type AnnotationCardKind = 'cue' | 'span' | 'boundary' | 'loop' | 'lyrics' | 'riff-pattern';

export interface KindTheme {
  /** Tailwind class for input focus ring. */
  focusRing: string;
  /** Tailwind classes for the Play button (idle state). */
  playIdle: string;
  /** Tailwind classes for the Done button. */
  done: string;
  /** ▶ for one-shot playback; the repeat-bracket icon for seamless loops. */
  playIcon: ReactNode;
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
    playIcon: <LoopPlayIcon />,
    playTitle: 'Loop-play this interval seamlessly',
  },
  lyrics: {
    focusRing: 'focus:ring-sky-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-sky-300 hover:text-sky-200 hover:border-sky-400/40',
    done: 'bg-sky-500/20 border-sky-400/40 text-sky-200 hover:bg-sky-500/30',
    playIcon: '▶',
    playTitle: 'Play a 0.5s preview at this lyric',
  },
  'riff-pattern': {
    focusRing: 'focus:ring-indigo-400/40',
    playIdle: 'bg-[#0a0b0d] border-white/[0.08] text-indigo-300 hover:text-indigo-200 hover:border-indigo-400/40',
    done: 'bg-indigo-500/20 border-indigo-400/40 text-indigo-200 hover:bg-indigo-500/30',
    playIcon: '▶',
    playTitle: 'Play repeated region',
  },
};

const KIND_NOUN: Record<AnnotationCardKind, string> = {
  cue: 'cue', span: 'span', boundary: 'boundary', loop: 'loop', lyrics: 'lyric',
  'riff-pattern': 'riff instance',
};

/** The kind's shared class tokens — so an adapter rendering its own inputs
 *  into `extras` / `sections` picks up the same accent as the card's built-in
 *  fields instead of hard-coding a second copy of the colour. */
export function cardTheme(kind: AnnotationCardKind): KindTheme {
  return KIND_THEME[kind];
}

/** What the card emits on every edit — one field at a time. */
export interface AnnotationCardPatch {
  label?: string;
  description?: string;
  start?: number;
  end?: number;
  importance?: ItemImportance;
}

/** Forwards a card patch straight onto an item whose own fields carry these
 *  exact names — spans, loops, riff instances. Drops the undefined
 *  keys and never calls through with an empty patch, which is all the four
 *  hand-written copies of this mapping ever did. Kinds that rename a field
 *  (cue/boundary `start`→`time`, lyrics `label`→`text`) still map by hand.
 *
 *  `keys` narrows the set for items that don't carry all five — a riff
 *  instance has no `importance`, so it must not be written one. */
export function forwardCardPatch<T>(
  onChange: (patch: Partial<T>) => void,
  keys: readonly (keyof AnnotationCardPatch)[] = ['start', 'end', 'label', 'description', 'importance'],
): (patch: AnnotationCardPatch) => void {
  return (patch) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (patch[k] !== undefined) out[k] = patch[k];
    if (Object.keys(out).length > 0) onChange(out as Partial<T>);
  };
}

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
  /** Resolved grid segments — keeps bar.beat readouts in step with a split grid. */
  segments?: readonly import('../../../utils/gridSegments').ResolvedSegment[];
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
  onChange: (patch: AnnotationCardPatch) => void;
  onDelete?: () => void;
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
  /** Closes the card. Returns `false` when a close guard vetoed it. */
  onClose: () => boolean | void;

  // ─── Layout ───────────────────────────────────────────────────────────
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  /** Width in px. Default 340. Riff cards pass 360 for the sub-beat grid. */
  width?: number;

  // ─── Slots ────────────────────────────────────────────────────────────
  /** Always-visible content at the top of the body, above Label — reserved
   *  for the one-liners that are the card's own headline (the boundary's type
   *  dropdown, a riff instance's repeat count). Anything taller belongs in
   *  `sections`, where the reader can fold it away. */
  extras?: ReactNode;
  /** Kind-specific collapsible sections, rendered under Label and above the
   *  built-in Timing / Description / Raw ones (prominence, the sub-beat grid,
   *  a riff's sequence tree). */
  sections?: CardSectionSpec[];
  /** Rendered next to the Done button in the footer (eg detector accept/reject). */
  footerExtras?: ReactNode;
  /** Rendered next to the Delete button on the left of the footer (eg the
   *  Manual section's "Split at playhead" affordance). */
  footerLeftExtras?: ReactNode;
  /** Override the Done button label (eg "Close" for read-only). */
  doneLabel?: string;
  /** Disable the Done button (eg an `extras` field is mid-edit with an
   *  invalid value) — X and outside-click/Escape still close, since no
   *  invalid value ever reaches `onChange` in the first place. */
  doneDisabled?: boolean;
  /** Tooltip shown on the disabled Done button explaining why. */
  doneDisabledReason?: string;
}

// ─── Formatting helpers ─────────────────────────────────────────────────

/** Editable timestamp row — `[label] [seconds] [bar.beat] [⊕ snap]`.
 *  Matches the Section editor row layout so that boundaries/spans/loops/etc.
 *  all share one visual language. Seconds is the canonical store; bar.beat
 *  is a parallel view that round-trips through the grid. */
function TimeRow({
  label, valueSec, onChangeSec, focusRing, readOnly, disabled,
  bpm, gridOffset, beatsPerBar, segments,
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
  /** Resolved grid segments — keeps bar.beat readouts in step with a split grid. */
  segments?: readonly import('../../../utils/gridSegments').ResolvedSegment[];
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
        segments={segments}
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
  bpm, gridOffset, beatsPerBar, segments, currentTime,
  readOnly = false, hideImportance = false, hideDelete = false, hideDescription = false,
  onChange, onDelete, onPlay, onStop, isPlaying = false, onClose,
  popoverRef, positionStyle, width = 340,
  extras, sections = [], footerExtras, footerLeftExtras, doneLabel,
  doneDisabled = false, doneDisabledReason,
}: AnnotationPointCardProps) {
  const theme = KIND_THEME[kind];
  const noun = KIND_NOUN[kind];
  // ─── Prominence-editing mode ──────────────────────────────────────────
  // Expanding Prominence opens the four-row strip on the item's own lane
  // (InspectorPageV2 reads the same section state). The editor is out there,
  // on the item, so while it's up this card stops being a record of the
  // annotation and becomes that editor's toolbar: header, the level buttons,
  // Done. Label, the headline field and every other section are gone, not
  // just folded — a card still tall enough to cover the lanes around the one
  // you're editing is the complaint this whole mode exists to answer. Folding
  // Prominence brings the full card straight back; nothing was rewritten.
  const hasProminence = sections.some((sec) => sec.id === 'prominence');
  // Gated on the strip actually being mounted, not merely on the section being
  // open. A card that has hidden itself for an editor that never appeared is
  // worse than no change at all — and there are real places where it can't
  // appear: read-only detector cards, review mode, and the Prep workspace all
  // withhold the lane's `onProminenceChange`. In any of those the section just
  // expands in place, with its own buttons and breakpoint chips, exactly as it
  // did before this mode existed.
  const stripEl = useProminenceStrip();
  const prominenceMode = useCardSectionOpen('prominence', false)
    && hasProminence && !readOnly && stripEl !== null;
  // Closing the card (Done, ×, Escape, clicking another item) ends prominence
  // editing too. Otherwise the flag would outlive the card that set it and the
  // next annotation you clicked would open straight into a lane editor you
  // never asked for — the section's remembered fold is a preference, this is a
  // mode, and only one of the two should survive the card.
  useEffect(() => () => setCardSectionOpen('prominence', false), []);
  const barBeatOrigin = useBarBeatOrigin();
  const datalistId = useId();
  const hasEnd = end !== undefined;
  const showLengthRow = hasEnd && endEditable;
  const showDelete = !readOnly && !hideDelete && !!onDelete;
  const showStar = !readOnly && !hideImportance;

  // Folded-section read-outs: enough to tell you whether you need to open it.
  const fmtSec = (v: number) => `${(Number.isFinite(v) ? v : 0).toFixed(2)}s`;
  const timingSummary = hasEnd ? `${fmtSec(start)} → ${fmtSec(end!)}` : fmtSec(start);
  const descPreview = description.trim().replace(/\s+/g, ' ');
  const descriptionSummary = descPreview.length > 34 ? `${descPreview.slice(0, 34)}…` : (descPreview || 'empty');

  // ─── Draggable + viewport-aware position ──────────────────────────────
  // `positionStyle` (from useAnnotationPopover) seeds the placement, but it is
  // clamped against an *estimated* card height, so a tall card (loops, spans)
  // can still hang off the bottom of the page. Once the card has mounted we
  // re-clamp against the real rendered size — pulling it up so the footer stays
  // on-screen — and from then on let the user drag it around by the header.
  const MARGIN = 12;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Set once the user drags the card themselves: putting it back where they
  // just moved it from would be the card arguing with them.
  const userMovedRef = useRef(false);
  // Identity of the seed position — changes when a new item opens (new anchor),
  // which is our cue to re-seat the card; a re-render mid-edit must not.
  const seedKey = `${String(positionStyle.left)}|${String(positionStyle.top)}|${String(positionStyle.transform ?? '')}`;
  const lastSeedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (lastSeedRef.current === seedKey) return;
    lastSeedRef.current = seedKey;
    userMovedRef.current = false;
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

  // Get off the strip. The prominence editor opens on the item's own lane —
  // directly under the click that opened this card, which is exactly where the
  // card seeded itself. Nothing else can resolve that: the strip is as wide as
  // the item and the card is placed at the pointer. So when a strip appears
  // under us, move by the smallest amount that clears it — above if the (now
  // folded-down) card fits there, otherwise below, where the maxHeight rule
  // lets it scroll rather than run off the screen.
  //
  // Driven off `pos` rather than the card's live rect, and that matters:
  // entering prominence mode shrinks the card, which trips the hook's
  // ResizeObserver, which re-clamps `positionStyle` and re-seats the card back
  // onto the strip. Reading the DOM would see the pre-seat position and
  // conclude there was nothing to do, one layout effect before the seat that
  // put us back. Reading the position we're *about* to render at converges
  // instead: seat, clear, done — a move doesn't change the card's size, so
  // there's no third pass.
  useLayoutEffect(() => {
    if (!stripEl || !pos || userMovedRef.current || typeof window === 'undefined') return;
    const el = popoverRef.current;
    if (!el) return;
    const strip = stripEl.getBoundingClientRect();
    const h = el.offsetHeight;
    const GAP = 10;
    const overlaps = pos.left < strip.right && pos.left + el.offsetWidth > strip.left
      && pos.top < strip.bottom + GAP && pos.top + h + GAP > strip.top;
    if (!overlaps) return;
    // Always leave a usable slab of card on screen, even in the worst case
    // where the strip sits near the bottom of a short viewport.
    const MIN_VISIBLE = 140;
    const above = strip.top - GAP - h;
    const top = clamp(
      above >= MARGIN ? above : strip.bottom + GAP,
      MARGIN,
      Math.max(MARGIN, window.innerHeight - MIN_VISIBLE),
    );
    if (Math.abs(top - pos.top) < 1) return;
    setPos({ left: pos.left, top });
  }, [stripEl, pos]);

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
      userMovedRef.current = true;
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

  // Capped to the room actually available below the card's current top edge
  // (not just a flat viewport fraction) so the card never overflows past the
  // bottom of the screen regardless of where it's anchored or dragged to —
  // content beyond that scrolls inside the body section below instead of
  // being silently clipped off-screen with no way to reach it (e.g. a riff
  // instance's sequence tree, once several combos are expanded, can get
  // taller than the viewport).
  const resolvedStyle: CSSProperties = pos
    ? {
      position: 'fixed', left: pos.left, top: pos.top, width,
      maxHeight: `calc(100vh - ${pos.top + MARGIN}px)`,
    }
    : { ...positionStyle, width };

  // ─── Off the screen while the lane editor is up ────────────────────────
  // Not closed — nothing about the popover's state changes, the card simply
  // doesn't draw. Prominence is edited in one place, on the item, and the
  // strip's × puts this straight back. Rendering nothing (rather than a
  // hidden node) also parks the hook's outside-click listener, which reads
  // `popoverRef.current`: a click on the strip is not a click outside a card
  // that isn't there, so editing on the lane can't dismiss what it came from.
  if (prominenceMode) return null;

  return (
    <div
      ref={popoverRef}
      data-annotation-popover
      style={resolvedStyle}
      className="z-50 bg-[#1e242e] border border-white/[0.16] rounded-md shadow-[0_0_28px_rgba(148,163,184,0.30),0_20px_45px_-12px_rgba(0,0,0,0.75)] flex flex-col overflow-hidden"
    >
      {/* Header — doubles as the drag handle for repositioning the card.
       *  Stays pinned (shrink-0) while the body below scrolls. */}
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex items-center gap-2 px-3 pt-3 pb-1.5 border-b border-white/[0.04] cursor-move select-none shrink-0"
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

      {/* Scrollable body — everything between the header and the footer.
       *  `min-h-0` is required alongside `overflow-y-auto` for a flex child to
       *  actually shrink and scroll instead of forcing the flex column (and
       *  so the fixed-position card) to grow past `maxHeight` above. */}
      <div className="px-3 py-2 space-y-2 overflow-y-auto min-h-0">
        {/* Always-visible extras lead the card: the boundary Type dropdown
         *  (which rewrites the label below it) and the riff repeat
         *  count. One-liners only — taller blocks go in `sections`. */}
        {!prominenceMode && extras}

        {/* Label */}
        {!prominenceMode && (
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
        )}

        {/* Collapsible sections — the caller's own first (prominence, sub-beat
         *  grid, riff sequence), then the three every card shares. Their own
         *  hairline separators do the spacing, so they sit in a tighter stack
         *  than the `space-y-2` rows above. */}
        <div className="space-y-1">
          {sections
            .filter((section) => !prominenceMode || section.id === 'prominence')
            .map((section) => <CardSection key={section.id} {...section} />)}

          {!prominenceMode && (
          <CardSection
            id="timing"
            title="Timing"
            summary={timingSummary}
            content={
              <div className="space-y-2">
                {/* Column legend so the seconds / bar.beat columns are self-explanatory.
                 *  The bar.beat header carries the numbering convention ("from 1" /
                 *  "from 0") — without it a zero-based grid just looks off by one. */}
                <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-300 font-mono">
                  <span className="w-12 shrink-0" />
                  <span className="flex-1 min-w-0">seconds</span>
                  <span className="w-20 shrink-0 cursor-help leading-tight" title={barBeatHelpTitle(barBeatOrigin)}>
                    bar.beat
                    <span className="text-slate-500 normal-case"> {barBeatOriginTag(barBeatOrigin)}</span>
                  </span>
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
                  segments={segments}
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
                    segments={segments}
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
              </div>
            }
          />
          )}

          {!prominenceMode && !hideDescription && (
            <CardSection
              id="description"
              title="Description"
              defaultOpen={false}
              summary={descriptionSummary}
              content={
                <textarea
                  value={description}
                  readOnly={readOnly}
                  onChange={(e) => onChange({ description: e.target.value })}
                  placeholder={descriptionPlaceholder ?? (readOnly ? '— (read-only — detector output)' : `Longer free-form note about this ${noun}…`)}
                  rows={3}
                  spellCheck={false}
                  className={`w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 ${theme.focusRing} resize-none ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                />
              }
            />
          )}

          {/* The detector's emitted object for this exact item, before the UI
           *  mapped it onto the annotation shape. Read-only detector /
           *  algorithm cards only. */}
          {!prominenceMode && rawOutput !== undefined && (
            <CardSection
              id="raw-model-output"
              title="Raw model output"
              defaultOpen={false}
              content={
                <pre className="max-h-44 overflow-auto bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[10px] leading-relaxed font-mono text-slate-300 whitespace-pre-wrap break-words">
                  {(() => {
                    try { return JSON.stringify(rawOutput, null, 2); }
                    catch { return String(rawOutput); }
                  })()}
                </pre>
              }
            />
          )}
        </div>
      </div>

      {/* Footer — stays pinned (shrink-0) while the body above scrolls. */}
      <div className="flex items-center justify-between px-3 pb-3 pt-1.5 border-t border-white/[0.04] gap-1.5 shrink-0">
        <div className="flex items-center gap-1">
          {prominenceMode ? (
            // The way back, spelled out — the card looks like a different
            // thing in this mode, and "fold the section" isn't guessable.
            <button
              onClick={() => setCardSectionOpen('prominence', false)}
              className="px-2 py-1 rounded text-[10px] uppercase tracking-wider border bg-white/[0.03] border-white/[0.08] text-slate-300 hover:text-slate-100 hover:bg-white/[0.06]"
              title="Close the editor on the lane and go back to the full card"
            >
              ↩ Full card
            </button>
          ) : showDelete ? (
            <button
              // Close FIRST and bail if a guard vetoes it, so cancelling
              // that prompt cancels the delete as well (see NodeEditPopover).
              onClick={() => { if (onClose() === false) return; onDelete?.(); }}
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
          {!prominenceMode && showStar && (
            <ImportanceStar
              importance={importance}
              onToggle={() => onChange({ importance: importance === 'optional' ? 'critical' : 'optional' })}
            />
          )}
          {onPlay && (
            <button
              onClick={() => (isPlaying ? onStop?.() : onPlay())}
              className={`px-2.5 py-1 h-[24px] min-w-[34px] inline-flex items-center justify-center rounded text-[11px] border transition-colors ${
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
            onClick={doneDisabled ? undefined : onClose}
            disabled={doneDisabled}
            title={doneDisabled ? (doneDisabledReason ?? 'Fix the invalid field first') : undefined}
            className={`px-3 py-1 rounded text-[10px] uppercase tracking-wider border ${
              doneDisabled
                ? 'bg-white/[0.02] text-slate-600 border-white/[0.06] cursor-not-allowed'
                : theme.done
            }`}
          >
            {doneLabel ?? (readOnly ? 'Close' : 'Done')}
          </button>
        </div>
      </div>
    </div>
  );
}
