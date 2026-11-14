import { describe, it, expect } from 'vitest';
import { beatStrengthCurve, busynessCurve, onsetDensityCurve, pickOnsets } from './rhythmSignals';
import { frameCenterTime, type FrameAxis } from './frameTime';

// 120 bpm → a beat every 0.5 s; frames every 10 ms, centred on the frame.
const AXIS: FrameAxis = { step: 0.01, offset: 0.005, count: 1600 };
const BEATS = Array.from({ length: 33 }, (_, i) => i * 0.5); // 0 … 16 s

/** A spike of `height` at each time in `times`, on AXIS. */
function spikes(times: number[], height = 1): Float32Array {
  const out = new Float32Array(AXIS.count);
  for (const t of times) {
    const i = Math.round((t - AXIS.offset) / AXIS.step);
    if (i >= 0 && i < out.length) out[i] = height;
  }
  return out;
}

const meanOver = (curve: Float32Array, from: number, to: number) => {
  let s = 0;
  let c = 0;
  for (let i = 0; i < curve.length; i++) {
    const t = frameCenterTime(i, AXIS);
    if (t >= from && t < to) { s += curve[i]; c++; }
  }
  return s / c;
};

describe('beat strength', () => {
  it('is high where the kick lands on the beat and zero where it stops', () => {
    // Kick on every beat for 8 s, then nothing (a breakdown) for 8 s.
    const kicks = spikes(BEATS.filter((t) => t < 8));
    const curve = beatStrengthCurve(kicks, AXIS, BEATS);

    expect(meanOver(curve, 1, 7)).toBeGreaterThan(0.9);
    expect(meanOver(curve, 9, 15)).toBe(0);
  });

  it('still hears the kick when the grid is off or drifting', () => {
    // The same kicks, but the grid sits 60 ms late — or runs at 129 bpm under
    // a 120 bpm track. Either way the kick is still in every beat.
    const kicks = spikes(BEATS.filter((t) => t < 8));
    const late = beatStrengthCurve(kicks, AXIS, BEATS.map((t) => t + 0.06));
    const drifting = beatStrengthCurve(kicks, AXIS, Array.from({ length: 36 }, (_, i) => i * (60 / 129)));

    expect(meanOver(late, 1, 7)).toBeGreaterThan(0.9);
    expect(meanOver(drifting, 1, 7)).toBeGreaterThan(0.9);
    expect(meanOver(drifting, 9, 15)).toBe(0);
  });

  it('reads the strongest hit in the beat, not how many there are', () => {
    // Two hits in every beat read no stronger than one.
    const one = beatStrengthCurve(spikes(BEATS), AXIS, BEATS);
    const two = beatStrengthCurve(spikes([...BEATS, ...BEATS.map((t) => t + 0.25)]), AXIS, BEATS);
    expect(meanOver(two, 1, 7)).toBeCloseTo(meanOver(one, 1, 7), 5);
  });

  it('reads uneven bass — notes and swelling pads — as no beat', () => {
    // Hits in every beat, but each a different height, as bass notes and pad
    // swells land: loud enough, never steady.
    const heights = [1, 0.3, 0.6, 0.15, 0.9, 0.2, 0.45, 0.1];
    const uneven = new Float32Array(AXIS.count);
    BEATS.forEach((t, k) => {
      const i = Math.round((t - AXIS.offset) / AXIS.step);
      if (i < uneven.length) uneven[i] = heights[k % heights.length];
    });
    const steadyKick = beatStrengthCurve(spikes(BEATS), AXIS, BEATS);
    const notes = beatStrengthCurve(uneven, AXIS, BEATS);

    expect(meanOver(steadyKick, 1, 15)).toBeGreaterThan(0.9);
    expect(meanOver(notes, 1, 15)).toBeLessThan(0.1);
  });

  it('still draws without a grid, from the bass hits alone', () => {
    const curve = beatStrengthCurve(spikes(BEATS.filter((t) => t < 8)), AXIS, null);
    expect(meanOver(curve, 1, 7)).toBeGreaterThan(meanOver(curve, 9, 15));
  });
});

describe('onset density', () => {
  it('doubles as a snare roll goes from quarters to eighths to sixteenths', () => {
    const quarters = BEATS.filter((t) => t < 5.5);
    const eighths = Array.from({ length: 10 }, (_, i) => 5.5 + i * 0.25);
    const sixteenths = Array.from({ length: 20 }, (_, i) => 8 + i * 0.125);
    const roll = spikes([...quarters, ...eighths, ...sixteenths]);

    const curve = onsetDensityCurve(roll, AXIS, BEATS);
    const q = meanOver(curve, 2, 4);
    const e = meanOver(curve, 6.5, 7);
    const s = meanOver(curve, 9, 9.5);

    expect(e / q).toBeCloseTo(2, 0);
    expect(s / e).toBeCloseTo(2, 0);
  });

  it('counts peaks, not how loud they are', () => {
    const soft = pickOnsets(spikes([1, 2, 3], 0.2), AXIS);
    const loud = pickOnsets(spikes([1, 2, 3], 1), AXIS);
    expect(soft).toHaveLength(3);
    expect(loud).toHaveLength(3);
  });
});

describe('busyness', () => {
  const N_BANDS = 8;

  /** frame × band levels in dB: every band at -60 dB (silence), and in each
   *  band listed a note — a jump to -10 dB decaying 20 dB over ~0.1 s — at each
   *  time given. `held` bands sit at a steady -10 dB instead. */
  function levels(notes: { bands: number[]; times: number[] }[], held: number[] = []): Float32Array {
    const out = new Float32Array(AXIS.count * N_BANDS).fill(-60);
    for (const b of held) for (let i = 0; i < AXIS.count; i++) out[i * N_BANDS + b] = -10;
    for (const { bands, times } of notes) {
      for (const t of times) {
        const i0 = Math.round((t - AXIS.offset) / AXIS.step);
        for (let k = 0; k < 10 && i0 + k < AXIS.count; k++) {
          for (const b of bands) out[(i0 + k) * N_BANDS + b] = Math.max(out[(i0 + k) * N_BANDS + b], -10 - 2 * k);
        }
      }
    }
    return out;
  }

  it('reads many bands playing fast as busy and held sounds as calm', () => {
    // 0–8 s: every band held (a loud, wide pad). 8–16 s: eighth notes in
    // all eight bands (a full arrangement playing).
    const eighths = Array.from({ length: 32 }, (_, i) => 8 + i * 0.25 + 0.05);
    const lv = levels([{ bands: [0, 1, 2, 3, 4, 5, 6, 7], times: eighths }]);
    for (let i = 0; i < AXIS.count; i++) {
      if (frameCenterTime(i, AXIS) < 8) for (let b = 0; b < N_BANDS; b++) lv[i * N_BANDS + b] = -10;
    }
    const curve = busynessCurve(lv, N_BANDS, AXIS, BEATS);

    expect(meanOver(curve, 1, 7)).toBe(0);
    expect(meanOver(curve, 10, 14)).toBeGreaterThan(0.9);
  });

  it('grows with the number of bands, not only with the rate', () => {
    // The same quarter notes, in one band for 8 s and then in four.
    const q1 = BEATS.filter((t) => t < 8).map((t) => t + 0.05);
    const q2 = BEATS.filter((t) => t >= 8 && t < 16).map((t) => t + 0.05);
    const curve = busynessCurve(levels([{ bands: [3], times: q1 }, { bands: [1, 3, 5, 7], times: q2 }]), N_BANDS, AXIS, BEATS);

    expect(meanOver(curve, 10, 14) / meanOver(curve, 2, 6)).toBeCloseTo(4, 0);
  });

  it('counts a quiet part ticking alone for little', () => {
    // Eighth notes in every band all song — at full level for 8 s, then 20 dB
    // down (a shaker left alone once the groove drops out).
    const eighths = Array.from({ length: 64 }, (_, i) => i * 0.25 + 0.05);
    const lv = levels([{ bands: [0, 1, 2, 3, 4, 5, 6, 7], times: eighths }]);
    for (let i = 0; i < AXIS.count; i++) {
      if (frameCenterTime(i, AXIS) >= 8) for (let b = 0; b < N_BANDS; b++) lv[i * N_BANDS + b] -= 20;
    }
    const curve = busynessCurve(lv, N_BANDS, AXIS, BEATS);

    expect(meanOver(curve, 10, 14) / meanOver(curve, 2, 6)).toBeLessThan(0.25);
  });
});
