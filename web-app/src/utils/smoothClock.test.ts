import { describe, expect, it } from 'vitest';
import { createClockSmoother } from './smoothClock';

/** A media clock that only moves in whole audio buffers, read every frame —
 *  the stepping the smoother exists to hide. */
function steppedReadings(rate: number, frames: number, frameMs = 16.7, bufferMs = 10.7, from = 0) {
  const out: { raw: number; wall: number }[] = [];
  for (let i = 0; i < frames; i++) {
    const wall = 1000 + i * frameMs;
    const audioMs = Math.floor((i * frameMs * rate) / bufferMs) * bufferMs;
    out.push({ raw: from + audioMs / 1000, wall });
  }
  return out;
}

function steps(xs: number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]);
}

describe('createClockSmoother', () => {
  it('turns buffer-sized steps into an even advance once it has a rate', () => {
    const s = createClockSmoother();
    const input = steppedReadings(1, 180);
    const shown = input.map(({ raw, wall }) => s(raw, wall));
    const settled = steps(shown.slice(60)).map((d) => d * 1000);
    const rawSteps = steps(input.slice(60).map((r) => r.raw)).map((d) => d * 1000);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(rawSteps)).toBeGreaterThan(9);
    expect(spread(settled)).toBeLessThan(3);
  });

  it('stays within a few ms of the audio', () => {
    const s = createClockSmoother();
    for (const { raw, wall } of steppedReadings(1, 180)) {
      expect(Math.abs(s(raw, wall) - raw)).toBeLessThan(0.015);
    }
  });

  it('follows a slowed-down player at its own rate', () => {
    const s = createClockSmoother();
    const input = steppedReadings(0.5, 180);
    const shown = input.map(({ raw, wall }) => s(raw, wall));
    const last = input[input.length - 1];
    expect(Math.abs(shown[shown.length - 1] - last.raw)).toBeLessThan(0.015);
    // The raw readings step 0 or 10.7 ms; shown, every frame is ~8.35 ms.
    for (const d of steps(shown.slice(60))) expect(Math.abs(d * 1000 - 16.7 * 0.5)).toBeLessThan(1.5);
  });

  it('snaps to a seek rather than gliding to it', () => {
    const s = createClockSmoother();
    const input = steppedReadings(1, 60);
    input.forEach(({ raw, wall }) => s(raw, wall));
    const wall = input[input.length - 1].wall + 16.7;
    expect(s(42, wall)).toBe(42);
    expect(s(3, wall + 16.7)).toBe(3);
  });

  it('shows the exact reading after a pause', () => {
    const s = createClockSmoother();
    const input = steppedReadings(1, 60);
    input.forEach(({ raw, wall }) => s(raw, wall));
    const last = input[input.length - 1];
    expect(s(last.raw, last.wall + 2000)).toBe(last.raw);
  });
});
