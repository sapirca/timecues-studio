import { describe, expect, it } from 'vitest';
import { frameAxis } from './frameTime';
import { onsetTickEnds, sampleOnsetWindow, TICK_MAX_BEATS, TICK_MIN_BEATS } from './onsetWindow';

/** A 100 Hz frame axis with no window offset — one frame every 10 ms, frame
 *  `i` centred at exactly `i / 100` s, so the expected beats in these
 *  assertions can be read off by hand. */
const AXIS = { step: 0.01, offset: 0, count: 400 };

/** Flat silence with a one-frame spike at each given frame index. */
function spikes(count: number, at: readonly number[], height = 1): number[] {
  const out = new Array(count).fill(0.01);
  for (const i of at) out[i] = height;
  return out;
}

describe('sampleOnsetWindow', () => {
  it('maps peaks into the window’s own beat coordinates', () => {
    // Window [1s, 3s) over 4 beats ⇒ 0.5 s/beat. Spikes at 1.0 s, 1.5 s, 2.5 s
    // are beats 0, 1 and 3.
    const { peakBeats } = sampleOnsetWindow(spikes(400, [100, 150, 250]), AXIS, 1, 3, 4);
    expect(peakBeats.map((b) => Number(b.toFixed(3)))).toEqual([0, 1, 3]);
  });

  it('ignores onsets outside the placement', () => {
    const { peakBeats } = sampleOnsetWindow(spikes(400, [50, 150, 350]), AXIS, 1, 3, 4);
    expect(peakBeats.map((b) => Number(b.toFixed(3)))).toEqual([1]);
  });

  it('thins an attack smeared over neighbouring frames into one onset', () => {
    const values = spikes(400, [], 0);
    values[150] = 0.6;
    values[151] = 1;
    values[152] = 0.7;
    const { peakBeats } = sampleOnsetWindow(values, AXIS, 1, 3, 4);
    expect(peakBeats).toHaveLength(1);
    expect(peakBeats[0]).toBeCloseTo(1.02, 2);
  });

  it('drops shoulders below the floor', () => {
    // A 0.06 spike next to a 1.0 one is 6% of the hit it is sitting on — under
    // the 8% floor, so it is the tail of a hit, not a hit. The bar is this low
    // on purpose: a shoulder you can see in the drawn envelope is one the
    // detector is expected to mark, so only the ones you cannot are dropped.
    const { peakBeats } = sampleOnsetWindow(spikes(400, [150]).map((v, i) => (i === 180 ? 0.06 : v)), AXIS, 1, 3, 4);
    expect(peakBeats).toHaveLength(1);
  });

  it('keeps a ghost note that the old quarter-of-local floor threw away', () => {
    // The reported bug: the envelope plainly shows a bump between the accented
    // hits and nothing marks it. At 20% of the hit it sits beside, this used
    // to be a shoulder; now it is a hit.
    const { peakBeats } = sampleOnsetWindow(spikes(400, [150]).map((v, i) => (i === 180 ? 0.2 : v)), AXIS, 1, 3, 4);
    expect(peakBeats).toHaveLength(2);
  });

  it('judges a peak against its neighbours, not the window’s loudest hit', () => {
    // A crash at 1.1 s and a picked note at 2.5 s, 1.4 s apart — far outside
    // each other's neighbourhood. Against the window maximum the note is 5%
    // and fails the 8% bar; against the music around it, it is the loudest
    // thing there. This is the "many ticks are being missed" case: one loud
    // hit used to silence the rest of the placement.
    const values = spikes(400, [110]);
    values[250] = 0.05;
    const { peakBeats } = sampleOnsetWindow(values, AXIS, 1, 3, 4);
    expect(peakBeats).toHaveLength(2);
    expect(peakBeats[1]).toBeCloseTo(3, 1);
  });

  it('still keeps silence silent, however loud its neighbours are not', () => {
    // The local floor is scale-free, so on its own it would promote every
    // ripple in a quiet stretch. The absolute gate is what stops it — and with
    // the local floor down at 8% it is very nearly the only thing that does,
    // so the margin it defends is thinner than it used to be: 2% of the
    // window's loudest onset is out, 3% is in.
    const values = spikes(400, [110]);
    values[250] = 0.02;
    expect(sampleOnsetWindow(values, AXIS, 1, 3, 4).peakBeats).toHaveLength(1);
  });

  it('finds a hit on the very first frame of the audio', () => {
    // A node placed at 0:00 starts on frame 0, which has no frame before it.
    // Requiring a neighbour on both sides made that frame unwinnable, so the
    // node's own downbeat — the first thing anyone looks at — was never found.
    const values = spikes(400, [], 0.01);
    values[0] = 1;
    values[150] = 1;
    const { peakBeats } = sampleOnsetWindow(values, AXIS, 0, 2, 4);
    expect(peakBeats[0]).toBeCloseTo(0, 6);
    expect(peakBeats).toHaveLength(2);
  });

  it('finds a hit on the very last frame of the audio', () => {
    const values = spikes(400, [], 0.01);
    values[399] = 1;
    const { peakBeats } = sampleOnsetWindow(values, AXIS, 3, 4, 4);
    expect(peakBeats).toHaveLength(1);
    expect(peakBeats[0]).toBeCloseTo(4, 1);
  });

  it('claims a hit that lands a hair outside the placement, at the edge', () => {
    // Beat 0 of the node is at 1.00 s and the downbeat was played 20 ms early,
    // so its peak sits at frame 98 — outside the window, plainly the node's
    // own first hit. It comes back clamped onto beat 0 rather than lost.
    const values = spikes(400, [98, 150]);
    const { peakBeats } = sampleOnsetWindow(values, AXIS, 1, 3, 4);
    expect(peakBeats).toHaveLength(2);
    expect(peakBeats[0]).toBe(0);
  });

  it('does not drag in a hit that is merely near the placement', () => {
    // 200 ms outside is a different hit, not a rushed edge — the tolerance is
    // deliberately shorter than anything anyone plays.
    const { peakBeats } = sampleOnsetWindow(spikes(400, [80, 150]), AXIS, 1, 3, 4);
    expect(peakBeats).toHaveLength(1);
    expect(peakBeats[0]).toBeCloseTo(1, 6);
  });

  it('never reports one edge hit twice after clamping', () => {
    // Two peaks either side of the window's start both clamp onto beat 0.
    const values = spikes(400, [], 0.01);
    values[97] = 1;
    values[103] = 0.9;
    const { peakBeats } = sampleOnsetWindow(values, AXIS, 1, 3, 4);
    expect(new Set(peakBeats).size).toBe(peakBeats.length);
  });

  it('normalises the drawn curve against the window, not the song', () => {
    // The loud hit sits outside [1s, 3s): the quiet one inside still reaches 1.
    const values = spikes(400, [150], 0.3);
    values[350] = 1;
    const { curve } = sampleOnsetWindow(values, AXIS, 1, 3, 4);
    expect(Math.max(...curve)).toBeCloseTo(1, 5);
  });

  it('takes each column’s maximum, so a one-frame spike survives resampling', () => {
    // 200 frames in the window, 8 columns ⇒ 25 frames each. A mean would
    // render the spike at 1/25 of its height.
    const { curve } = sampleOnsetWindow(spikes(400, [150]), AXIS, 1, 3, 4, { columns: 8 });
    expect(curve).toHaveLength(8);
    expect(Math.max(...curve)).toBeCloseTo(1, 5);
  });

  it('returns nothing for a degenerate window', () => {
    expect(sampleOnsetWindow([], AXIS, 1, 3, 4)).toEqual({ curve: [], peakBeats: [] });
    expect(sampleOnsetWindow(spikes(400, [150]), AXIS, 3, 3, 4)).toEqual({ curve: [], peakBeats: [] });
    expect(sampleOnsetWindow(spikes(400, [150]), AXIS, 1, 3, 0)).toEqual({ curve: [], peakBeats: [] });
    // Digital silence has no peak to normalise against.
    expect(sampleOnsetWindow(new Array(400).fill(0), AXIS, 1, 3, 4)).toEqual({ curve: [], peakBeats: [] });
  });

  it('dates frames by their centre, not their index', () => {
    // A real STFT axis: 2048/512 at 44.1 kHz, so frame 0 is centred 23 ms in.
    const axis = frameAxis(512, 2048, 44100, 400);
    const values = spikes(400, [100]);
    const { peakBeats } = sampleOnsetWindow(values, axis, 0, 4, 4);
    const centre = 100 * axis.step + axis.offset;
    expect(peakBeats[0]).toBeCloseTo((centre / 4) * 4, 6);
    // Using the index instead would put it a whole window earlier.
    expect(peakBeats[0]).not.toBeCloseTo(100 * axis.step, 3);
  });
});

describe('level sampling', () => {
  /** A level contour: `1` from each hit's frame until it decays to `tail`
   *  after `holdFrames`, so a block's expected end can be read off by hand. */
  function decays(count: number, hits: readonly number[], holdFrames: number, tail = 0.02): number[] {
    const out = new Array(count).fill(tail);
    for (const at of hits) for (let i = at; i < at + holdFrames && i < count; i += 1) out[i] = 1;
    return out;
  }

  it('reports the window’s loudness beside the flux when asked', () => {
    const { levelCurve } = sampleOnsetWindow(
      spikes(400, [150]), AXIS, 1, 3, 4, { columns: 8, levels: decays(400, [150], 50) },
    );
    expect(levelCurve).toHaveLength(8);
    // Frames 150-199 are loud: columns 2 and 3 of the 8 covering [1s, 3s).
    expect(levelCurve![2]).toBeCloseTo(1, 5);
    expect(levelCurve![7]).toBeLessThan(0.1);
  });

  it('says nothing about level when none was given', () => {
    expect(sampleOnsetWindow(spikes(400, [150]), AXIS, 1, 3, 4).levelCurve).toBeUndefined();
  });

  it('averages each column instead of taking its max, unlike the flux', () => {
    // Column 2 holds one loud frame in 25; column 4 is loud throughout. Under
    // a max they would draw identically — which is exactly the reading that
    // makes a decayed tail look as alive as its own attack.
    const levels = new Array(400).fill(0.02);
    levels[150] = 1;
    for (let i = 200; i < 225; i += 1) levels[i] = 1;
    const { levelCurve } = sampleOnsetWindow(
      spikes(400, [150]), AXIS, 1, 3, 4, { columns: 8, levels },
    );
    expect(levelCurve![4]).toBeCloseTo(1, 5);
    expect(levelCurve![2]).toBeLessThan(0.2);
  });
});

describe('onsetTickEnds', () => {
  /** A curve over `lengthBeats` where each hit is loud for `holdBeats`. */
  function levelOver(columns: number, lengthBeats: number, hits: readonly [number, number][]): number[] {
    const out = new Array(columns).fill(0.02);
    for (const [start, hold] of hits) {
      const from = Math.round((start / lengthBeats) * columns);
      const to = Math.round(((start + hold) / lengthBeats) * columns);
      for (let c = from; c < to && c < columns; c += 1) out[c] = 1;
    }
    return out;
  }

  it('gives a short hit its own length and a held one the window cap', () => {
    const level = levelOver(240, 4, [[0, 0.25], [2, 1.5]]);
    const [short, held] = onsetTickEnds([0, 2], level, 4);
    // Measured: the hit is over well inside the cap, so the release dates it.
    expect(short).toBeCloseTo(0.25, 1);
    // Sustained for 1.5 beats, but a block marks where a hit IS — it stops at
    // the cap rather than drawing the sustain.
    expect(held).toBeCloseTo(2 + TICK_MAX_BEATS, 5);
  });

  it('caps a sustained hit well before the next onset', () => {
    // Loud from beat 1 all the way out. The next onset at beat 2 used to be
    // what stopped it, which is how a dense passage filled in solid.
    const level = levelOver(240, 4, [[1, 3]]);
    expect(onsetTickEnds([1, 2], level, 4)[0]).toBeCloseTo(1 + TICK_MAX_BEATS, 5);
  });

  it('leaves a gap between consecutive hits however dense they are', () => {
    // Eight hits a beat apart, each sustaining into the next: the property
    // that actually matters is that no block touches the one after it.
    const level = new Array(240).fill(1);
    const onsets = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
    const ends = onsetTickEnds(onsets, level, 4);
    for (let i = 0; i + 1 < onsets.length; i += 1) {
      expect(ends[i]).toBeLessThanOrEqual(onsets[i + 1]);
    }
    expect(Math.max(...ends.map((e, i) => e - onsets[i]))).toBeLessThanOrEqual(TICK_MAX_BEATS + 1e-9);
  });

  it('ends a hit on its return to the bed, not on its own peak', () => {
    // A hit on top of a mix that never goes quiet: level 0.6 throughout, one
    // hit taking it to 1.0 for a quarter beat. A third of the PEAK is 0.33,
    // which the bed never reaches, so the block used to run to the cap. A
    // third of the RISE is 0.73, which the bed is under immediately.
    const level = new Array(240).fill(0.6);
    for (let c = 60; c < 75; c += 1) level[c] = 1;
    const end = onsetTickEnds([1, 2], level, 4)[0];
    expect(end).toBeCloseTo(1.25, 1);
    expect(end).toBeLessThan(1 + TICK_MAX_BEATS);
  });

  it('never returns a block too short to grab', () => {
    // A hit that is over within one column still gets a usable block.
    const level = levelOver(240, 4, [[1, 0.02]]);
    expect(onsetTickEnds([1], level, 4)[0]).toBeGreaterThanOrEqual(1 + TICK_MIN_BEATS - 1e-9);
  });

  it('rides through a dip instead of ending the hit on it', () => {
    const level = levelOver(240, 4, [[0, 2]]);
    level[30] = 0; // one column of a tremolo
    // The window cap would end this at 0.5 whatever the dip did, which would
    // make the assertion pass for the wrong reason — so this one asks for the
    // release rule on its own.
    expect(onsetTickEnds([0], level, 4, { maxBeats: 4 })[0]).toBeGreaterThan(1);
  });

  it('ends a quiet hit at the window floor instead of chasing its own tail', () => {
    // A hit peaking at a tenth of the window's loudest: a third of THAT peak
    // is under the noise, so the floor is what ends it.
    const level = new Array(240).fill(0.02);
    for (let c = 0; c < 12; c += 1) level[c] = 1;      // the loud hit at beat 0
    for (let c = 120; c < 200; c += 1) level[c] = 0.1; // the quiet one at beat 2
    const ends = onsetTickEnds([0, 2], level, 4);
    expect(ends[1]).toBeCloseTo(2 + TICK_MIN_BEATS, 5);
  });

  it('hands the ends back in the order the onsets came in', () => {
    const level = levelOver(240, 4, [[0, 0.25], [2, 1.5]]);
    const [held, short] = onsetTickEnds([2, 0], level, 4);
    expect(short).toBeCloseTo(0.25, 1);
    expect(held).toBeCloseTo(2 + TICK_MAX_BEATS, 5);
  });

  it('says nothing when there is no curve to read', () => {
    expect(onsetTickEnds([1], [], 4)).toEqual([]);
    expect(onsetTickEnds([], new Array(240).fill(1), 4)).toEqual([]);
    expect(onsetTickEnds([1], new Array(240).fill(1), 0)).toEqual([]);
  });
});
