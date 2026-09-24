import { describe, it, expect } from 'vitest';
import { frameAxis, derivedAxis, frameCenterTime, frameAtTime, frameAtColumn } from './frameTime';

// The framing the app actually runs: 2048-sample window, 512 hop, 44.1 kHz.
const SR = 44100;
const HOP = 512;
const FFT = 2048;

describe('frameAxis', () => {
  it('centres frame 0 half a window in, not at zero', () => {
    const a = frameAxis(HOP, FFT, SR, 100);
    expect(frameCenterTime(0, a)).toBeCloseTo(1024 / SR, 9);   // 23.2 ms
    expect(a.step).toBeCloseTo(HOP / SR, 9);                    // 11.6 ms
  });

  it('advances one hop per frame', () => {
    const a = frameAxis(HOP, FFT, SR, 100);
    expect(frameCenterTime(10, a) - frameCenterTime(9, a)).toBeCloseTo(HOP / SR, 9);
  });

  it('survives a zero sample rate without producing NaN', () => {
    const a = frameAxis(HOP, FFT, 0, 10);
    expect(frameAtTime(1, a)).toBe(0);
    expect(Number.isNaN(frameCenterTime(3, a))).toBe(false);
  });
});

describe('frameAtTime', () => {
  const a = frameAxis(HOP, FFT, SR, 1000);

  it('round-trips a frame centre back to that frame', () => {
    for (const i of [0, 1, 7, 250, 999]) {
      expect(frameAtTime(frameCenterTime(i, a), a)).toBe(i);
    }
  });

  it('picks the nearest frame, not the preceding one', () => {
    // Just past frame 4's centre but nearer to 4 than to 5.
    expect(frameAtTime(frameCenterTime(4, a) + a.step * 0.4, a)).toBe(4);
    expect(frameAtTime(frameCenterTime(4, a) + a.step * 0.6, a)).toBe(5);
  });

  it('clamps below zero and past the end', () => {
    expect(frameAtTime(-5, a)).toBe(0);
    expect(frameAtTime(0, a)).toBe(0);
    expect(frameAtTime(1e6, a)).toBe(999);
  });

  it('returns 0 for an empty axis rather than -1', () => {
    expect(frameAtTime(3, frameAxis(HOP, FFT, SR, 0))).toBe(0);
  });
});

describe('the skew this replaces', () => {
  // A 79.3 s track, the framing above: frameCount = floor((len - FFT)/HOP) + 1.
  const len = Math.round(79.3088 * SR);
  const count = Math.floor((len - FFT) / HOP) + 1;
  const duration = len / SR;
  const a = frameAxis(HOP, FFT, SR, count);

  /** What the row renderers used to draw: frame i spread evenly over the width. */
  const oldTimeOf = (i: number) => (i / count) * duration;

  it('was ~23 ms early at the start of the track', () => {
    const err = oldTimeOf(0) - frameCenterTime(0, a);
    expect(err * 1000).toBeCloseTo(-23.2, 1);
  });

  it('was ~12 ms late at the end of the track', () => {
    const i = count - 1;
    const err = oldTimeOf(i) - frameCenterTime(i, a);
    expect(err * 1000).toBeGreaterThan(10);
    expect(err * 1000).toBeLessThan(13);
  });

  it('changed sign partway through — so no constant offset could fix it', () => {
    const errAt = (i: number) => oldTimeOf(i) - frameCenterTime(i, a);
    expect(errAt(0)).toBeLessThan(0);
    expect(errAt(count - 1)).toBeGreaterThan(0);
  });
});

describe('derivedAxis', () => {
  const base = frameAxis(HOP, FFT, SR, 6400);

  it('gives the tempogram a 4x step and keeps its centred window on the input frame', () => {
    // Each output frame's autocorrelation window is centred on input frame tf*4,
    // so groupSize is 1 — the offset is unchanged from the base axis.
    const t = derivedAxis(base, 4, 1600, 1);
    expect(t.step).toBeCloseTo(4 * base.step, 9);
    expect(t.offset).toBeCloseTo(base.offset, 9);
    expect(frameCenterTime(10, t)).toBeCloseTo(frameCenterTime(40, base), 9);
  });

  it('centres an SSM block on the middle of the frames it averages', () => {
    // SSM frame sf is the mean of input frames [sf*64, sf*64+64).
    const s = derivedAxis(base, 64, 100);
    expect(s.step).toBeCloseTo(64 * base.step, 9);
    // Block 0 spans input frames 0..63, so its centre is at input frame 31.5.
    expect(frameCenterTime(0, s)).toBeCloseTo(frameCenterTime(31.5, base), 9);
    expect(frameCenterTime(1, s)).toBeCloseTo(frameCenterTime(95.5, base), 9);
  });
});

describe('frameAtColumn', () => {
  const a = frameAxis(HOP, FFT, SR, 1000);

  it('maps the column at a frame centre back to that frame', () => {
    const duration = 20;
    const width = 800;
    const i = 300;
    const col = (frameCenterTime(i, a) / duration) * width;
    expect(frameAtColumn(col, width, duration, a)).toBe(i);
  });

  it('is safe on a zero-width or zero-duration canvas', () => {
    expect(frameAtColumn(5, 0, 20, a)).toBe(0);
    expect(frameAtColumn(5, 800, 0, a)).toBe(0);
  });
});
