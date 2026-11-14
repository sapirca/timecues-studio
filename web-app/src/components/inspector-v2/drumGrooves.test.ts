import { describe, it, expect } from 'vitest';
import {
  barSpan,
  describeBarChange,
  grooveHits,
  grooveLaneCounts,
  grooveRhythm,
  grooveSummary,
  type GrooveLaneModel,
} from './drumGrooves';
import {
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  type RiffNode,
  type RiffOccurrence,
  type RiffPatternItem,
} from '../../types/annotationLayer';
import { riffGrooveLane } from './riffGrooves';

const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

/** A node of one-16th hits at `steps`, `beats` long, each struck at `accent`. */
function node(name: string, steps: number[], accent?: number, extra: Partial<RiffNode> = {}, beats = 4): RiffNode {
  return {
    ...newRiffNode(name, '#f59e0b', beats),
    segments: steps.map((st) => ({
      start: st / 4, end: (st + 1) / 4, kind: 'tick' as const, ...(accent != null ? { accent } : {}),
    })),
    ...extra,
  };
}

/** `reps` plays of `n` from `start` seconds, one cycle = the node (2 s a bar at 120 BPM). */
function item(start: number, n: RiffNode, reps = 1, occurrences?: RiffOccurrence[]): RiffPatternItem {
  const cycleSec = n.stepsPerCycle / 8;
  return {
    ...newRiffPatternItem(start, start + cycleSec, n.name),
    sequence: [newRiffSeqEntry(n.id, n.stepsPerCycle)],
    repeatCount: reps,
    ...(occurrences ? { occurrences } : {}),
  };
}

function lane(drum: string | undefined, nodes: RiffNode[], items: RiffPatternItem[]): GrooveLaneModel {
  const layer = { ...newRiffPatternLayer('Groove', '#38bdf8'), nodes, items, ...(drum ? { drum } : {}) };
  return riffGrooveLane(layer, GRID).model;
}

const NAMES = ['four on the floor', 'backbeat'];

// Groove A, four bars from 0 s, one lane per drum: kick on the beats, snare on
// 2 & 4, hat on the &s. Bar 2 drops the hat on step 6; bar 4 fills two snares.
const HAT = node('A', [2, 6, 10, 14], 60, { names: NAMES });
const SNARE = node('A', [4, 12], 110, { names: NAMES });
const KICK = node('A', [0, 4, 8, 12], 120, { names: NAMES });
const hatLane = () => lane('hat', [HAT], [item(0, HAT, 4, [{ index: 1, event: 'variation', missing: [{ start: 1.5 }] }])]);
const snareLane = () => lane('snare', [SNARE], [item(0, SNARE, 4, [
  { index: 3, event: 'fill', added: [{ start: 3.5, end: 3.75 }, { start: 3.75, end: 4 }] },
])]);
const kickLane = () => lane('kick', [KICK], [item(0, KICK, 4)]);

describe('barSpan', () => {
  it('names a cell by the bars it covers', () => {
    expect(barSpan({ bar: 3, bars: 2 })).toBe('Bars 3–4');
    expect(barSpan({ bar: 3, bars: 1 })).toBe('Bar 3');
  });
});

describe('describeBarChange', () => {
  it('says what a bar changed in drums, not steps', () => {
    const hat = hatLane();
    expect(describeBarChange(hat.bars[0])).toBe('');
    expect(describeBarChange(hat.bars[1])).toBe('−1 hat');
    expect(describeBarChange(snareLane().bars[3])).toBe('+2 snare');
  });

  it('names the bass when the lane is the bass, and a tom fill as added toms', () => {
    const bassNode = node('A', [0, 4, 6, 8, 12], 100);
    const bass = lane('bass', [bassNode], [item(0, bassNode, 2, [{ index: 1, event: 'variation', missing: [{ start: 1.5 }] }])]);
    expect(bass.rows).toEqual(['bass']);
    expect(describeBarChange(bass.bars[1])).toBe('−1 bass');
    expect(grooveHits(bass.bars).bass.map((h) => h.step)).toEqual([0, 4, 6, 8, 12, 0, 4, 8, 12]);

    // An empty tom node: no toms is what the groove plays, the fill adds them.
    const tomNode = node('A', []);
    const toms = lane('toms', [tomNode], [item(0, tomNode, 2, [{
      index: 1, event: 'fill', added: [{ start: 3.25, end: 3.5 }, { start: 3.5, end: 3.75 }, { start: 3.75, end: 4 }],
    }])]);
    expect(toms.rows).toEqual(['toms']);
    expect(describeBarChange(toms.bars[1])).toBe('+3 toms');
    expect(grooveHits(toms.bars).toms.map((h) => h.step)).toEqual([13, 14, 15]);
  });
});

describe('grooveLaneCounts', () => {
  it('counts bars, split by the named groove they play', () => {
    expect(grooveLaneCounts(hatLane())).toEqual({
      total: 4, noun: 'bars', kinds: [{ kind: 'A · four on the floor, backbeat', count: 4 }],
    });
  });

  it('counts a groove that returns later as the same one, most played first', () => {
    const b = node('B', [0, 8]);
    const counts = grooveLaneCounts(lane('hat', [HAT, b], [item(0, HAT, 4), item(8, b, 1), item(60, HAT, 2)]));
    expect(counts).toEqual({
      total: 7, noun: 'bars',
      kinds: [{ kind: 'A · four on the floor, backbeat', count: 6 }, { kind: 'B', count: 1 }],
    });
  });

  it('counts the bars a longer loop plays, not its cycles', () => {
    const long = node('A', [0, 16], undefined, {}, 8);
    const model = lane('hat', [long], [item(0, long, 3)]);
    expect(model.bars.map((b) => [b.bar, b.bars, b.steps])).toEqual([[1, 2, 32], [3, 2, 32], [5, 2, 32]]);
    expect(grooveLaneCounts(model).kinds).toEqual([{ kind: 'A', count: 6 }]);
  });
});

describe('grooveHits', () => {
  it('puts each struck hit on the song clock, dropped hits left out', () => {
    // Bar 2 (2..4 s) dropped the hat on step 6; 16 steps a bar, 0.125 s a step.
    expect(grooveHits(hatLane().bars).hat.filter((h) => h.bar === 1).map((h) => h.time)).toEqual([2.25, 3.25, 3.75]);
    // Bar 4's fill: two snares added at steps 14 and 15.
    expect(grooveHits(snareLane().bars).snare.filter((h) => h.bar === 3).map((h) => h.step)).toEqual([4, 12, 14, 15]);
  });

  it('knows how long until the same drum strikes again, and how hard', () => {
    const { kick } = grooveHits(kickLane().bars);
    expect(kick[0].gap).toBeCloseTo(0.5);
    expect(kick.at(-1)!.gap).toBe(Infinity);
    expect(kick[0].strength).toBeCloseTo(120 / 127);
  });

  it('strikes an added hit, which has no accent of its own, at 0.8', () => {
    const fill = grooveHits(snareLane().bars).snare.filter((h) => h.bar === 3);
    expect(fill.map((h) => h.strength)).toEqual([110 / 127, 110 / 127, 0.8, 0.8]);
  });
});

describe('grooveRhythm', () => {
  it('reads the node by drum, in 16ths counted from 1', () => {
    expect(grooveRhythm(hatLane(), 'A')).toBe("A's rhythm: hat 3, 7, 11, 15");
    expect(grooveRhythm(hatLane(), 'Z')).toBeNull();
  });

  it('reads a 2-bar loop bar by bar', () => {
    const long = node('A', [0, 4, 8, 12], undefined, {}, 8);
    expect(grooveRhythm(lane('kick', [long], [item(0, long, 2)]), 'A'))
      .toBe("A's rhythm (2-bar loop): bar 1: kick 1, 5, 9, 13 / bar 2: nothing");
  });
});

describe('grooveSummary', () => {
  it('ranks the main loops by bars played, with where and what, and folds the rest into one clause', () => {
    const b = node('B', Array.from({ length: 16 }, (_, k) => k));
    const c = node('C', [0]);
    const model = lane('hat', [HAT, b, c], [item(0, HAT, 6), item(12, b, 3), item(18, c, 1)]);
    expect(grooveSummary(model)).toBe(
      '2 main loops over 10 bars, most played first. '
      + 'A — 6 bars (1–6), four on the floor, backbeat; rhythm: hat 3, 7, 11, 15. '
      + 'B — 3 bars (7–9); rhythm: hat 1–16. '
      + 'One other letter (C) plays 1 bar, each under 15% of the song.',
    );
  });

  it('counts a node of another length ("A · 8 beats") with its letter', () => {
    const long = node('A · 8 beats', [0, 16], undefined, {}, 8);
    const model = lane('hat', [HAT, long], [item(0, HAT, 2), item(4, long, 1)]);
    expect(grooveSummary(model)).toMatch(/^1 main loop over 4 bars, most played first\. A — 4 bars \(1–4\)/);
  });

  it('says nothing for an empty lane', () => {
    expect(grooveSummary(lane('hat', [], []))).toBeNull();
  });
});
