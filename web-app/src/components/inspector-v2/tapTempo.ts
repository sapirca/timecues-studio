/**
 * Tap-tempo reducer. Pure, framework-agnostic — the panel feeds in
 * `performance.now()` and renders whatever comes back. Mirrors Rekordbox's
 * manual tap behaviour: the buffer is never cleared by idle time.
 *
 * Stability is the priority. While the buffer is still filling we keep a loose
 * tolerance so the user can re-lock onto a new song's beat. Once the buffer is
 * *settled* (enough taps to trust the average) we tighten the tolerance and
 * treat a single off-tempo tap as a slip — it is rejected, not acted on — so
 * one stray tap can't fling the BPM from 135 to 72. Only a *second*, confirming
 * off-tempo tap restarts the buffer onto the new tempo.
 *
 * BPM is recomputed and stored on every accepted tap so callers can stream the
 * value back to the engine without a separate "Apply" step.
 */

/** Ignore taps closer together than this — guards against accidental double
 *  clicks and key-repeat. 240 ms ≈ 250 BPM, faster than any legitimate tap. */
export const TAP_DEBOUNCE_MS = 240;
/** Rolling window length. 8 taps ≈ 7 intervals: long enough to settle into a
 *  steady average that absorbs human jitter without the estimate lurching. */
export const MAX_TAP_HISTORY = 8;

/** Tolerance while the buffer is still filling: a tap may drift this far from
 *  the running average before we treat it as a new tempo. Loose, so switching
 *  songs re-locks quickly. */
const DEVIATION_THRESHOLD_OPEN = 0.30;
/** Tolerance once the buffer is settled. Tighter, so a stray tap is rejected as
 *  a slip rather than dragging the locked estimate around. */
const DEVIATION_THRESHOLD_SETTLED = 0.15;
/** A buffer with at least this many taps is "settled": we trust its average and
 *  start rejecting off-tempo slips (pending a confirming second tap). */
const SETTLED_TAP_COUNT = 4;
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
  /** Timestamp of a settled-buffer off-tempo tap awaiting confirmation. While
   *  set, the locked estimate is held; a second off-tempo tap restarts onto the
   *  (pending, now) tempo, an in-tempo tap clears it as a one-off slip. */
  readonly pending: number | null;
}

export const emptyTapTempoState: TapTempoState = { taps: [], currentBpm: null, pending: null };

function bpmFromInterval(intervalMs: number): number {
  return Math.round(60000 / intervalMs);
}

/** Feed in a tap; get back the next state. Pure — same `(state, now)` always
 *  returns the same result, which keeps it safe inside a React state-updater
 *  under StrictMode double-invocation. */
export function applyTap(state: TapTempoState, now: number): TapTempoState {
  const { taps, currentBpm, pending } = state;

  if (taps.length === 0) {
    return { taps: [now], currentBpm, pending: null };
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
    const settled = taps.length >= SETTLED_TAP_COUNT;
    const threshold = settled ? DEVIATION_THRESHOLD_SETTLED : DEVIATION_THRESHOLD_OPEN;

    if (avgInterval > 0 && Math.abs(newInterval - avgInterval) / avgInterval > threshold) {
      // Off-tempo tap. On a settled buffer, the first one is a slip: hold the
      // locked estimate and remember the tap, but don't act on it yet.
      if (settled && pending == null) {
        return { taps, currentBpm, pending: now };
      }
      // We're either still filling, or a previous tap already flagged a switch.
      // If a pending tap is waiting and this tap lands at a consistent new
      // tempo, restart the buffer onto that pair; otherwise restart from here.
      if (pending != null) {
        const pendInterval = now - pending;
        const pendBpm = bpmFromInterval(pendInterval);
        if (pendInterval >= TAP_DEBOUNCE_MS && pendBpm >= MIN_VALID_BPM && pendBpm <= MAX_VALID_BPM) {
          return { taps: [pending, now], currentBpm: pendBpm, pending: null };
        }
      }
      return { taps: [now], currentBpm, pending: null };
    }
  }

  // In-tempo tap: any pending slip was noise, so clear it and extend the buffer.
  const nextTaps = taps.length >= MAX_TAP_HISTORY
    ? [...taps.slice(-(MAX_TAP_HISTORY - 1)), now]
    : [...taps, now];

  let sum = 0;
  for (let i = 1; i < nextTaps.length; i++) sum += nextTaps[i] - nextTaps[i - 1];
  const avg = sum / (nextTaps.length - 1);

  if (!Number.isFinite(avg) || avg <= 0) {
    return { taps: nextTaps, currentBpm, pending: null };
  }

  const rounded = bpmFromInterval(avg);
  const nextBpm = rounded >= MIN_VALID_BPM && rounded <= MAX_VALID_BPM ? rounded : currentBpm;

  return { taps: nextTaps, currentBpm: nextBpm, pending: null };
}
