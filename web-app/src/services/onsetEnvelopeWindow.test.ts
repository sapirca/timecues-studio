import { describe, it, expect } from 'vitest';
import { onsetEnvelopeFromMono } from './mirAnalysis';
import { frameCenterTime } from '../utils/frameTime';

const SR = 44100;
const HOP = 512;
const FFT = 2048;

/** `seconds` of silence with a broadband click at each of `clickSec`. */
function clicks(seconds: number, clickSec: number[]): Float32Array {
  const mono = new Float32Array(Math.round(seconds * SR));
  for (const t of clickSec) {
    const at = Math.round(t * SR);
    // A few samples of full-scale noise — a spectrum-wide attack, which is
    // what half-wave-rectified flux is built to find.
    for (let i = 0; i < 64 && at + i < mono.length; i++) {
      mono[at + i] = (i % 2 === 0 ? 1 : -1) * (1 - i / 64);
    }
  }
  return mono;
}

/** Time of the loudest frame in a returned envelope. */
function peakTime(env: ReturnType<typeof onsetEnvelopeFromMono>): number {
  let best = 0;
  for (let i = 1; i < env.values.length; i++) if (env.values[i] > env.values[best]) best = i;
  return frameCenterTime(best, env.axis);
}

describe('onsetEnvelopeFromMono', () => {
  it('dates its peak at the click, not at the start of the window', () => {
    const env = onsetEnvelopeFromMono(clicks(6, [4.0]), SR, 3.5, 4.5);
    // The click lands inside the window it was asked for, within one hop.
    expect(peakTime(env)).toBeGreaterThan(4.0 - HOP / SR);
    expect(peakTime(env)).toBeLessThan(4.0 + FFT / SR);
  });

  it('covers the requested window and nothing much beyond it', () => {
    const env = onsetEnvelopeFromMono(clicks(20, []), SR, 10, 11);
    const first = frameCenterTime(0, env.axis);
    const last = frameCenterTime(env.values.length - 1, env.axis);
    expect(first).toBeLessThanOrEqual(10);
    expect(last).toBeGreaterThanOrEqual(11);
    // One hop of slack on each side, no more — this is a window, not a song.
    expect(first).toBeGreaterThan(10 - 2 * (HOP / SR));
    expect(last).toBeLessThan(11 + 2 * (HOP / SR));
  });

  it('reports the same values wherever the window sits in the buffer', () => {
    // A click at 4s read through a window starting at 3.5s must look the same
    // as the same click read through a window starting at 0.5s of a buffer
    // that begins 3s later — the seed frame is what makes this true.
    const wide = onsetEnvelopeFromMono(clicks(6, [4.0]), SR, 3.8, 4.2);
    const narrow = onsetEnvelopeFromMono(clicks(6, [4.0]), SR, 3.9, 4.1);
    const at = (env: typeof wide, t: number) =>
      env.values[Math.round((t - env.axis.offset) / env.axis.step)];
    expect(at(narrow, 4.0)).toBeCloseTo(at(wide, 4.0), 5);
  });

  it('scores a silent window at zero and a click far above it', () => {
    const mono = clicks(10, [5.0]);
    const quiet = onsetEnvelopeFromMono(mono, SR, 1, 2);
    const loud = onsetEnvelopeFromMono(mono, SR, 4.8, 5.2);
    expect(Math.max(...quiet.values)).toBe(0);
    expect(Math.max(...loud.values)).toBeGreaterThan(1);
  });

  it("gives the buffer's first frame no onset instead of a phantom attack", () => {
    // Frame 0 has no predecessor: every bin is "new", which would otherwise
    // read as the loudest onset in the track.
    const env = onsetEnvelopeFromMono(clicks(2, [0.5]), SR, 0, 0.1);
    expect(env.values[0]).toBe(0);
  });

  it('returns nothing for a degenerate window', () => {
    expect(onsetEnvelopeFromMono(clicks(2, []), SR, 1, 1).values.length).toBe(0);
    expect(onsetEnvelopeFromMono(new Float32Array(100), SR, 0, 1).values.length).toBe(0);
    expect(onsetEnvelopeFromMono(clicks(2, []), 0, 0, 1).values.length).toBe(0);
  });
});
