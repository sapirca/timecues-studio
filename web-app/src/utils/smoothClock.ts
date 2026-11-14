/**
 * A playhead that moves evenly, for surfaces that magnify it.
 *
 * The media clock the player reads does not advance smoothly: it moves in
 * audio-buffer steps, so from one ~16 ms frame to the next it reports 5, 13,
 * 22 or 27 ms of progress (measured on Chrome, 2026-09-25). On the timeline
 * lanes that is a fraction of a pixel. The hit karaoke spreads four seconds
 * over the panel's width — ~470 px a second — where the same jitter throws
 * every tick back and forth by ~5 px a frame, and the panel looks like it is
 * jumping.
 *
 * The smoother runs its own line instead: shown time advances with the wall
 * clock at the rate the media clock has kept since the last snap, and leans a
 * tenth of the way towards each reading, so it tracks the audio without its
 * steps. Anything that is not steady playback — a seek, a pause, a speed
 * change, a stall of more than 100 ms between readings — snaps it back to
 * the reading, so it never shows a position the audio is not near.
 *
 * Only for drawing. Anything that decides against the audio (a seek target,
 * a preview's end) reads the real clock.
 */

/** Further off than this and the reading is a jump, not jitter. */
const SNAP_S = 0.1;
/** A gap this long between readings means playback stopped or stalled. */
const STALL_MS = 100;
/** How long a run of readings has to be before its rate is trusted; until
 *  then the smoother shows the readings as they come. */
const WARMUP_MS = 200;
/** Share of the remaining error taken up per reading. */
const PULL = 0.1;

export type ClockSmoother = (raw: number, wallMs: number) => number;

export function createClockSmoother(): ClockSmoother {
  let anchorT = NaN;
  let anchorW = 0;
  let shownT = NaN;
  let shownW = 0;

  const snap = (raw: number, wall: number) => {
    anchorT = raw; anchorW = wall;
    shownT = raw; shownW = wall;
    return raw;
  };

  return (raw, wall) => {
    const gap = wall - shownW;
    if (!Number.isFinite(shownT) || gap <= 0 || gap > STALL_MS) return snap(raw, wall);
    const span = wall - anchorW;
    if (span < WARMUP_MS) {
      // No rate yet. A reading that runs backwards, or further ahead than any
      // playback speed could carry it, starts the run over.
      if (raw < shownT - 1e-3 || raw - shownT > SNAP_S + (gap / 1000) * 4) return snap(raw, wall);
      shownT = raw; shownW = wall;
      return raw;
    }
    const rate = (raw - anchorT) / (span / 1000);
    const predicted = shownT + (gap / 1000) * rate;
    const err = raw - predicted;
    if (!(rate > 0) || Math.abs(err) > SNAP_S) return snap(raw, wall);
    shownT = predicted + err * PULL;
    shownW = wall;
    return shownT;
  };
}
