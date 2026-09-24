/**
 * frameTime — the one place that says *when* an analysis frame happened.
 *
 * An STFT frame is a window, not an instant. Frame `i` of a run with hop `h`
 * and window `w` covers samples `[i·h, i·h + w)`, so the moment it describes is
 * its **centre**, `i·h + w/2` — not its start. Two consequences, both of which
 * every row renderer used to get wrong by mapping `col → floor(col/W ·
 * frameCount)`:
 *
 *   1. Frame 0 is centred half a window in, not at t=0.
 *   2. The last frame *starts* a whole window before the end of the buffer, so
 *      the frame axis is shorter than the track — spreading `frameCount` frames
 *      evenly across the full width stretches them.
 *
 * At 2048/512 on 44.1 kHz those two pull in opposite directions: the drawn
 * position runs **23 ms early at t=0**, crosses over about two thirds through,
 * and ends **~12 ms late**. It is a position-dependent skew, not a constant, so
 * it cannot be dialled out with a single offset — which is why the heatmaps and
 * the curve rows disagreed with the waveform and with each other. At the zoom
 * levels this app supports (thousands of px/sec) 23 ms is tens of pixels.
 *
 * Derived matrices (tempogram, SSM) are built by aggregating input frames, so
 * they inherit the same axis with a coarser step — see `derivedAxis`.
 */

export interface FrameAxis {
  /** Seconds between consecutive frame centres. */
  step: number;
  /** Time of frame 0's centre, in seconds. */
  offset: number;
  /** Number of frames on this axis. */
  count: number;
}

/** Axis for a raw STFT run: `count` frames, hop `hopSize`, window `fftSize`. */
export function frameAxis(
  hopSize: number,
  fftSize: number,
  sampleRate: number,
  count: number,
): FrameAxis {
  if (!(sampleRate > 0)) return { step: 0, offset: 0, count: Math.max(0, count) };
  return {
    step: hopSize / sampleRate,
    offset: fftSize / 2 / sampleRate,
    count: Math.max(0, count),
  };
}

/**
 * Axis for a matrix built by aggregating `groupSize` consecutive input frames
 * every `hopFactor` input frames. `groupSize` defaults to `hopFactor` (a plain
 * block average, e.g. the SSM); pass 1 when each output frame is *centred* on
 * an input frame rather than spanning a block forward from it (the tempogram,
 * whose autocorrelation window is centred on `tf · hopFactor`).
 */
export function derivedAxis(base: FrameAxis, hopFactor: number, count: number, groupSize = hopFactor): FrameAxis {
  return {
    step: base.step * hopFactor,
    // The block spans input frames [0, groupSize), so its centre sits
    // (groupSize - 1) / 2 input frames past the first one.
    offset: base.offset + ((groupSize - 1) / 2) * base.step,
    count: Math.max(0, count),
  };
}

/** Centre time (seconds) of frame `i` on `axis`. */
export function frameCenterTime(i: number, axis: FrameAxis): number {
  return i * axis.step + axis.offset;
}

/**
 * The frame on `axis` whose centre is nearest `t` seconds, clamped into range.
 * This is the mapping a column renderer wants: turn the column's time into the
 * frame that actually describes it.
 */
export function frameAtTime(t: number, axis: FrameAxis): number {
  if (axis.count <= 0) return 0;
  if (!(axis.step > 0)) return 0;
  const i = Math.round((t - axis.offset) / axis.step);
  if (i < 0) return 0;
  if (i >= axis.count) return axis.count - 1;
  return i;
}

/**
 * Convenience for canvas painters: the frame index for pixel column `col` of a
 * `width`-wide canvas spanning `duration` seconds.
 */
export function frameAtColumn(col: number, width: number, duration: number, axis: FrameAxis): number {
  if (width <= 0 || !(duration > 0)) return 0;
  return frameAtTime((col / width) * duration, axis);
}
