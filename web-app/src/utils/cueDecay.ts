/** Keyboard steps for a cue's decay, in seconds: an arrow on the focused nub
 *  (or `.` / `,` with a cue selected) moves it by the fine step, Shift by the
 *  coarse one. Not grid steps — decay is a length, and the drag doesn't snap
 *  either. */
export const DECAY_STEP_FINE_SEC = 0.01;
export const DECAY_STEP_COARSE_SEC = 0.1;

/** The decay after one keyboard step. A cue with none starts from the tick;
 *  stepping back onto the tick (or past it) clears the decay, exactly as
 *  dragging the nub back onto it does, and the tail never runs past `room`
 *  (the time left in the song). Rounded to the millisecond, as the drag is. */
export function stepCueDecay(current: number | undefined, delta: number, room: number): number | undefined {
  const next = Math.round(((current ?? 0) + delta) * 1000) / 1000;
  if (next <= 0) return undefined;
  return room > 0 ? Math.min(next, room) : next;
}

/** How a decay reads beside its nub and in the shortcut feedback. */
export function decayReadout(decay: number | undefined): string {
  return decay === undefined ? 'no decay' : `decay ${Math.round(decay * 1000)} ms`;
}
