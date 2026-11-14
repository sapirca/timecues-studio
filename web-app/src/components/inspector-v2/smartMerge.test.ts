import { describe, it, expect } from 'vitest';
import { HAND_LANE_ID, type MergeSourceLane } from './boundaryMerge';
import {
  levelStepSignals, placeCluster, smartMergeBoundaryLanes, strongestLevelStep,
  type SmartMergeContext,
} from './smartMerge';

const lane = (id: string, times: number[]): MergeSourceLane =>
  ({ id, label: id, color: '#fff', times });

// 120 BPM, 4/4: a beat is 0.5 s, a bar 2 s, bar lines on even seconds.
const grid: SmartMergeContext['grid'] = {
  beatSec: 0.5,
  barSec: 2,
  snapToBar: (t) => Math.max(0, Math.round(t / 2) * 2),
};

/** A signal at `before` until `at`, then `after`, on a 10 ms axis. */
function stepSignal(name: string, at: number, before: number, after: number, seconds = 60) {
  const step = 0.01;
  const n = Math.round(seconds / step);
  const values = Float32Array.from({ length: n }, (_, i) => (i * step < at ? before : after));
  return { name, values, axis: { step, offset: 0, count: n } };
}

describe('levelStepSignals / strongestLevelStep', () => {
  it('finds a 20 dB rise where the level jumps tenfold', () => {
    const levels = levelStepSignals([stepSignal('Bass', 30, 0.1, 1)], 2);
    const s = strongestLevelStep(levels, 28, 32)!;
    expect(s.name).toBe('Bass');
    expect(s.time).toBeCloseTo(30, 1);
    expect(s.db).toBeCloseTo(20, 0);
  });

  it('reports nothing under the threshold', () => {
    const levels = levelStepSignals([stepSignal('Bass', 30, 0.8, 1)], 2);
    expect(strongestLevelStep(levels, 28, 32)).toBeNull();
  });

  it('floors a cut to silence instead of reading it as infinite', () => {
    const levels = levelStepSignals([stepSignal('Volume', 30, 1, 0)], 2);
    const s = strongestLevelStep(levels, 28, 32)!;
    expect(s.db).toBeLessThan(-50);
    expect(Number.isFinite(s.db)).toBe(true);
  });
});

describe('placeCluster', () => {
  it('prefers a figure in reach over everything else', () => {
    const levels = levelStepSignals([stepSignal('Bass', 32, 0.1, 1)], 2);
    const p = placeCluster([30.4, 30.9], { grid, levels, figures: [{ time: 31.1, label: 'drop' }] });
    expect(p.time).toBe(32);
    expect(p.placement.kind).toBe('figure');
    expect(p.placement.note).toContain('drop');
  });

  it('ignores a figure out of reach', () => {
    const p = placeCluster([30.4], { grid, figures: [{ time: 40, label: 'drop' }] });
    expect(p.placement.kind).toBe('bar');
    expect(p.time).toBe(30);
  });

  it('puts a figure more than a beat into its bar on the bar line too', () => {
    // A build starting 1.2 beats past bar 30 (El Jaguar 4:25): on the grid.
    const p = placeCluster([30.4], { grid, figures: [{ time: 30.6, label: 'build · 7 bars starts' }] });
    expect(p).toEqual({ time: 30, placement: { kind: 'figure', note: 'on “build · 7 bars starts”, on the bar line' } });
  });

  it('with no grid, keeps a figure where the stems moved', () => {
    expect(placeCluster([30.4], { figures: [{ time: 30.6, label: 'drop' }] }).time).toBe(30.6);
  });

  it('pulls a figure within a beat onto its bar line', () => {
    const p = placeCluster([31.2], { grid, figures: [{ time: 31.6, label: 'bass in' }] });
    expect(p).toEqual({ time: 32, placement: { kind: 'figure', note: 'on “bass in”, on the bar line' } });
  });

  it('puts the boundary on the bar line in reach the music turns on hardest', () => {
    // The votes' median (30.8) is nearer bar 30; the bass comes in on bar 32,
    // just in reach (half a bar past the last vote).
    const levels = levelStepSignals([stepSignal('Bass', 32, 0.1, 1)], 2);
    const p = placeCluster([30.6, 31.0], { grid, levels });
    expect(p).toMatchObject({ time: 32, placement: { kind: 'signal', note: 'Bass +20 dB across this bar line' } });
  });

  it('reads a step between bar lines as the bar it spills into', () => {
    const levels = levelStepSignals([stepSignal('Highs', 31, 1, 0.1)], 2);
    const p = placeCluster([30.6, 31.2], { grid, levels });
    expect(p.placement.kind).toBe('signal');
    expect(p.time).toBe(32);
    expect(p.placement.note).toMatch(/^Highs −1\d dB across this bar line$/);
  });

  it('with no grid, takes the step where it is', () => {
    const levels = levelStepSignals([stepSignal('Highs', 31, 1, 0.1)], 2);
    const p = placeCluster([30.6, 31.2], { levels });
    expect(p.time).toBeCloseTo(31, 1);
    expect(p.placement.note).toBe('Highs −20 dB');
  });

  it('leaves a quiet stretch on the nearest bar', () => {
    const levels = levelStepSignals([stepSignal('Bass', 32, 0.8, 1)], 2);
    expect(placeCluster([30.4], { grid, levels }).placement.kind).toBe('bar');
  });

  it('falls back to the nearest bar line, then to the middle vote', () => {
    expect(placeCluster([29.2, 29.9, 30.3], { grid })).toEqual({ time: 30, placement: { kind: 'bar', note: 'on the nearest bar line' } });
    expect(placeCluster([29.2, 29.9, 30.3], {}).time).toBe(29.9);
  });
});

describe('smartMergeBoundaryLanes', () => {
  it('turns votes within a bar into one candidate that names every lane', () => {
    const merged = smartMergeBoundaryLanes(
      [lane('a', [29.6, 60]), lane('b', [30.3]), lane('c', [30.9])],
      { grid },
    );
    expect(merged.map((b) => [b.time, b.agreement])).toEqual([[30, 3], [60, 1]]);
    expect(merged[0].laneIds).toEqual(['a', 'b', 'c']);
    expect(merged[0].rawTimes).toEqual([29.6, 30.3, 30.9]);
    expect(merged[0].smart?.kind).toBe('bar');
  });

  it('does not chain a cluster past a bar from its first vote', () => {
    const merged = smartMergeBoundaryLanes([lane('a', [10, 11.5, 13, 14.5])], { grid });
    expect(merged.map((b) => b.time)).toEqual([10, 14]);
  });

  it('folds two clusters that land on the same line', () => {
    // 28.0 + 29.9 are one cluster, 30.1 (2.1 s past its first vote) another;
    // their reaches overlap, and a figure at 30.5 takes both — onto bar 30.
    const merged = smartMergeBoundaryLanes(
      [lane('a', [28.0]), lane('b', [29.9]), lane('c', [30.1])],
      { grid, figures: [{ time: 30.5, label: 'change' }] },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ time: 30, agreement: 3, laneIds: ['a', 'b', 'c'], rawTimes: [28, 29.9, 30.1] });
  });

  it('never moves a hand split, and drops and edits key on the placed time', () => {
    const merged = smartMergeBoundaryLanes(
      [lane('a', [30.3])],
      { grid },
      [30],
      [{ at: 30, label: 'Drop' }],
      [45.37],
    );
    expect(merged.map((b) => [b.time, b.kept])).toEqual([[30, false], [45.37, true]]);
    expect(merged[0].edit?.label).toBe('Drop');
    expect(merged[1].laneIds).toEqual([HAND_LANE_ID]);
    expect(merged[1].smart).toBeUndefined();
  });

  it('folds candidates a bar apart into the stronger one — a section is at least two bars', () => {
    // Bars 30 and 32: two clusters, one line each. The figure at 32 wins, and
    // takes the bar-30 votes with it.
    const merged = smartMergeBoundaryLanes(
      [lane('a', [29.8]), lane('b', [31.9]), lane('c', [32.1])],
      { grid, figures: [{ time: 32, label: 'drop' }] },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ time: 32, agreement: 3, rawTimes: [29.8, 31.9, 32.1] });
    expect(merged[0].smart?.note).toBe('on “drop”, on the bar line · took in 1 line under 2 bars away');
  });

  it('with nothing to choose by, keeps the line more lanes voted for', () => {
    const merged = smartMergeBoundaryLanes([lane('a', [30, 32.2]), lane('b', [32.1])], { grid });
    expect(merged.map((b) => [b.time, b.agreement])).toEqual([[32, 2]]);
  });

  it('keeps two lines two bars apart', () => {
    const merged = smartMergeBoundaryLanes([lane('a', [30, 34])], { grid });
    expect(merged.map((b) => b.time)).toEqual([30, 34]);
  });

  it('never folds away a hand split, however close', () => {
    const merged = smartMergeBoundaryLanes([lane('a', [30])], { grid }, [], [], [31]);
    expect(merged.map((b) => b.time)).toEqual([30, 31]);
  });

  it('is empty with no members', () => {
    expect(smartMergeBoundaryLanes([], { grid }, [], [], [12])).toEqual([]);
  });
});
