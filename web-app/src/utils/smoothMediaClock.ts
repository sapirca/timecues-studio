/**
 * A media clock that advances by the same amount every frame.
 *
 * `HTMLMediaElement.currentTime` does not move evenly. Chrome advances it per
 * audio-render callback and caches it across a task, so frame-by-frame reads
 * during playback go +0 ms, +21 ms, +12 ms, +17 ms… instead of +16.7 ms each.
 * At fit zoom that is a fraction of a pixel. Zoomed in, the follow-scroll is
 * tied to it — at ×16 a frame of song is ~6 px — and the uneven steps show as
 * the waveform and every lane under it juddering, frame by frame, while the
 * playhead holds still.
 *
 * So the time shown is extrapolated from wall time (`performance.now()` ×
 * playback rate) from an anchor, and each raw reading only pulls that anchor a
 * little: the jitter averages out, real drift is followed within a fraction of
 * a second, and anything bigger than jitter (a seek, a loop wrap, a stall) is
 * taken at once.
 */

/** A raw reading this far from the prediction is a jump, not jitter. */
const JUMP_S = 0.1;
/** Share of each reading's error taken into the anchor (~20-frame settle). */
const PULL = 0.05;

export interface SmoothMediaClock {
  /** Feed a raw reading taken at `now` (ms); returns the time to show. */
  sample(raw: number, now: number, rate: number): number;
  /** Forget the anchor: the next reading is taken as-is (seek, pause). */
  reset(): void;
}

export function createSmoothMediaClock(): SmoothMediaClock {
  let anchorTime = NaN;
  let anchorAt = 0;
  let anchorRate = 1;
  // The raw reading the anchor was taken from, until the clock is seen to
  // move. Playback starts with the media clock standing still for a few
  // frames while the audio pipeline fills; extrapolating through that would
  // race ahead and then snap back.
  let startRaw: number | null = null;
  let last = NaN;

  const anchor = (raw: number, now: number, rate: number) => {
    anchorTime = raw;
    anchorAt = now;
    anchorRate = rate;
  };

  return {
    sample(raw, now, rate) {
      if (Number.isNaN(anchorTime) || rate !== anchorRate) {
        anchor(raw, now, rate);
        startRaw = raw;
        last = raw;
        return raw;
      }
      if (startRaw !== null) {
        if (raw === startRaw) {
          anchor(raw, now, rate);
          return (last = raw);
        }
        startRaw = null;
        anchor(raw, now, rate);
        return (last = raw);
      }
      const predicted = anchorTime + ((now - anchorAt) / 1000) * rate;
      const err = raw - predicted;
      if (Math.abs(err) > JUMP_S * Math.max(1, rate)) {
        anchor(raw, now, rate);
        return (last = raw);
      }
      anchorTime += err * PULL;
      const t = anchorTime + ((now - anchorAt) / 1000) * rate;
      // Never step backwards while playing: a correction is absorbed by
      // holding for a frame, not by the playhead jumping left.
      last = rate >= 0 ? Math.max(last, t) : t;
      return last;
    },
    reset() {
      anchorTime = NaN;
      startRaw = null;
      last = NaN;
    },
  };
}
