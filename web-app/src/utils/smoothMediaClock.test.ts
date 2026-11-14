import { describe, it, expect } from 'vitest';
import { createSmoothMediaClock } from './smoothMediaClock';

const FRAME = 1000 / 60;

/** A media clock that advances in uneven steps around the true time, the way
 *  Chrome's currentTime does: true time snapped down to 21 ms render quanta. */
const choppy = (trueT: number) => Math.floor(trueT / 0.021) * 0.021;

describe('createSmoothMediaClock', () => {
  it('advances by an even step per frame through an uneven clock', () => {
    const clock = createSmoothMediaClock();
    const shown: number[] = [];
    for (let i = 0; i < 240; i++) {
      const now = i * FRAME;
      shown.push(clock.sample(choppy(10 + now / 1000), now, 1));
    }
    // Past the settle, every frame step is close to one frame of song …
    const steps = shown.slice(121).map((t, i) => t - shown[120 + i]);
    for (const s of steps) expect(Math.abs(s - FRAME / 1000)).toBeLessThan(0.004);
    // … where the raw steps swing between 0 and 21 ms.
    const raw = Array.from({ length: 120 }, (_, i) => choppy(10 + ((120 + i) * FRAME) / 1000));
    const rawSteps = raw.slice(1).map((t, i) => t - raw[i]);
    expect(Math.min(...rawSteps)).toBe(0);
    // And it stays on the true time.
    const trueEnd = 10 + (239 * FRAME) / 1000;
    expect(Math.abs(shown[239] - trueEnd)).toBeLessThan(0.025);
  });

  it('takes a jump (seek, loop wrap) at once', () => {
    const clock = createSmoothMediaClock();
    for (let i = 0; i < 30; i++) clock.sample(5 + (i * FRAME) / 1000, i * FRAME, 1);
    expect(clock.sample(42, 30 * FRAME, 1)).toBe(42);
  });

  it('holds while the clock has not started moving, then starts from it', () => {
    const clock = createSmoothMediaClock();
    for (let i = 0; i < 6; i++) expect(clock.sample(3, i * FRAME, 1)).toBe(3);
    expect(clock.sample(3.01, 6 * FRAME, 1)).toBe(3.01);
  });

  it('never steps backwards while playing', () => {
    const clock = createSmoothMediaClock();
    clock.sample(1, 0, 1);
    clock.sample(1.0167, FRAME, 1);
    const a = clock.sample(1.04, 2 * FRAME, 1);
    const b = clock.sample(1.0, 3 * FRAME, 1);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('starts over after reset', () => {
    const clock = createSmoothMediaClock();
    clock.sample(1, 0, 1);
    clock.sample(1.0167, FRAME, 1);
    clock.reset();
    expect(clock.sample(0.5, 2 * FRAME, 1)).toBe(0.5);
  });
});
