/**
 * BeatChipControls — the Tap Along machinery shared by every surface that
 * edits a riff node: it records live presses against the playing audio, and
 * the caller writes them into the node as notes (`boundarySegmentsFromTaps`).
 *
 * Consumers: the riff-pattern node editor (RiffPatternEditorPanel /
 * NodeEditPopover / RiffPatternEditPopover) and the boundary tap-refine flow.
 * Kept in one module on purpose — a per-surface fork of useTapAlong /
 * TapAlongControls drifts, and the two surfaces must behave identically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BOUNDARY_MIN_SEGMENT_BEATS,
  BOUNDARY_TAP_CLUSTER_BEATS,
  PATTERN_SUBBEATS_PER_BEAT,
} from '../../types/annotationLayer';

// ─── Tap Along ──────────────────────────────────────────────────────────────
//
// Lets the user tap in time with a node's real audio instead of placing notes
// by hand — press Tap Along, a 3-2-1 count-in leads into the node looping
// again and again, tap the keyboard (Space) on each hit across as many passes
// as needed watching them land live, then Retry / Save / Cancel the captured
// take. Shared by NodeEditPopover (a bare node's own floating popup) and the
// inline node view inside RiffPatternEditPopover's sequence tree —
// `useTapAlong` owns the capture state, `TapAlongControls` is the dumb button
// row, and the caller draws `tapEvents` as the notes they would become.

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

export type TapAlongPhase = 'idle' | 'countdown' | 'recording' | 'review';

/** Tap-along capture state machine. Samples `playheadStep` — the same
 *  fractional position that drives the node editor's karaoke sweep — at the
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
 *  explicit Cancel (✕) throws a session away. Exposes `tapEvents` (each tap's
 *  raw, unquantized beat position plus which loop pass it happened in), for
 *  the live preview and for a raw-timing view like `TapAlongPianoRoll`. */
export function useTapAlong({
  stepsPerCycle, subbeatsPerBeat, playheadStep, isPlaying, onPlay, onStop, onSaveTaps, onPhaseChange,
}: {
  stepsPerCycle: number;
  subbeatsPerBeat: number;
  playheadStep: number | null;
  isPlaying?: boolean;
  onPlay?: (preRollSec?: number) => void;
  onStop?: () => void;
  /** Commits a finished session as its RAW presses — fractional beat
   *  positions, each with the duration it was held for, nothing rounded here.
   *  The caller writes them into the node (`boundarySegmentsFromTaps`). */
  onSaveTaps: (taps: TapEvent[], numBeats: number) => void;
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

  /** Ends a press started by `beginHold`. The press and the release ARE the
   *  note: every hold keeps its own release, however short, and nothing is
   *  measured against a grid here — press = start, release = end, no length
   *  invented for the user.
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
    const end = endBeat > held.beat ? endBeat : numBeats;
    const event: TapEvent = { beat: held.beat, endBeat: Math.max(end, held.beat + MIN_HELD_TAP_BEATS), pass: held.pass };
    tapsRef.current = [...tapsRef.current, event];
    setTapCount(tapsRef.current.length);
  }, [subbeats, numBeats]);

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
    if (tapsRef.current.length > 0) onSaveTaps(tapsRef.current, numBeats);
    tapsRef.current = [];
    setTapCount(0);
    setPhase('idle');
  }, [clearTimers, numBeats, onSaveTaps, onStop]);

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
  // press records where the hit starts and the release where it ends (see
  // `beginHold` / `endHold`). Guarded against stealing keystrokes from a
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
    phase, countdownTick, tapCount, tapEvents, numBeats, subbeats, start, tap, tapAtStep, finishPass, retry, save, cancel,
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
 *  its own: the caller owns `useTapAlong` (so it can also draw its
 *  `tapEvents`) and passes the whole returned bag straight through here. */
export function TapAlongControls({
  phase, countdownTick, tapCount, start, tap, finishPass, retry, save, cancel, disabled,
}: ReturnType<typeof useTapAlong> & {
  disabled?: boolean;
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
          : 'Play the real audio on a loop and tap the keyboard along with it — press Space where a hit starts, release it where the hit ends, and that press becomes the note'}
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
          title="Press Space where a hit starts and release it where the hit ends — every press is one note, from the press to the release (click works too, but a click has no length) — loops until you stop"
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

