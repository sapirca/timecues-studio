/**
 * BeatChipControls — the sub-beat chip grid and Tap Along machinery shared by
 * every surface that edits a rhythmic cycle.
 *
 * `BeatChipPicker` renders `steps` sub-beat chips grouped into beats; a step
 * is either a lone tick or inside one held span, never both. Tap Along records
 * live taps against the playing audio and quantizes them onto that same grid.
 *
 * Consumers: the riff-pattern node editor (RiffPatternEditorPanel /
 * NodeEditPopover / RiffPatternEditPopover) and the boundary tap-refine flow.
 * Kept in one module on purpose — a per-surface fork of useTapAlong /
 * TapAlongControls drifts, and the two surfaces must behave identically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  accentHeight,
  accentOpacity,
  BOUNDARY_MIN_SEGMENT_BEATS,
  BOUNDARY_TAP_CLUSTER_BEATS,
  PATTERN_SUBBEATS_PER_BEAT,
  normalizePatternAccents,
} from '../../types/annotationLayer';

/** The accent shape of a pattern cycle: lone point-ticks plus held spans. */
export interface PatternAccents {
  highlightedBeats: number[];
  spans: [number, number][];
}

/** Sub-beat chip grid: `beatsPerBar` groups × PATTERN_SUBBEATS_PER_BEAT chips
 *  each. Down-beats (1st chip in each group) carry the beat number; off-beats
 *  show a "·" to advertise they're interactive, not decorative dividers.
 *
 *  Interaction model (editable cards only):
 *  - **Click** a chip → toggle a lone tick accent on/off.
 *  - **Click a span chip** → un-hold that span.
 *  - **Drag** across ≥2 chips → merge them into one held span (sustained accent).
 *  A step is either a lone tick or inside one span — never both. */
export function BeatChipPicker({ color, steps, subbeatsPerBeat, highlighted, spans = [], accents, onChange, readOnly = false, playheadStep = null, onTapAlongTap }: {
  color: string;
  /** step -> 1..127, how hard each step was struck when a detector measured
   *  it. Display only: editing a step never writes one, and a step with no
   *  entry draws at full strength. */
  accents?: Record<number, number>;
  /** Total sub-steps in the cycle (the index space). Grouped visually into
   *  `ceil(steps / subbeatsPerBeat)` beat-groups. */
  steps: number;
  /** Sub-steps per beat, for the visual grouping (downbeat markers, "Beat
   *  N.M" labels) — defaults to the fixed `PATTERN_SUBBEATS_PER_BEAT` used by
   *  plain Pattern items. Riff Nodes pass their own per-node resolution
   *  (`RiffNode.subbeatsPerBeat`, user-choosable) here so a triplet or
   *  quarter-note node groups by its actual beats instead of being sliced
   *  into groups of 4 regardless of its real subdivision. */
  subbeatsPerBeat?: number;
  highlighted: number[];
  /** Held runs `[startStep, lengthSteps]` (length ≥ 2). */
  spans?: [number, number][];
  /** Fires once per edit with the FULL accent shape (ticks + spans) so callers
   *  can patch both fields in a single update — two separate patches in one
   *  tick would clobber each other. */
  onChange: (next: PatternAccents) => void;
  /** When true, chips render their state but can't be edited — used by
   *  read-only (detector-sourced) pattern cards. Hides the mode toggle. */
  readOnly?: boolean;
  /** Live playhead position as a fractional sub-beat index inside the current
   *  cycle (0..steps), or null when audio isn't playing through the region.
   *  Drives the karaoke sweep: passed chips fill, hits "fire", the step under
   *  the playhead carries a ring. */
  playheadStep?: number | null;
  /** When set, clicking a cell places a Tap Along tap at that exact step
   *  instead of the normal edit gesture — lets the user nail a beat with the
   *  mouse instead of (or alongside) pressing Space in time; dragging to
   *  another cell before release passes its step as `endStep`, capturing a
   *  held span the same way holding Space across beats does. Overrides
   *  `readOnly`'s lockout for this one gesture (editing the node's actual
   *  saved pattern directly still stays locked during a session). */
  onTapAlongTap?: (step: number, endStep?: number) => void;
}) {
  const subbeats = Math.max(1, Math.floor(subbeatsPerBeat || PATTERN_SUBBEATS_PER_BEAT));
  const total = Math.max(1, Math.floor(steps || subbeats));
  const numBeats = Math.ceil(total / subbeats);
  const hSet = new Set(highlighted);
  // Per-step span membership: index → {role, span}. A step in a span renders as
  // part of a connected pill instead of a lone chip.
  const spanByStep = new Map<number, { role: 'start' | 'mid' | 'end'; span: [number, number] }>();
  for (const sp of spans) {
    const [s, l] = sp;
    for (let k = 0; k < l; k++) {
      spanByStep.set(s + k, { role: k === 0 ? 'start' : k === l - 1 ? 'end' : 'mid', span: sp });
    }
  }
  // Karaoke sweep state. `elapsed` (floor) drives the fill/glow trail — every
  // chip at or before it has "played" this cycle. `current` (round) drives
  // the ring — it's "which chip would a tap *right now* land on", which must
  // match `quantizeTapsAt`'s Math.round, not floor: floor would keep the ring
  // on beat N for the back half of its window too, so tapping there (normal
  // human reaction lands slightly late) visibly shows beat N ringed while the
  // tap actually rounds forward onto N+1 — a Tap Along press that looks like
  // it "missed" the highlighted beat.
  const sweeping = playheadStep != null;
  const elapsed = sweeping ? Math.min(total - 1, Math.max(0, Math.floor(playheadStep))) : -1;
  const current = sweeping ? Math.min(total - 1, Math.max(0, Math.round(playheadStep))) : -1;

  const [dragPreview, setDragPreview] = useState<{ lo: number; hi: number } | null>(null);
  const anchorRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  const commit = (ticks: Iterable<number>, nextSpans: [number, number][]) => {
    onChange(normalizePatternAccents(Array.from(ticks), nextSpans, total));
  };

  // `onTapAlongTap` reuses this same anchor/drag tracking to let a Tap Along
  // session accept a mouse click-or-hold on a specific cell, even though
  // `readOnly` is otherwise locking the grid down during a session (the
  // normal edit gesture — toggling this node's *saved* pattern — stays
  // disabled; only the tap-capture path opens up).
  const editable = !readOnly || !!onTapAlongTap;

  const beginInteraction = (i: number) => {
    if (!editable) return;
    anchorRef.current = i;
    isDraggingRef.current = false;
    setDragPreview({ lo: i, hi: i });
  };

  const moveInteraction = (i: number) => {
    if (!editable || anchorRef.current === null) return;
    const a = anchorRef.current;
    if (i !== a) isDraggingRef.current = true;
    setDragPreview({ lo: Math.min(a, i), hi: Math.max(a, i) });
  };

  const endInteraction = () => {
    const anchor = anchorRef.current;
    const wasDragging = isDraggingRef.current;
    const preview = dragPreview;
    anchorRef.current = null;
    isDraggingRef.current = false;
    setDragPreview(null);
    if (!editable || anchor === null || preview === null) return;
    if (onTapAlongTap) {
      // A click records a plain tap at the cell pressed; a hold-drag records
      // a sustained span across wherever the pointer ended up — same
      // tick-vs-hold split as the normal edit gesture below, but landing as
      // a captured tap instead of editing the node's saved pattern directly.
      onTapAlongTap(anchor, wasDragging ? (anchor === preview.lo ? preview.hi : preview.lo) : undefined);
      return;
    }
    if (!wasDragging) {
      // Single click: toggle tick, or un-hold if chip is part of a span.
      const hit = spanByStep.get(anchor);
      if (hit) {
        commit(highlighted, spans.filter((sp) => sp !== hit.span));
      } else {
        const nextTicks = new Set(highlighted);
        if (nextTicks.has(anchor)) nextTicks.delete(anchor); else nextTicks.add(anchor);
        commit(nextTicks, spans);
      }
    } else {
      // Drag: create a held span across the preview range.
      const len = preview.hi - preview.lo + 1;
      if (len >= 2) {
        const overlaps = ([s, l]: [number, number]) => preview.lo < s + l && s <= preview.hi;
        const nextSpans = spans.filter((sp) => !overlaps(sp));
        nextSpans.push([preview.lo, len]);
        const ticks = highlighted.filter((t) => t < preview.lo || t > preview.hi);
        commit(ticks, nextSpans);
      }
    }
  };

  // Bail out cleanly when the pointer is released anywhere / leaves the picker.
  useEffect(() => {
    const onUp = () => { endInteraction(); };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  });

  return (
    <div className="space-y-1.5 select-none">
      <div className={`flex items-center gap-2 flex-wrap ${readOnly && !onTapAlongTap ? 'pointer-events-none opacity-80' : ''}`}>
      {Array.from({ length: numBeats }, (_, beatIdx) => {
        // If a held span carries over from the previous beat group, close the
        // outer gap-2 between beat-group divs so the run reads as unbroken.
        const firstSpan = spanByStep.get(beatIdx * subbeats);
        const continuesFromPrevBeat = firstSpan !== undefined && firstSpan.role !== 'start';
        return (
        <div key={beatIdx} className="flex items-center gap-0.5" style={continuesFromPrevBeat ? { marginLeft: -8 } : undefined}>
          {Array.from({ length: subbeats }, (_, subIdx) => {
            const i = beatIdx * subbeats + subIdx;
            if (i >= total) return null;
            const span = spanByStep.get(i);
            const inSpan = span !== undefined;
            const on = hSet.has(i) || inSpan;
            const isDownBeat = subIdx === 0;
            const isCurrent = sweeping && i === current;
            const passed = sweeping && i <= elapsed; // already played this cycle
            const upcoming = sweeping && i > elapsed; // not yet reached this cycle
            const previewed = dragPreview !== null && i >= dragPreview.lo && i <= dragPreview.hi;

            const classes = ['w-5 h-6 text-[9px] font-mono border cursor-pointer transition-all touch-none'];
            const style: React.CSSProperties = {};
            // Span chips connect into one pill: round only the run's outer ends,
            // and close the 2px intra-group gap so mid-run steps read as held.
            if (inSpan) {
              classes.push(
                span.role === 'start' ? 'rounded-l-sm rounded-r-none'
                  : span.role === 'end' ? 'rounded-r-sm rounded-l-none'
                    : 'rounded-none',
              );
              if (span.role !== 'start' && subIdx !== 0) style.marginLeft = -2;
            } else {
              classes.push('rounded-sm');
            }
            if (on) {
              style.background = color;
              style.borderColor = color;
              (style as Record<string, string>)['--chip-glow'] = `${color}88`;
              classes.push('text-white');
              if (passed) {
                // Hit just "fired" — punch up the glow for the karaoke flash.
                style.boxShadow = `0 0 12px ${color}, 0 0 4px ${color}`;
              } else if (upcoming) {
                // Hit hasn't been reached yet this cycle — dim it back.
                style.opacity = 0.3;
              } else if (!inSpan) {
                classes.push('shadow-[0_0_6px_var(--chip-glow)]');
              }
              // How hard this step was struck. Skipped while the sweep owns
              // the opacity (the karaoke dim means something else), and never
              // applied to an empty chip.
              if (style.opacity === undefined) style.opacity = accentOpacity(accents?.[i]);
            } else {
              style.borderColor = isDownBeat ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.12)';
              if (passed) {
                // Empty step the sweep has crossed — faint trail so the fill reads.
                style.background = 'rgba(255,255,255,0.07)';
                classes.push(isDownBeat ? 'text-slate-300' : 'text-slate-400');
              } else {
                classes.push('bg-[#0a0b0d]');
                classes.push(isDownBeat ? 'text-slate-300 hover:text-slate-100 hover:bg-white/[0.06]' : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.06]');
              }
            }
            if (previewed) {
              // Live hold-drag preview — dashed ring over the pending span.
              style.outline = `2px dashed ${color}`;
              style.outlineOffset = '1px';
            } else if (isCurrent) {
              // Playhead marker — a ring on the step playing right now.
              style.outline = `2px solid ${color}`;
              style.outlineOffset = '1px';
            }

            const title = onTapAlongTap
              ? `Beat ${beatIdx + 1}${isDownBeat ? '' : `.${subIdx + 1}`} (step ${i + 1}) — click to tap this beat, drag to hold a span`
              : inSpan
                ? `Beat ${beatIdx + 1}${isDownBeat ? '' : `.${subIdx + 1}`} (step ${i + 1}) — held span${readOnly ? '' : ', click to un-hold'}`
                : `Beat ${beatIdx + 1}${isDownBeat ? '' : `.${subIdx + 1}`} (step ${i + 1}) — ${on ? 'accent, click to clear' : 'click to tick · drag to hold'}`;

            return (
              <button
                key={`${beatIdx}-${subIdx}`}
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  beginInteraction(i);
                }}
                onPointerEnter={() => { moveInteraction(i); }}
                className={classes.join(' ')}
                style={style}
                title={title}
              >
                {isDownBeat ? beatIdx + 1 : (on ? '' : '·')}
              </button>
            );
          })}
        </div>
        );
      })}
      </div>
    </div>
  );
}

// ─── Tap Along ──────────────────────────────────────────────────────────────
//
// Lets the user tap in time with a node's real audio instead of hand-placing
// chips — press Tap Along, a 3-2-1 count-in leads into the node looping again
// and again, tap the keyboard (Space) on each hit across as many passes as
// needed watching them land live on the beat grid, then Retry / Save / Cancel
// the captured pattern. Shared by NodeEditPopover (a bare node's own floating
// popup) and the inline node view inside RiffPatternEditPopover's sequence
// tree — `useTapAlong` owns the capture/quantize state, `TapAlongControls`
// is the dumb button row, and the caller feeds `previewPatch` into its own
// `BeatChipPicker` so taps are visible on the exact same grid, live, not just
// after Save.

/** Candidate steps-per-beat grids a tap session can resolve to — same set
 *  `NodeLengthControl`'s "Divide beat into" dropdown offers. */
const TAP_SUBDIVISION_CANDIDATES = [1, 2, 4, 8, 3, 6];

/** Visual count-in before recording starts, in seconds. */
const TAP_COUNTDOWN_SECONDS = 3;
/** How much real audio plays *before* the node's own start on every pass
 *  (count-in and every loop repeat alike). Zero: the 3-2-1 count-in is
 *  silent, and `runCountdown` below fires the seek+play at
 *  `(TAP_COUNTDOWN_SECONDS - TAP_PREROLL_SECONDS) * 1000` — i.e. exactly
 *  when the count-in finishes — so real audio starts precisely on the
 *  node's own beat 0, not some seconds early. Kept as a named constant (and
 *  threaded through `playheadStep` in NodeEditPopover / InspectorPageV2)
 *  rather than inlining 0, so a future lead-in can be reintroduced by
 *  changing just this one value. */
export const TAP_PREROLL_SECONDS = 0;
/** Taps are accepted starting this long *before* the countdown visually
 *  reaches "recording" — the very first beat is easy to tap a hair early
 *  while still anticipating the count-in, and without this lead a tap right
 *  on time can lose a race against the phase flip and get silently dropped. */
const TAP_ARM_LEAD_SECONDS = 0.5;
/** Floor on a raw press's own duration, in beats. A press and release inside
 *  the same animation frame would otherwise measure as zero and be dropped
 *  as a zero-width block — the tap would simply vanish. One hundredth of a
 *  beat is `BOUNDARY_MIN_SEGMENT_BEATS`: the narrowest block a boundary node
 *  keeps, so the hit survives without being given a length it didn't have. */
const MIN_HELD_TAP_BEATS = BOUNDARY_MIN_SEGMENT_BEATS;

export interface TapAlongPatch {
  stepsPerCycle: number;
  subbeatsPerBeat: number;
  highlightedBeats: number[];
  spans: [number, number][];
}

/** One raw (unquantized) tap — its beat position (0..numBeats, negative if
 *  it landed during the pre-roll lead-in) plus which loop pass it happened
 *  in, so a piano-roll view can lay out one lane per pass. A held press
 *  (Space/Enter down, then up later, or a mouse drag on the grid) also
 *  carries `endBeat` — the position at release — turning this into a
 *  sustained span instead of a lone point once quantized. */
export interface TapEvent {
  beat: number;
  pass: number;
  endBeat?: number;
}

/** Picks the coarsest subdivision whose grid explains a set of tapped
 *  beat-positions within ~1/50th of a beat of the best-fitting candidate —
 *  so a plain quarter-note tap reads as quarters, not an over-fit triplet
 *  grid chasing human timing jitter. */
function bestFitSubdivision(tapBeats: number[]): number {
  const scored = TAP_SUBDIVISION_CANDIDATES.map((subbeats) => {
    const err = tapBeats.reduce((sum, b) => sum + Math.abs(b - Math.round(b * subbeats) / subbeats), 0)
      / tapBeats.length;
    return { subbeats, err };
  });
  const bestErr = Math.min(...scored.map((s) => s.err));
  const within = scored.filter((s) => s.err <= bestErr + 0.02);
  within.sort((a, b) => a.subbeats - b.subbeats);
  return within[0]?.subbeats ?? PATTERN_SUBBEATS_PER_BEAT;
}

/** Quantizes tap events onto a *given* (fixed) subdivision — used for the
 *  live preview while a session is still recording/under review, so the
 *  grid dimensions never move mid-session (only which of its fixed cells are
 *  lit/held changes). A point tap becomes a tick; a held tap (`endBeat` set)
 *  becomes a span once its start/end round to different steps — same
 *  ≥2-step threshold `BeatChipPicker`'s own mouse-drag gesture uses — else
 *  it falls back to a tick, same as a quick press/release. Clamps into
 *  range and normalizes (dedupe, overlap resolution) via
 *  `normalizePatternAccents`. */
function quantizeTapsAt(taps: TapEvent[], numBeats: number, subbeats: number): TapAlongPatch {
  const totalSteps = Math.max(1, Math.round(numBeats * subbeats));
  const clampStep = (b: number) => Math.max(0, Math.min(totalSteps - 1, Math.round(b * subbeats)));
  const ticks = new Set<number>();
  const spans: [number, number][] = [];
  for (const t of taps) {
    const startStep = clampStep(t.beat);
    if (t.endBeat == null) { ticks.add(startStep); continue; }
    const endStep = clampStep(t.endBeat);
    const lo = Math.min(startStep, endStep);
    const hi = Math.max(startStep, endStep);
    if (hi > lo) spans.push([lo, hi - lo + 1]); else ticks.add(startStep);
  }
  const normalized = normalizePatternAccents(Array.from(ticks), spans, totalSteps);
  return { stepsPerCycle: totalSteps, subbeatsPerBeat: subbeats, ...normalized };
}

/** Converts a *finished* tap session's recorded events (fractional beat
 *  positions, 0..numBeats — an early tap during the pre-roll can be
 *  slightly negative) into a full node grid patch — resolves the best-fit
 *  subdivision off every start/end position (only worth doing once, at
 *  Save; see `quantizeTapsAt` for the live/stable preview used during
 *  recording) and quantizes onto it. */
function tapsToPatch(taps: TapEvent[], numBeats: number): TapAlongPatch {
  const allBeats = taps.flatMap((t) => (t.endBeat == null ? [t.beat] : [t.beat, t.endBeat]));
  return quantizeTapsAt(taps, numBeats, bestFitSubdivision(allBeats));
}

export type TapAlongPhase = 'idle' | 'countdown' | 'recording' | 'review';

/** Tap-along capture state machine. Samples `playheadStep` — the same
 *  fractional position that drives `BeatChipPicker`'s karaoke sweep — at the
 *  instant of each tap rather than tracking audio time itself, so it stays
 *  correct whether playback is a bare node's own occurrence or this node's
 *  turn inside a full instance sequence replay (where `playheadStep` goes
 *  null between this node's own appearances and taps during that window are
 *  simply ignored).
 *
 *  `onPlay` (with `TAP_PREROLL_SECONDS`) re-fires every time a pass reaches
 *  its natural end while still `recording` — neither preview mechanism (a
 *  bare node's own occurrence, or an instance replay) loops on its own, so
 *  this re-triggers it to fake a loop for as many passes as the user wants,
 *  accumulating taps across all of them. Only the session's first pass shows
 *  the visual 3-2-1 count-in; every repeat after that restarts audio and
 *  re-arms capture immediately, since the user is already tapping in time.
 *  A manual Stop ends the loop and moves to `review` (Retry re-arms from a
 *  fresh countdown, Save commits the accumulated taps, Cancel discards them)
 *  instead of committing automatically. `save` also works straight out of
 *  `recording` — closing the owning card commits the take that way, so the
 *  blocks the user is watching land are the blocks they keep, and only the
 *  explicit Cancel (✕) throws a session away. Exposes `previewPatch` — the
 *  accumulated taps quantized onto the node's *current* (fixed) subdivision,
 *  same shape as the final
 *  Save patch minus the resize — so a caller can feed it straight into its
 *  own `BeatChipPicker` and show taps landing live, on a grid that never
 *  reflows mid-session (the smarter best-fit subdivision, which can change
 *  the grid's own dimensions, only runs once at Save). Also exposes
 *  `tapEvents` (each tap's raw, unquantized beat position plus which loop
 *  pass it happened in) for a raw-timing view like `TapAlongPianoRoll`. */
export function useTapAlong({
  stepsPerCycle, subbeatsPerBeat, playheadStep, isPlaying, onPlay, onStop, onChange, onSaveTaps, onPhaseChange,
}: {
  stepsPerCycle: number;
  subbeatsPerBeat: number;
  playheadStep: number | null;
  isPlaying?: boolean;
  onPlay?: (preRollSec?: number) => void;
  onStop?: () => void;
  /** Commits a finished session as a quantised chip-grid patch. Ignored when
   *  `onSaveTaps` is given. */
  onChange?: (patch: TapAlongPatch) => void;
  /** Commits a finished session as its RAW presses instead — fractional beat
   *  positions, each with the duration it was held for, nothing rounded to a
   *  subdivision. What a *boundary* node wants (see
   *  `boundarySegmentsFromTaps`): the same capture loop, the same controls,
   *  the same taps — only the thing they're written into differs, which is why
   *  this is an option on the one hook rather than a second tap-along.
   *  Takes precedence over `onChange` when both are given. */
  onSaveTaps?: (taps: TapEvent[], numBeats: number) => void;
  /** Fires whenever the session leaves/re-enters `idle` — lets a caller that
   *  owns several `useTapAlong` instances at once (e.g. one per node in a Riff
   *  Pattern's sequence tree) know a session is live somewhere, so it can hide
   *  its own play/stop control: that control shares the same `onPlay`/`onStop`
   *  as this hook's auto-loop, and pausing from outside while `recording`
   *  looks like "pass reached its natural end" and just restarts the loop. */
  onPhaseChange?: (phase: TapAlongPhase) => void;
}) {
  const [phase, setPhase] = useState<TapAlongPhase>('idle');
  const [countdownTick, setCountdownTick] = useState(TAP_COUNTDOWN_SECONDS);
  const [tapCount, setTapCount] = useState(0);
  const tapsRef = useRef<TapEvent[]>([]);
  const passRef = useRef(0);
  const armedRef = useRef(false);
  const playheadStepRef = useRef(playheadStep);
  useEffect(() => { playheadStepRef.current = playheadStep; }, [playheadStep]);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const onPhaseChangeRef = useRef(onPhaseChange);
  useEffect(() => { onPhaseChangeRef.current = onPhaseChange; }, [onPhaseChange]);
  useEffect(() => { onPhaseChangeRef.current?.(phase); }, [phase]);

  const subbeats = Math.max(1, Math.round(subbeatsPerBeat) || PATTERN_SUBBEATS_PER_BEAT);
  const numBeats = Math.max(1e-6, stepsPerCycle / subbeats);
  /** Raw-press mode: the session commits presses, not chips (a boundary
   *  node — see `onSaveTaps`), so a hold is measured in real time rather
   *  than in grid steps. */
  const rawHolds = onSaveTaps != null;

  const previewPatch = useMemo(
    () => (tapsRef.current.length > 0
      ? quantizeTapsAt(tapsRef.current, numBeats, subbeats)
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputes off tapCount as a proxy for tapsRef mutating
    [tapCount, numBeats, subbeats],
  );
  const tapEvents = useMemo(
    () => tapsRef.current.slice(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputes off tapCount as a proxy for tapsRef mutating
    [tapCount],
  );

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  // Shared by `start` (fresh session) and the auto-loop effect below (next
  // pass of an already-running session) — runs the 3-2-1 count-in, then
  // pre-rolled playback, then arms tap capture, then drops into `recording`.
  // Doesn't touch `tapsRef`/`passRef`/`tapCount`: callers decide what (if
  // anything) to reset before invoking it. `showCountdown` is false for every
  // pass after the first in a session: the user is already tapping in time
  // by then, so re-showing the 3-2-1 visual each loop would just be a
  // recurring interruption — audio restarts and capture re-arms immediately
  // instead.
  const runCountdown = useCallback((showCountdown: boolean = true) => {
    armedRef.current = false;
    clearTimers();
    if (!showCountdown) {
      onPlay?.(TAP_PREROLL_SECONDS);
      armedRef.current = true;
      setPhase('recording');
      return;
    }
    setPhase('countdown');
    setCountdownTick(TAP_COUNTDOWN_SECONDS);
    for (let s = TAP_COUNTDOWN_SECONDS - 1; s >= 1; s--) {
      timersRef.current.push(setTimeout(() => setCountdownTick(s), (TAP_COUNTDOWN_SECONDS - s) * 1000));
    }
    timersRef.current.push(setTimeout(() => {
      onPlay?.(TAP_PREROLL_SECONDS);
    }, (TAP_COUNTDOWN_SECONDS - TAP_PREROLL_SECONDS) * 1000));
    timersRef.current.push(setTimeout(() => {
      armedRef.current = true;
    }, (TAP_COUNTDOWN_SECONDS - TAP_ARM_LEAD_SECONDS) * 1000));
    timersRef.current.push(setTimeout(() => setPhase('recording'), TAP_COUNTDOWN_SECONDS * 1000));
  }, [clearTimers, onPlay]);

  /** Beat position (and pass) where a currently-held Space/Enter/click-drag
   *  started — set by `beginHold`, consumed and cleared by `endHold`. Null
   *  whenever no press is in flight. */
  const holdRef = useRef<{ beat: number; pass: number } | null>(null);

  const start = useCallback(() => {
    tapsRef.current = [];
    passRef.current = 0;
    holdRef.current = null;
    setTapCount(0);
    // A focused text field (the Name input autofocuses when a Node popup
    // opens) would otherwise eat every Space as a literal space character
    // instead of a tap — clear focus so the window-level key listener below
    // is the only thing that sees it.
    if (typeof document !== 'undefined') {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    }
    runCountdown();
  }, [runCountdown]);

  /** Marks the start of a held press — paired with `endHold` below to
   *  capture a sustained span instead of a lone point. */
  const beginHold = useCallback(() => {
    if (!armedRef.current) return;
    const step = playheadStepRef.current;
    if (step == null) return; // this node isn't the one sounding right now
    holdRef.current = { beat: step / subbeats, pass: passRef.current };
  }, [subbeats]);

  /** Ends a press started by `beginHold`.
   *
   *  On a **grid** node a hold only counts once the playhead crossed into
   *  another step — a chip grid has no way to draw anything shorter, so a
   *  brief press records as a plain point, same as before holding was
   *  supported. On a **boundary** node (`onSaveTaps`, i.e. raw presses) the
   *  press and the release ARE the block: every hold keeps its own release,
   *  however short, and nothing is measured against a grid. That's the whole
   *  contract there — press = start, release = end, no length invented for
   *  the user.
   *
   *  Two releases can't be read off the playhead: one that lands after the
   *  pass looped (the position has wrapped back near 0) and one taken while
   *  this node isn't sounding at all. Both mean the key was still down when
   *  the node ended, so they close at the node's end rather than folding
   *  into a point hit that would then be given a default length. */
  const endHold = useCallback(() => {
    const held = holdRef.current;
    holdRef.current = null;
    if (!held) return;
    const step = playheadStepRef.current;
    const endBeat = step != null ? step / subbeats : held.beat;
    let event: TapEvent;
    if (rawHolds) {
      const end = endBeat > held.beat ? endBeat : numBeats;
      event = { beat: held.beat, endBeat: Math.max(end, held.beat + MIN_HELD_TAP_BEATS), pass: held.pass };
    } else {
      event = Math.round(endBeat * subbeats) !== Math.round(held.beat * subbeats)
        ? { beat: held.beat, endBeat, pass: held.pass }
        : { beat: held.beat, pass: held.pass };
    }
    tapsRef.current = [...tapsRef.current, event];
    setTapCount(tapsRef.current.length);
  }, [subbeats, rawHolds, numBeats]);

  /** Instant point tap — used by the click button (mousedown+up collapse
   *  into a single `onClick`, so there's no hold duration to measure). */
  const tap = useCallback(() => {
    if (!armedRef.current) return;
    const step = playheadStepRef.current;
    if (step == null) return; // this node isn't the one sounding right now
    tapsRef.current = [...tapsRef.current, { beat: step / subbeats, pass: passRef.current }];
    setTapCount(tapsRef.current.length);
  }, [subbeats]);

  /** Places a tap at an exact grid step by clicking (or click-dragging) it
   *  directly on `BeatChipPicker`, instead of pressing Space in time with
   *  the beat — for nailing a hit the ear/hand missed, or building the
   *  pattern by eye while the loop plays. `endStep`, when given (a
   *  click-drag to a different cell before release), records a sustained
   *  span instead of a point tap, same as holding Space across beats does.
   *  Unlike `tap`/`beginHold`, doesn't read the live playhead at all (the
   *  beat comes from whichever cell(s) were clicked), so it works even when
   *  `playheadStep` is null, but still only while a pass is actually
   *  `recording` — before that there's no take for the tap to land in. */
  const tapAtStep = useCallback((step: number, endStep?: number) => {
    if (phase !== 'recording') return;
    const event: TapEvent = endStep != null && endStep !== step
      ? { beat: step / subbeats, endBeat: endStep / subbeats, pass: passRef.current }
      : { beat: step / subbeats, pass: passRef.current };
    tapsRef.current = [...tapsRef.current, event];
    setTapCount(tapsRef.current.length);
  }, [phase, subbeats]);

  /** Manual Stop — ends the loop (without discarding taps) and drops into
   *  the Retry/Save/Cancel review step. */
  const finishPass = useCallback(() => {
    clearTimers();
    armedRef.current = false;
    holdRef.current = null;
    onStop?.();
    setPhase('review');
  }, [clearTimers, onStop]);

  const retry = useCallback(() => { start(); }, [start]);

  /** Commits the accumulated taps and ends the session — from ANY phase, not
   *  just `review`: closing the card is a save (see NodeEditPopover's close
   *  guard), and that can happen mid-pass with the loop still running, so this
   *  does `finishPass`'s teardown (timers, disarm, stop playback) itself
   *  rather than assuming Stop was pressed first. Harmless when it was: the
   *  player is already paused and the timers already cleared. */
  const save = useCallback(() => {
    clearTimers();
    armedRef.current = false;
    holdRef.current = null;
    onStop?.();
    if (tapsRef.current.length > 0) {
      if (onSaveTaps) onSaveTaps(tapsRef.current, numBeats);
      else onChange?.(tapsToPatch(tapsRef.current, numBeats));
    }
    tapsRef.current = [];
    setTapCount(0);
    setPhase('idle');
  }, [clearTimers, numBeats, onChange, onSaveTaps, onStop]);

  const cancel = useCallback(() => {
    clearTimers();
    armedRef.current = false;
    holdRef.current = null;
    onStop?.();
    tapsRef.current = [];
    setTapCount(0);
    setPhase('idle');
  }, [clearTimers, onStop]);

  // Auto-loop: once a pass is underway and `recording`, every time playback
  // reaches its natural end (the only kind either preview mechanism has) fire
  // it again with the same pre-roll instead of stopping, so the node repeats
  // until the user hits Stop. Each restart opens a new "pass" — taps keep
  // landing in the same accumulated set, just tagged with which lap they
  // came from for the piano-roll view. No visual 3-2-1 here — that's only
  // for the session's first pass (see `runCountdown`'s `showCountdown`).
  const wasPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (wasPlayingRef.current && !isPlaying && phase === 'recording') {
      passRef.current += 1;
      runCountdown(false);
    }
    wasPlayingRef.current = isPlaying;
  }, [isPlaying, phase, runCountdown]);

  // Space/Enter register a tap from anywhere — the whole point is tapping
  // the keyboard without needing mouse focus on any particular element. A
  // quick press/release records a single beat; holding across the next
  // grid step's boundary records a sustained span instead (see `beginHold`
  // / `endHold`) — the same tick-vs-hold split `BeatChipPicker`'s own
  // click-vs-drag gesture uses. Guarded against stealing keystrokes from a
  // focused text field (belt and braces alongside the blur-on-start above,
  // e.g. if focus wandered back).
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'countdown') return;
    const isTapKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return false;
      const target = e.target as HTMLElement | null;
      return !(target && target.closest('input, textarea, select'));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTapKey(e)) return;
      e.preventDefault();
      // Also owns Space/Enter here: capture phase + stopImmediatePropagation
      // so the global Space=play/pause shortcut (bound on window in bubble
      // phase, see useAnnotationShortcuts) never sees this keydown — without
      // it, every tap also toggled the main player's play/stop.
      e.stopImmediatePropagation();
      // Held keys fire repeated keydowns (browser auto-repeat, ~20-30/sec) —
      // without this a single held Space would re-`beginHold` on every one
      // of those repeats, each overwriting the last and losing the true
      // press start.
      if (e.repeat) return;
      beginHold();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isTapKey(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      endHold();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, [phase, beginHold, endHold]);

  return {
    phase, countdownTick, tapCount, previewPatch, tapEvents, numBeats, subbeats, start, tap, tapAtStep, finishPass, retry, save, cancel,
  };
}

/** How far apart two taps can land and still be read as the same hit, offered
 *  on the review step. `BOUNDARY_TAP_CLUSTER_BEATS` (a 16th at 4/4) is the
 *  default; `0` folds nothing, which is what a single careful pass wants. */
const TAP_FOLD_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'off' },
  { value: 0.125, label: '1/8' },
  { value: BOUNDARY_TAP_CLUSTER_BEATS, label: '1/4' },
  { value: 1 / 3, label: '1/3' },
  { value: 0.5, label: '1/2' },
];

/** The review step's two dials for a *boundary* tap session, owned by the
 *  popover (like `snap`) so the live preview and the eventual Save use the
 *  very same values. Both defaults reproduce the behaviour from before they
 *  existed, so a session nobody touches comes out exactly as it used to.
 *
 *  Lives here, next to `useTapAlong`, because both node surfaces — the bare
 *  node popup and the sequence tree's inline node row — must refine a take
 *  the same way. */
export function useBoundaryTapRefine() {
  const [clusterBeats, setClusterBeats] = useState<number>(BOUNDARY_TAP_CLUSTER_BEATS);
  const [minPasses, setMinPasses] = useState(1);
  return { clusterBeats, setClusterBeats, minPasses, setMinPasses };
}

/** Fold + vote controls for a boundary tap session, shown while one is live.
 *
 *  `fold` groups taps landing within that distance of each other into one hit
 *  at their median — what repeated passes over the same bar are. `keep` is
 *  then a vote on those groups: with a dozen passes recorded, a hit that only
 *  one pass contains is a slip, and raising `keep` drops it. Both re-render
 *  the preview immediately, so the take can be dialled in before Save. */
export function TapRefineControls({
  clusterBeats, setClusterBeats, minPasses, setMinPasses, passes,
}: ReturnType<typeof useBoundaryTapRefine> & {
  /** How many passes the take actually has — the vote can't ask for more
   *  agreement than that, which would silently empty the node. */
  passes: number;
}) {
  const maxKeep = Math.max(1, passes);
  return (
    <div className="flex items-center gap-2 text-[9px] text-slate-500">
      <label className="flex items-center gap-1" title="Taps landing within this distance of each other are the same hit, kept at their median position — how repeated passes over the same bar are folded together">
        fold
        <select
          value={clusterBeats}
          onChange={(e) => setClusterBeats(Number(e.target.value))}
          aria-label="Fold taps within, in beats"
          className="bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
        >
          {TAP_FOLD_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1" title="Keep only hits that this many passes agree on — a hit tapped in just one pass out of many is a slip, not part of the rhythm">
        keep from
        <select
          value={Math.min(minPasses, maxKeep)}
          onChange={(e) => setMinPasses(Number(e.target.value))}
          disabled={clusterBeats <= 0}
          aria-label="Keep hits tapped in at least this many passes"
          className="bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-slate-200 disabled:text-slate-600 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
        >
          {Array.from({ length: Math.min(maxKeep, 8) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n === 1 ? 'any pass' : `${n} passes`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Dumb button row for the `useTapAlong` state machine — idle "Tap Along"
 *  button → 3-2-1 count-in → a looping "SPACE to tap" indicator (with
 *  Stop/Cancel) → a Retry / Save / Cancel review step. No internal state of
 *  its own: the caller owns `useTapAlong` (so it can also feed
 *  `previewPatch` into its own `BeatChipPicker`) and passes the whole
 *  returned bag straight through here. */
export function TapAlongControls({
  phase, countdownTick, tapCount, start, tap, finishPass, retry, save, cancel, disabled, mode = 'grid',
}: ReturnType<typeof useTapAlong> & {
  disabled?: boolean;
  /** Only changes the wording: on a grid node a tap lights the nearest chip,
   *  on a boundary node it lands a block exactly where it fell. Same state
   *  machine, same buttons — see `useTapAlong`'s `onSaveTaps`. */
  mode?: 'grid' | 'boundary';
}) {
  if (phase === 'idle') {
    return (
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        className="px-2 py-1 rounded text-[10px] uppercase tracking-wider border transition-colors bg-[#0a0b0d] border-white/[0.08] text-orange-300 hover:text-orange-200 hover:border-orange-400/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-white/[0.08]"
        title={disabled
          ? 'Place this node in a sequence to preview its real audio'
          : mode === 'boundary'
          ? 'Play the real audio on a loop and tap the keyboard along with it — press Space where a hit starts, release it where the hit ends, and that press becomes the block'
          : 'Play the real audio on a loop and tap the keyboard along with it — each tap lights the closest beat'}
      >
        ⌨ Tap Along
      </button>
    );
  }

  if (phase === 'countdown') {
    return (
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full border border-orange-400/50 text-orange-200 text-[13px] font-bold tabular-nums">
          {countdownTick}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">Get ready — press Space on the beat…</span>
        <button
          type="button"
          onClick={cancel}
          className="ml-auto text-[9px] text-slate-500 hover:text-red-400 transition-colors"
          title="Cancel"
        >
          ✕
        </button>
      </div>
    );
  }

  if (phase === 'recording') {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={tap}
          className="px-2.5 py-1 rounded text-[10px] uppercase tracking-wider border bg-orange-500/25 border-orange-400/60 text-orange-100 animate-pulse hover:animate-none hover:bg-orange-500/35 transition-colors"
          title={mode === 'boundary'
            ? 'Press Space where a hit starts and release it where the hit ends — every press is one block, from the press to the release (click works too, but a click has no length) — loops until you stop'
            : 'Press Space in time with the beat, or hold it across multiple beats for a long note (click works too, tap-only) — loops until you stop'}
        >
          ⌨ SPACE to tap{tapCount > 0 ? ` (${tapCount})` : ''}
        </button>
        <button
          type="button"
          onClick={finishPass}
          className="text-[9px] text-slate-400 hover:text-slate-200 transition-colors"
          title="Stop looping and review the tapped beats"
        >
          ■ Stop
        </button>
        <button
          type="button"
          onClick={cancel}
          className="text-[9px] text-slate-500 hover:text-red-400 transition-colors"
          title="Cancel — throw these taps away (closing the card keeps them instead)"
        >
          ✕
        </button>
      </div>
    );
  }

  // review
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[9px] text-slate-400">{tapCount} tap{tapCount === 1 ? '' : 's'} captured — see them highlighted above</span>
      <button
        type="button"
        onClick={retry}
        className="px-2 py-0.5 rounded text-[9px] uppercase tracking-wider border border-white/[0.08] text-slate-300 hover:text-slate-100 hover:border-white/[0.2] transition-colors"
        title="Discard and tap again from a fresh count-in"
      >
        Retry
      </button>
      <button
        type="button"
        onClick={save}
        disabled={tapCount === 0}
        className="px-2 py-0.5 rounded text-[9px] uppercase tracking-wider border bg-orange-500/20 border-orange-400/40 text-orange-200 hover:bg-orange-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-orange-500/20"
        title="Apply the tapped beats to this node"
      >
        Save
      </button>
      <button
        type="button"
        onClick={cancel}
        className="px-2 py-0.5 rounded text-[9px] uppercase tracking-wider border border-white/[0.08] text-slate-500 hover:text-red-400 transition-colors"
        title="Discard this tap session"
      >
        Cancel
      </button>
    </div>
  );
}

/** Max loop passes shown at once — older ones scroll off the top rather than
 *  growing the strip's height forever over a long tap session. */
const TAP_PIANO_ROLL_MAX_ROWS = 6;
const TAP_PIANO_ROLL_ROW_HEIGHT = 10;

/** Raw per-tap timing view — one thin lane per loop pass, a tick mark at
 *  each tap's exact (unquantized) beat position, oldest pass on top. Separate
 *  from the quantized BEATS grid above on purpose: that grid only shows the
 *  *result* (which stepped cell won), snapped onto a fixed subdivision and
 *  stable for the whole session (see `useTapAlong`'s `previewPatch`); this
 *  strip shows the actual timing, including drift between repeated attempts
 *  at the same beat and taps that land between cells. A moving line marks
 *  the live playhead on the current (bottom, most recent) lane. */
export function TapAlongPianoRoll({
  taps, numBeats, playheadBeat, color,
}: {
  taps: TapEvent[];
  numBeats: number;
  /** Current playhead position in beats (same space as `taps[].beat`) for
   *  the live sweep line — null when not applicable (e.g. this isn't the
   *  currently-sounding node in a sequence). */
  playheadBeat: number | null;
  color: string;
}) {
  if (taps.length === 0) return null;
  // Reduce, not `Math.max(...taps.map(...))` — spreading a large array as
  // call arguments can throw a call-stack RangeError once a long session
  // accumulates enough taps.
  const passes = taps.reduce((max, t) => Math.max(max, t.pass), 0) + 1;
  const firstShown = Math.max(0, passes - TAP_PIANO_ROLL_MAX_ROWS);
  const rows = Array.from({ length: passes - firstShown }, (_, i) => firstShown + i);
  const pct = (b: number) => `${Math.max(0, Math.min(100, (b / numBeats) * 100))}%`;

  return (
    <div className="space-y-0.5">
      <div
        className="relative border border-white/[0.08] rounded bg-[#0a0b0d] overflow-hidden"
        style={{ height: rows.length * TAP_PIANO_ROLL_ROW_HEIGHT }}
      >
        {Array.from({ length: numBeats + 1 }, (_, b) => (
          <div key={b} className="absolute top-0 bottom-0 w-px bg-white/[0.08]" style={{ left: pct(b) }} />
        ))}
        {rows.map((pass, rowIdx) => (
          <div
            key={pass}
            className="absolute left-0 right-0"
            style={{ top: rowIdx * TAP_PIANO_ROLL_ROW_HEIGHT, height: TAP_PIANO_ROLL_ROW_HEIGHT }}
          >
            {taps.filter((t) => t.pass === pass).map((t, i) => {
              if (t.endBeat == null) {
                return (
                  <div
                    key={i}
                    className="absolute top-0.5 bottom-0.5 w-[3px] rounded-sm"
                    style={{ left: pct(t.beat), background: color, boxShadow: `0 0 4px ${color}` }}
                  />
                );
              }
              const lo = Math.min(t.beat, t.endBeat);
              const hi = Math.max(t.beat, t.endBeat);
              return (
                <div
                  key={i}
                  className="absolute top-0.5 bottom-0.5 rounded-sm opacity-80"
                  style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, background: color, boxShadow: `0 0 4px ${color}` }}
                />
              );
            })}
          </div>
        ))}
        {playheadBeat != null && (
          <div
            className="absolute top-0 bottom-0 w-px bg-orange-300/80"
            style={{ left: pct(playheadBeat) }}
          />
        )}
      </div>
      <div className="text-[8px] text-slate-600">
        {passes > TAP_PIANO_ROLL_MAX_ROWS ? `last ${TAP_PIANO_ROLL_MAX_ROWS} of ${passes} passes` : `${passes} pass${passes === 1 ? '' : 'es'}`}
        {' '}· raw timing, top→bottom oldest→newest
      </div>
    </div>
  );
}

// ─── ChipStrip (read-only beat grid, drawn inside a canvas tile) ────────────

/** Renders the sub-beat chips inside a tile. `beatsPerBar × 4` mini bars span
 *  the tile width; highlighted sub-beats are full-opacity, others are dim. A
 *  small gap every PATTERN_SUBBEATS_PER_BEAT marks beat boundaries so the
 *  pulse stays readable at small tile widths. Steps inside a held `span` render
 *  as one continuous bar (the inner gaps are suppressed) so a hold reads as a
 *  single sustained accent. The label, when present, sits on the left and
 *  truncates. Read-only — RiffPatternLaneRow draws a Riff Node's own beat grid
 *  with it instead of a flat color block. */
export function ChipStrip({ color, steps, highlighted, spans, label, accents }: {
  color: string; steps: number; highlighted: number[]; spans: [number, number][]; label: string;
  /** step -> 1..127. A step with no entry draws at full strength. */
  accents?: Record<number, number>;
}) {
  const hSet = new Set(highlighted);
  // index → role within its span, so we can drop the inner gaps of a hold.
  const spanRole = new Map<number, 'start' | 'mid' | 'end'>();
  for (const [s, l] of spans) {
    for (let k = 0; k < l; k++) spanRole.set(s + k, k === 0 ? 'start' : k === l - 1 ? 'end' : 'mid');
  }
  return (
    <span className="flex items-stretch w-full h-full pointer-events-none select-none">
      {label && (
        <span
          className="text-[10px] truncate text-white/90 leading-none px-1 self-center max-w-[40%]"
          style={{ textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
        >
          {label}
        </span>
      )}
      {/* Bottom-aligned, not stretched: a measured step draws as a bar whose
          HEIGHT is how hard it was hit, standing on the floor of the row like
          a piano roll's velocity lane. Unmeasured and empty steps stay full
          height, so a hand-drawn node looks exactly as it always did. */}
      <span className="flex-1 flex items-end py-0.5 pr-0.5 pl-0.5">
        {Array.from({ length: steps }, (_, i) => {
          const role = spanRole.get(i);
          const inSpan = role !== undefined;
          const on = hSet.has(i) || inSpan;
          const isLastInBeat = (i % PATTERN_SUBBEATS_PER_BEAT) === PATTERN_SUBBEATS_PER_BEAT - 1;
          const isLast = i === steps - 1;
          // A hold suppresses the 1px inter-chip gap between its own steps so
          // the run looks continuous; the per-chip gap is otherwise 1px, and a
          // 2px beat-boundary gap is added at the end of each beat.
          const gapAfterSpan = inSpan && role !== 'end'; // still inside the hold
          const marginRight = gapAfterSpan
            ? 0
            : (isLast ? 0 : (isLastInBeat ? 2 : 1));
          const radius = inSpan
            ? (role === 'start' ? '2px 0 0 2px' : role === 'end' ? '0 2px 2px 0' : '0')
            : '1px';
          return (
            <span
              key={i}
              style={{
                flex: 1,
                background: on ? color : `${color}33`,
                // How hard the step was struck, when a detector measured it.
                // Height carries it and opacity reinforces it; both apply only
                // to a step that is ON, so neither can be mistaken for empty.
                height: on ? `${accentHeight(accents?.[i]) * 100}%` : '100%',
                opacity: on ? accentOpacity(accents?.[i]) : undefined,
                boxShadow: on ? `0 0 3px ${color}` : undefined,
                minWidth: 1,
                marginRight,
                borderRadius: radius,
              }}
            />
          );
        })}
      </span>
    </span>
  );
}
