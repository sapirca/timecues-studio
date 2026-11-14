import { describe, expect, it } from 'vitest';
import { applyTap, emptyTapTempoState, type TapTempoState } from './tapTempo';

const run = (times: number[], from: TapTempoState = emptyTapTempoState) =>
  times.reduce((s, t) => applyTap(s, t), from);

/** Steady taps at `bpm`, starting at `start`. */
const steady = (bpm: number, n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => start + (i * 60000) / bpm);

/** Deterministic Gaussian jitter (Park–Miller + Box–Muller). */
function jitter(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
}

describe('applyTap', () => {
  it('reads the tempo from the second tap', () => {
    expect(run([0]).currentBpm).toBeNull();
    expect(run([0, 500]).currentBpm).toBe(120);
  });

  it('keeps every tap of the sequence, not a sliding window', () => {
    expect(run(steady(128, 40)).taps).toHaveLength(40);
  });

  it('ignores taps closer than the debounce', () => {
    const s = run([0, 500, 600]);
    expect(s.taps).toEqual([0, 500]);
  });

  it('a late tap followed by an on-time one is one slip, not a new tempo', () => {
    const s = run([...steady(120, 6), 3100, 3500, 4000]);
    expect(s.currentBpm).toBe(120);
    expect(s.taps).not.toContain(3100);
    expect(s.taps).toHaveLength(8);
  });

  it('an extra tap between beats is a slip too', () => {
    expect(run([...steady(120, 6), 2750, 3000]).currentBpm).toBe(120);
  });

  it('two off-line taps in a row re-lock onto the new tempo', () => {
    // 120 BPM, then the user switches to 100 BPM (600 ms).
    const s = run([...steady(120, 6), 3100, 3700, 4300]);
    expect(s.currentBpm).toBe(100);
  });

  it('a skipped beat keeps counting on the same line', () => {
    // 150 BPM = 400 ms; the tap at 2000 is missing, 2400 lands two beats on.
    const s = run([0, 400, 800, 1200, 1600, 2400, 2800]);
    expect(s.beats).toEqual([0, 1, 2, 3, 4, 6, 7]);
    expect(s.currentBpm).toBe(150);
  });

  it('a pause of over a second drops every earlier tap', () => {
    const s = run([...steady(120, 6), 4000]);
    expect(s.taps).toEqual([4000]);
    expect(s.currentBpm).toBe(120);
  });

  it('settles and stays put as taps accumulate, despite ±20 ms jitter', () => {
    for (const seed of [1, 7, 42, 99, 1234]) {
      const g = jitter(seed);
      let s = emptyTapTempoState;
      const readouts: number[] = [];
      for (let i = 0; i < 40; i++) {
        s = applyTap(s, i * 500 + 20 * g());
        readouts.push(s.currentBpm ?? 0);
      }
      // By tap 20 the line's error (~±0.2 BPM) is inside the rounding, so the
      // readout no longer moves.
      expect(new Set(readouts.slice(19))).toEqual(new Set([120]));
    }
  });
});
