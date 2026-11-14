/**
 * Tap-tempo reducer. Pure, framework-agnostic — the panel feeds in
 * `performance.now()` and renders whatever comes back.
 *
 * Every tap of the current sequence counts. Each accepted tap gets a beat
 * number (0, 1, 2, …) and the tempo is the slope of the least-squares line
 * through (beat, time): every tap pulls on it, so the estimate keeps tightening
 * the longer the user taps — its error falls as n^-1.5 — instead of a sliding
 * average of gaps, which only ever sees the window's first and last tap.
 *
 * Stability is the priority. While the sequence is short a tap may land well
 * off the line, so the user can lock onto a new beat. Once it is *settled* the
 * tolerance tightens and a single off-line tap is a slip — held, not acted on —
 * so one stray tap can't fling the BPM from 135 to 72. Whether a tap is off is
 * judged against where the line puts the next beat, never against the previous
 * tap, so a late tap followed by an on-time one is one slip, not a new tempo.
 * Only a *second*, confirming off-line tap restarts onto the new tempo.
 *
 * A pause longer than the slowest valid beat starts a fresh sequence: a gap
 * that long is not a beat, so it can only mean the user stopped.
 *
 * BPM is recomputed and stored on every accepted tap so callers can stream the
 * value back to the engine without a separate "Apply" step.
 */

/** Ignore taps closer together than this — guards against accidental double
 *  clicks and key-repeat. 240 ms ≈ 250 BPM, faster than any legitimate tap. */
export const TAP_DEBOUNCE_MS = 240;

/** Tolerance while the sequence is short, as a fraction of a beat: a tap may
 *  land this far from the line's next beat before we treat it as a new tempo.
 *  Loose, so switching songs re-locks quickly. */
const DEVIATION_THRESHOLD_OPEN = 0.30;
/** Tolerance once the sequence is settled. Tighter, so a stray tap is rejected
 *  as a slip rather than dragging the locked estimate around. */
const DEVIATION_THRESHOLD_SETTLED = 0.15;
/** A sequence with at least this many taps is "settled": we trust its line and
 *  start rejecting off-tempo slips (pending a confirming second tap). */
const SETTLED_TAP_COUNT = 4;
/** DJ-oriented sanity range. Outside this band the user almost certainly
 *  tapped every other beat (slow) or half-beat (fast); we keep the previous
 *  estimate rather than push a nonsense value to the engine. */
const MIN_VALID_BPM = 60;
const MAX_VALID_BPM = 240;
/** A gap longer than one beat at MIN_VALID_BPM (1 s) ends the sequence: the
 *  tap after it is the first of a new one and every earlier tap is dropped. */
export const TAP_RESTART_GAP_MS = 60000 / MIN_VALID_BPM;

export interface TapTempoState {
  /** Accepted tap timestamps of the current sequence in ms
   *  (performance.now-style), oldest first. */
  readonly taps: readonly number[];
  /** Beat number of each accepted tap, parallel to `taps`. Consecutive taps
   *  are one beat apart unless the user skipped a beat. */
  readonly beats: readonly number[];
  /** Last in-range BPM produced by the sequence. Preserved across debounce
   *  drops and restarts so the engine doesn't snap back to null. */
  readonly currentBpm: number | null;
  /** Timestamp of a settled-sequence off-line tap awaiting confirmation. While
   *  set, the locked estimate is held; a second off-line tap restarts onto the
   *  (pending, now) tempo, an on-line tap clears it as a one-off slip. */
  readonly pending: number | null;
}

export const emptyTapTempoState: TapTempoState = { taps: [], beats: [], currentBpm: null, pending: null };

function bpmFromInterval(intervalMs: number): number {
  return Math.round(60000 / intervalMs);
}

function inRange(bpm: number): boolean {
  return bpm >= MIN_VALID_BPM && bpm <= MAX_VALID_BPM;
}

/** Least-squares line time = origin + period · beat. Times are taken relative
 *  to the first tap so the sums stay small. */
function fitLine(taps: readonly number[], beats: readonly number[]): { origin: number; period: number } {
  const n = taps.length;
  const t0 = taps[0];
  let kMean = 0;
  let tMean = 0;
  for (let i = 0; i < n; i++) { kMean += beats[i]; tMean += taps[i] - t0; }
  kMean /= n;
  tMean /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dk = beats[i] - kMean;
    sxy += dk * (taps[i] - t0 - tMean);
    sxx += dk * dk;
  }
  const period = sxy / sxx;
  return { origin: t0 + tMean - period * kMean, period };
}

function startSequence(now: number, currentBpm: number | null): TapTempoState {
  return { taps: [now], beats: [0], currentBpm, pending: null };
}

/** A two-tap sequence: one interval, read straight off. */
function startPair(first: number, now: number, currentBpm: number | null): TapTempoState {
  const bpm = bpmFromInterval(now - first);
  return { taps: [first, now], beats: [0, 1], currentBpm: inRange(bpm) ? bpm : currentBpm, pending: null };
}

/** Feed in a tap; get back the next state. Pure — same `(state, now)` always
 *  returns the same result, which keeps it safe inside a React state-updater
 *  under StrictMode double-invocation. */
export function applyTap(state: TapTempoState, now: number): TapTempoState {
  const { taps, beats, currentBpm, pending } = state;

  if (taps.length === 0) return startSequence(now, currentBpm);

  const lastTap = taps[taps.length - 1];
  const latest = pending != null && pending > lastTap ? pending : lastTap;
  const sinceLatest = now - latest;

  if (sinceLatest < TAP_DEBOUNCE_MS) return state;
  if (sinceLatest > TAP_RESTART_GAP_MS) return startSequence(now, currentBpm);

  if (taps.length === 1) return startPair(lastTap, now, currentBpm);

  const { origin, period } = fitLine(taps, beats);
  const lastBeat = beats[beats.length - 1];
  // The beat this tap is aiming for: the nearest one on the line, and never at
  // or before the last accepted beat (an early tap still means "next beat").
  const beat = Math.max(lastBeat + 1, Math.round((now - origin) / period));
  const offBy = Math.abs(now - (origin + period * beat)) / period;
  const settled = taps.length >= SETTLED_TAP_COUNT;
  const threshold = settled ? DEVIATION_THRESHOLD_SETTLED : DEVIATION_THRESHOLD_OPEN;

  if (offBy > threshold) {
    // Off the line. On a settled sequence, the first one is a slip: hold the
    // locked estimate and remember the tap, but don't act on it yet.
    if (settled && pending == null) return { ...state, pending: now };
    // A pending tap is waiting too: two in a row is a new tempo, so restart
    // onto that pair. Still filling: restart from here.
    if (pending != null && now - pending >= TAP_DEBOUNCE_MS) return startPair(pending, now, currentBpm);
    return startSequence(now, currentBpm);
  }

  // On the line: any pending slip was noise. Extend the sequence and refit.
  const nextTaps = [...taps, now];
  const nextBeats = [...beats, beat];
  const bpm = bpmFromInterval(fitLine(nextTaps, nextBeats).period);
  return { taps: nextTaps, beats: nextBeats, currentBpm: inRange(bpm) ? bpm : currentBpm, pending: null };
}
