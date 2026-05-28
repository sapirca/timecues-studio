/**
 * Tap-tempo reducer. Pure, framework-agnostic — the panel feeds in
 * `performance.now()` and renders whatever comes back. Mirrors Rekordbox's
 * manual tap behaviour: the buffer is never cleared by idle time. Instead a
 * tap whose interval drifts more than 30% from the running average is treated
 * as the first beat of a new tempo and the buffer restarts from that tap.
 * BPM is recomputed and stored on every accepted tap so callers can stream
 * the value back to the engine without a separate "Apply" step.
 */

/** Ignore taps closer together than this — guards against accidental double
 *  clicks and key-repeat. 240 ms ≈ 250 BPM, faster than any legitimate tap. */
export const TAP_DEBOUNCE_MS = 240;
/** Rolling window length. 5 taps ≈ 4 intervals: enough to smooth human jitter,
 *  short enough to react when the user re-locks onto a new beat. */
export const MAX_TAP_HISTORY = 5;

/** Fraction the new interval may drift from the running average before we
 *  decide the user has switched tempos and restart the buffer. */
const DEVIATION_THRESHOLD = 0.30;
/** DJ-oriented sanity range. Outside this band the user almost certainly
 *  tapped every other beat (slow) or half-beat (fast); we keep the previous
 *  estimate rather than push a nonsense value to the engine. */
const MIN_VALID_BPM = 60;
const MAX_VALID_BPM = 240;

export interface TapTempoState {
  /** Tap timestamps in ms (performance.now-style), oldest first. */
  readonly taps: readonly number[];
  /** Last in-range BPM produced by the buffer. Preserved across debounce
   *  drops and deviation resets so the engine doesn't snap back to null. */
  readonly currentBpm: number | null;
}

export const emptyTapTempoState: TapTempoState = { taps: [], currentBpm: null };

/** Feed in a tap; get back the next state. Pure — same `(state, now)` always
 *  returns the same result, which keeps it safe inside a React state-updater
 *  under StrictMode double-invocation. */
export function applyTap(state: TapTempoState, now: number): TapTempoState {
  const { taps, currentBpm } = state;

  if (taps.length === 0) {
    return { taps: [now], currentBpm };
  }

  const lastTap = taps[taps.length - 1];
  const newInterval = now - lastTap;

  if (newInterval < TAP_DEBOUNCE_MS) {
    return state;
  }

  if (taps.length >= 2) {
    let intervalSum = 0;
    for (let i = 1; i < taps.length; i++) intervalSum += taps[i] - taps[i - 1];
    const avgInterval = intervalSum / (taps.length - 1);
    if (avgInterval > 0 && Math.abs(newInterval - avgInterval) / avgInterval > DEVIATION_THRESHOLD) {
      return { taps: [now], currentBpm };
    }
  }

  const nextTaps = taps.length >= MAX_TAP_HISTORY
    ? [...taps.slice(-(MAX_TAP_HISTORY - 1)), now]
    : [...taps, now];

  let sum = 0;
  for (let i = 1; i < nextTaps.length; i++) sum += nextTaps[i] - nextTaps[i - 1];
  const avg = sum / (nextTaps.length - 1);

  if (!Number.isFinite(avg) || avg <= 0) {
    return { taps: nextTaps, currentBpm };
  }

  const rounded = Math.round(60000 / avg);
  const nextBpm = rounded >= MIN_VALID_BPM && rounded <= MAX_VALID_BPM ? rounded : currentBpm;

  return { taps: nextTaps, currentBpm: nextBpm };
}
