import { describe, expect, it } from 'vitest';
import { stackTicks } from './tickStacking';

describe('stackTicks', () => {
  it('draws a shorter hit above a taller one at the same moment', () => {
    const [kick, snare] = stackTicks([
      { time: 1, heightPct: 100 },
      { time: 1.004, heightPct: 70 },
    ]);
    expect(snare.zIndex).toBeGreaterThan(kick.zIndex);
    expect(kick.offsetPx).toBe(0);
    expect(snare.offsetPx).toBe(0);
    expect(kick.together).toEqual([0, 1]);
  });

  it('never moves equal-height hits off their time — the tie is in `together`', () => {
    const p = stackTicks([
      { time: 2, heightPct: 100 },
      { time: 2, heightPct: 100 },
      { time: 2, heightPct: 98 },
    ]);
    expect(p.map((x) => x.offsetPx)).toEqual([0, 0, 0]);
    expect(p[0].together).toHaveLength(3);
  });

  it('leaves hits at different moments alone', () => {
    const p = stackTicks([
      { time: 0, heightPct: 100 },
      { time: 0.5, heightPct: 100 },
    ]);
    expect(p.map((x) => x.offsetPx)).toEqual([0, 0]);
    expect(p[0].together).toEqual([0]);
  });

  it('keeps every tick under the playhead (z < 10)', () => {
    const p = stackTicks([{ time: 0, heightPct: 0 }, { time: 0, heightPct: 100 }]);
    for (const x of p) expect(x.zIndex).toBeLessThan(10);
  });
});
