import { describe, expect, it } from 'vitest';
import {
  alignBoundaryToOnsets,
  appendBoundaryTick,
  BOUNDARY_MIN_SEGMENT_BEATS,
  boundarySegmentIndexAt,
  boundarySegmentsFromHits,
  boundarySegmentsFromTaps,
  dropBoundaryTickAt,
  isBoundaryNode,
  mergeBoundaryHits,
  moveBoundary,
  newRiffBoundaryNode,
  newRiffNode,
  normalizeBoundarySegments,
  paintBoundaryRange,
  removeBoundarySegment,
  resizeBoundaryNodeLength,
  riffNodeLengthBeats,
  snapBoundaryToOnsets,
  splitBoundaryAt,
  type RiffBoundarySegment,
} from './annotationLayer';

/** Compact `[start, end, kind]` view — the assertions read like the block
 *  list the editor shows, instead of a wall of object literals. */
const shape = (segs: readonly RiffBoundarySegment[]) =>
  segs.map((s) => [s.start, s.end, s.kind] as const);

describe('normalizeBoundarySegments', () => {
  it('tiles the whole node, filling gaps with rests', () => {
    // The exact list from the feature request: two adjacent ticks with rests
    // either side, and only the ticks supplied by the caller.
    const out = normalizeBoundarySegments(
      [{ start: 2, end: 2.5, kind: 'tick' }, { start: 2.5, end: 3, kind: 'tick' }],
      4,
    );
    expect(shape(out)).toEqual([
      [0, 2, 'empty'],
      [2, 2.5, 'tick'],
      [2.5, 3, 'tick'],
      [3, 4, 'empty'],
    ]);
  });

  it('keeps adjacent ticks separate but merges adjacent rests', () => {
    const out = normalizeBoundarySegments(
      [
        { start: 0, end: 1, kind: 'empty' },
        { start: 1, end: 2, kind: 'empty' },
        { start: 2, end: 3, kind: 'tick' },
        { start: 3, end: 4, kind: 'tick' },
      ],
      4,
    );
    expect(shape(out)).toEqual([[0, 2, 'empty'], [2, 3, 'tick'], [3, 4, 'tick']]);
  });

  it('does not merge rests that carry their own labels', () => {
    const out = normalizeBoundarySegments(
      [
        { start: 0, end: 1, kind: 'empty', label: 'count-in' },
        { start: 1, end: 2, kind: 'empty' },
      ],
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0].label).toBe('count-in');
  });

  it('trims an overlap in favour of the earlier block', () => {
    const out = normalizeBoundarySegments(
      [{ start: 0, end: 3, kind: 'tick' }, { start: 1, end: 4, kind: 'tick' }],
      4,
    );
    expect(shape(out)).toEqual([[0, 3, 'tick'], [3, 4, 'tick']]);
  });

  it('drops a block that an overlap leaves nothing of', () => {
    const out = normalizeBoundarySegments(
      [{ start: 0, end: 4, kind: 'tick' }, { start: 1, end: 2, kind: 'tick' }],
      4,
    );
    expect(shape(out)).toEqual([[0, 4, 'tick']]);
  });

  it('clamps blocks to the node and drops degenerate ones', () => {
    const out = normalizeBoundarySegments(
      [
        { start: -2, end: 1, kind: 'tick' },
        { start: 1, end: 1, kind: 'tick' },
        { start: 3, end: 99, kind: 'tick' },
      ],
      4,
    );
    expect(shape(out)).toEqual([[0, 1, 'tick'], [1, 3, 'empty'], [3, 4, 'tick']]);
  });

  it('yields one full-length rest for an empty input, and nothing at zero length', () => {
    expect(shape(normalizeBoundarySegments([], 4))).toEqual([[0, 4, 'empty']]);
    expect(normalizeBoundarySegments([], 0)).toEqual([]);
  });

  it('always reaches exactly the node end, even with a sub-epsilon tail', () => {
    const len = 4;
    const out = normalizeBoundarySegments(
      [{ start: 0, end: len - BOUNDARY_MIN_SEGMENT_BEATS / 2, kind: 'tick' }],
      len,
    );
    expect(out).toHaveLength(1);
    expect(out[out.length - 1].end).toBe(len);
  });

  it('keeps fractional edges instead of rounding them to a grid', () => {
    const out = normalizeBoundarySegments([{ start: 0.37, end: 1.11, kind: 'tick' }], 2);
    expect(shape(out)).toEqual([[0, 0.37, 'empty'], [0.37, 1.11, 'tick'], [1.11, 2, 'empty']]);
  });
});

describe('boundarySegmentsFromHits — onset positions, fixed lengths', () => {
  it('opens a tick at each onset that runs to the next one', () => {
    expect(shape(boundarySegmentsFromHits([2, 2.5].map((beat) => ({ beat })), 4))).toEqual([
      [0, 2, 'empty'],
      [2, 2.5, 'tick'],
      [2.5, 3.5, 'tick'],
      [3.5, 4, 'empty'],
    ]);
  });

  it('caps a trailing tick so a long rest stays visible as a rest', () => {
    expect(shape(boundarySegmentsFromHits([0].map((beat) => ({ beat })), 4))).toEqual([[0, 1, 'tick'], [1, 4, 'empty']]);
  });

  it('honours a custom tick cap', () => {
    expect(shape(boundarySegmentsFromHits([0].map((beat) => ({ beat })), 4, { maxTickBeats: 0.25 }))).toEqual([
      [0, 0.25, 'tick'],
      [0.25, 4, 'empty'],
    ]);
  });

  it('ignores onsets outside the node and sorts the rest', () => {
    expect(shape(boundarySegmentsFromHits([5, 1, -1, 0.25].map((beat) => ({ beat })), 2, { maxTickBeats: 0.5 }))).toEqual([
      [0, 0.25, 'empty'],
      [0.25, 0.75, 'tick'],
      [0.75, 1, 'empty'],
      [1, 1.5, 'tick'],
      [1.5, 2, 'empty'],
    ]);
  });

  it('preserves un-quantised onset positions exactly', () => {
    // The whole point of the kind: 0.37 does NOT become 0.25 or 0.5.
    const out = boundarySegmentsFromHits([0.37].map((beat) => ({ beat })), 2, { maxTickBeats: 0.5 });
    expect(out[1].start).toBe(0.37);
    expect(out[1].end).toBe(0.87);
  });

  it('gives one full-length rest when nothing was detected', () => {
    expect(shape(boundarySegmentsFromHits([], 4))).toEqual([[0, 4, 'empty']]);
  });
});

describe('normalizeBoundarySegments — sub-epsilon gaps', () => {
  it('gives a gap too narrow to be its own block to the previous one', () => {
    // A capped tick that stops a hair before the next one must not leave a
    // hole: every consumer is promised segments[i].end === segments[i+1].start.
    const out = normalizeBoundarySegments([
      { start: 0, end: 1.995, kind: 'tick' },
      { start: 2, end: 3, kind: 'tick' },
    ], 4);
    expect(shape(out)).toEqual([[0, 2, 'tick'], [2, 3, 'tick'], [3, 4, 'empty']]);
  });

  it('pulls a first block that starts a hair after zero back onto zero', () => {
    expect(shape(normalizeBoundarySegments([{ start: 0.005, end: 1, kind: 'tick' }], 4)))
      .toEqual([[0, 1, 'tick'], [1, 4, 'empty']]);
  });
});

describe('boundarySegmentsFromHits', () => {
  it('lets a sustained hit keep the length it was held for, past the point cap', () => {
    expect(shape(boundarySegmentsFromHits([{ beat: 0, endBeat: 2.5 }], 4))).toEqual([
      [0, 2.5, 'tick'],
      [2.5, 4, 'empty'],
    ]);
  });

  it('keeps a hit that lands hard against the node\u2019s end', () => {
    // A block from 3.997 to 4 is narrower than the minimum width, so it used
    // to be normalised away: the last onset in a node was detected, drawn and
    // counted in the alignment readout, and then marked by nothing at all.
    const segs = boundarySegmentsFromHits([{ beat: 0 }, { beat: 3.997 }], 4);
    expect(segs.filter((s) => s.kind === 'tick')).toHaveLength(2);
    expect(segs[segs.length - 1].end).toBe(4);
  });

  it('still caps a point hit, which never claimed a duration', () => {
    expect(shape(boundarySegmentsFromHits([{ beat: 0 }], 4))).toEqual([[0, 1, 'tick'], [1, 4, 'empty']]);
  });

  it('trims a sustained hit at the next hit rather than overlapping it', () => {
    expect(shape(boundarySegmentsFromHits([{ beat: 0, endBeat: 3 }, { beat: 1 }], 4))).toEqual([
      [0, 1, 'tick'],
      [1, 2, 'tick'],
      [2, 4, 'empty'],
    ]);
  });

  it('carries a label onto its block — a lyric keeps its words', () => {
    const out = boundarySegmentsFromHits([{ beat: 1, endBeat: 2, label: 'never' }], 4);
    expect(out.find((s) => s.kind === 'tick')?.label).toBe('never');
  });

  it('quantises to a snap when asked, and to nothing when not', () => {
    expect(shape(boundarySegmentsFromHits([{ beat: 0.47 }], 4, { snapBeats: 0.5 }))).toEqual([
      [0, 0.5, 'empty'],
      [0.5, 1.5, 'tick'],
      [1.5, 4, 'empty'],
    ]);
    expect(boundarySegmentsFromHits([{ beat: 0.47 }], 4)[1].start).toBe(0.47);
  });

  it('degrades a held hit whose release snaps back onto its start to a point', () => {
    // 1.1 → 1 and 1.2 → 1 at a 1-beat snap: no duration survives, so it's a
    // point hit (capped) rather than a zero-width block that gets dropped.
    expect(shape(boundarySegmentsFromHits([{ beat: 1.1, endBeat: 1.2 }], 4, { snapBeats: 1 }))).toEqual([
      [0, 1, 'empty'],
      [1, 2, 'tick'],
      [2, 4, 'empty'],
    ]);
  });
});

describe('boundarySegmentsFromTaps', () => {
  it('folds repeated passes at the same hit into one, at their median', () => {
    const taps = [{ beat: 1.05 }, { beat: 0.95 }, { beat: 1 }];
    expect(shape(boundarySegmentsFromTaps(taps, 4))).toEqual([
      [0, 1, 'empty'],
      [1, 1.5, 'tick'],
      [1.5, 4, 'empty'],
    ]);
  });

  it('keeps hits further apart than the cluster tolerance separate', () => {
    expect(shape(boundarySegmentsFromTaps([{ beat: 1 }, { beat: 1.5 }], 4))).toEqual([
      [0, 1, 'empty'],
      [1, 1.5, 'tick'],
      [1.5, 2, 'tick'],
      [2, 4, 'empty'],
    ]);
  });

  it('holds a clustered hit only when at least half its taps were held', () => {
    // One hold among three taps is a slip, not a hold.
    expect(shape(boundarySegmentsFromTaps([{ beat: 1, endBeat: 3 }, { beat: 1 }, { beat: 1 }], 4))).toEqual([
      [0, 1, 'empty'],
      [1, 1.5, 'tick'],
      [1.5, 4, 'empty'],
    ]);
    // One out of two is half — the hold stands, with its real duration.
    expect(shape(boundarySegmentsFromTaps([{ beat: 1, endBeat: 3 }, { beat: 1 }], 4))).toEqual([
      [0, 1, 'empty'],
      [1, 3, 'tick'],
      [3, 4, 'empty'],
    ]);
  });

  it('votes: keeps only hits enough passes agree on', () => {
    // Three passes over the same bar. Beat 1 is in all three, beat 2 in two,
    // beat 3 tapped once — a slip. Without a vote all three land as blocks.
    const taps = [
      { beat: 1, endBeat: 1.2, pass: 0 }, { beat: 1.02, endBeat: 1.2, pass: 1 }, { beat: 0.98, endBeat: 1.2, pass: 2 },
      { beat: 2, endBeat: 2.2, pass: 0 }, { beat: 2.03, endBeat: 2.2, pass: 1 },
      { beat: 3, endBeat: 3.2, pass: 1 },
    ];
    const kept = (minPasses: number) => boundarySegmentsFromTaps(taps, 4, 0, { minPasses })
      .filter((seg) => seg.kind === 'tick')
      .map((seg) => seg.start);
    // Each kept hit sits at its group's median — 2 and 2.03 average to 2.015.
    expect(kept(1)).toEqual([1, 2.015, 3]);
    expect(kept(2)).toEqual([1, 2.015]);
    expect(kept(3)).toEqual([1]);
  });

  it('counts passes, not taps — tapping twice in one pass is still one vote', () => {
    const taps = [
      { beat: 1, endBeat: 1.2, pass: 0 }, { beat: 1.01, endBeat: 1.2, pass: 0 }, { beat: 1.02, endBeat: 1.2, pass: 0 },
    ];
    expect(boundarySegmentsFromTaps(taps, 4, 0, { minPasses: 2 }).some((s) => s.kind === 'tick')).toBe(false);
    expect(boundarySegmentsFromTaps(taps, 4, 0, { minPasses: 1 }).some((s) => s.kind === 'tick')).toBe(true);
  });

  it('takes the fold distance from the caller, and folds nothing at 0', () => {
    const taps = [{ beat: 1, endBeat: 1.1, pass: 0 }, { beat: 1.2, endBeat: 1.3, pass: 1 }];
    // 0.2 beats apart: one hit under the default quarter-beat fold…
    expect(boundarySegmentsFromTaps(taps, 4).filter((s) => s.kind === 'tick')).toHaveLength(1);
    // …two under a tighter one, and two again with folding off entirely.
    expect(boundarySegmentsFromTaps(taps, 4, 0, { clusterBeats: 0.125 }).filter((s) => s.kind === 'tick')).toHaveLength(2);
    expect(boundarySegmentsFromTaps(taps, 4, 0, { clusterBeats: 0 }).filter((s) => s.kind === 'tick')).toHaveLength(2);
  });

  it('pulls an eager tap taken just before beat 0 onto beat 0 instead of dropping it', () => {
    expect(shape(boundarySegmentsFromTaps([{ beat: -0.05 }], 4))).toEqual([
      [0, 0.5, 'tick'],
      [0.5, 4, 'empty'],
    ]);
  });

  it('runs each block from the press to the release, and no further', () => {
    // The Tap Along contract on a boundary node: press = start, release =
    // end. A held hit is never stretched to meet the next one, and a short
    // one is never padded out to a beat.
    expect(shape(boundarySegmentsFromTaps([
      { beat: 0.5, endBeat: 0.72 },
      { beat: 2, endBeat: 3.4 },
    ], 4))).toEqual([
      [0, 0.5, 'empty'],
      [0.5, 0.72, 'tick'],
      [0.72, 2, 'empty'],
      [2, 3.4, 'tick'],
      [3.4, 4, 'empty'],
    ]);
  });

  it('keeps every tap exactly where it landed when snap is free', () => {
    const out = boundarySegmentsFromTaps([{ beat: 0.37, endBeat: 0.61 }], 4);
    expect(out[1].start).toBe(0.37);
    expect(out[1].end).toBe(0.61);
  });

  it('quantises the session when a snap is picked', () => {
    const out = boundarySegmentsFromTaps([{ beat: 0.37, endBeat: 0.61 }], 4, 0.5);
    expect(out[0].start).toBe(0);
    expect(out.find((s) => s.kind === 'tick')).toEqual({ start: 0.5, end: 1, kind: 'tick' });
  });
});

describe('boundarySegmentIndexAt', () => {
  const segs = normalizeBoundarySegments([{ start: 2, end: 2.5, kind: 'tick' }], 4);

  it('maps a relative beat position onto the block containing it', () => {
    expect(boundarySegmentIndexAt(segs, 0)).toBe(0);
    expect(boundarySegmentIndexAt(segs, 1.99)).toBe(0);
    expect(boundarySegmentIndexAt(segs, 2)).toBe(1);
    expect(boundarySegmentIndexAt(segs, 2.4999)).toBe(1);
    expect(boundarySegmentIndexAt(segs, 2.5)).toBe(2);
  });

  it('includes the node end so a playhead on the final edge still highlights', () => {
    expect(boundarySegmentIndexAt(segs, 4)).toBe(2);
  });

  it('returns -1 outside the node', () => {
    expect(boundarySegmentIndexAt(segs, -0.1)).toBe(-1);
    expect(boundarySegmentIndexAt(segs, 4.1)).toBe(-1);
    expect(boundarySegmentIndexAt(segs, NaN)).toBe(-1);
  });
});

describe('editor operations', () => {
  it('splits a block in two at the given beat, keeping its kind', () => {
    const segs = normalizeBoundarySegments([{ start: 0, end: 4, kind: 'tick' }], 4);
    expect(shape(splitBoundaryAt(segs, 1.5, 4))).toEqual([[0, 1.5, 'tick'], [1.5, 4, 'tick']]);
  });

  it('refuses a split that would leave a sliver', () => {
    const segs = normalizeBoundarySegments([{ start: 0, end: 4, kind: 'tick' }], 4);
    expect(splitBoundaryAt(segs, BOUNDARY_MIN_SEGMENT_BEATS / 2, 4)).toEqual(segs);
  });

  it('moves an interior boundary and clamps it off its neighbours', () => {
    const segs = normalizeBoundarySegments([{ start: 2, end: 4, kind: 'tick' }], 4);
    expect(shape(moveBoundary(segs, 1, 1, 4))).toEqual([[0, 1, 'empty'], [1, 4, 'tick']]);
    // Past the far edge — clamped, never inverted.
    const pushed = moveBoundary(segs, 1, 99, 4);
    expect(pushed[pushed.length - 1].end).toBe(4);
    expect(pushed[0].end).toBeLessThan(4);
  });

  it('leaves the node start and end alone', () => {
    const segs = normalizeBoundarySegments([{ start: 2, end: 4, kind: 'tick' }], 4);
    expect(moveBoundary(segs, 0, 1, 4)).toEqual(segs);
    expect(moveBoundary(segs, segs.length, 1, 4)).toEqual(segs);
  });

  it('paints a span as ONE block, whatever was under it', () => {
    // The gesture the node kind is for: "between 2 and 3.5, this happens".
    const segs = normalizeBoundarySegments([], 4);
    expect(shape(paintBoundaryRange(segs, 2, 3.5, 'tick', 4))).toEqual([
      [0, 2, 'empty'],
      [2, 3.5, 'tick'],
      [3.5, 4, 'empty'],
    ]);
    // Painted over three existing blocks, it still comes back as one — two
    // adjacent ticks would read as two hits, not the single span drawn.
    const busy = normalizeBoundarySegments(
      [{ start: 1, end: 1.5, kind: 'tick' }, { start: 2, end: 2.5, kind: 'tick' }],
      4,
    );
    expect(shape(paintBoundaryRange(busy, 0.5, 3, 'tick', 4))).toEqual([
      [0, 0.5, 'empty'],
      [0.5, 3, 'tick'],
      [3, 4, 'empty'],
    ]);
  });

  it('paints backwards, and clamps a span to the node', () => {
    const segs = normalizeBoundarySegments([], 4);
    const back = paintBoundaryRange(segs, 3.5, 2, 'tick', 4);
    expect(shape(back)).toEqual(shape(paintBoundaryRange(segs, 2, 3.5, 'tick', 4)));
    expect(shape(paintBoundaryRange(segs, -2, 99, 'tick', 4))).toEqual([[0, 4, 'tick']]);
  });

  it('trims the neighbours a painted span eats into, keeping their labels', () => {
    const segs = normalizeBoundarySegments([{ start: 0, end: 2, kind: 'tick', label: 'snare' }], 4);
    const out = paintBoundaryRange(segs, 1, 3, 'empty', 4);
    expect(shape(out)).toEqual([[0, 1, 'tick'], [1, 4, 'empty']]);
    expect(out[0].label).toBe('snare');
    // The painted rest merged with the trailing one — rests always merge —
    // and carries no label of its own.
    expect(out[1].label).toBeUndefined();
  });

  it('drops a short tick where the strip was clicked, not over the whole block', () => {
    // The fresh-node case: one block covering everything. A click must not
    // turn all 8 beats into a single tick.
    const segs = normalizeBoundarySegments([], 8);
    expect(shape(dropBoundaryTickAt(segs, 2, 8))).toEqual([
      [0, 2, 'empty'],
      [2, 2.5, 'tick'],
      [2.5, 8, 'empty'],
    ]);
  });

  it('keeps a dropped tick inside the rest it was clicked in', () => {
    const segs = normalizeBoundarySegments([{ start: 2, end: 4, kind: 'tick' }], 4);
    // Clicked 0.1 beats before the rest ends — the tick shifts back to fit
    // rather than eating into the tick next door.
    expect(shape(dropBoundaryTickAt(segs, 1.9, 4))).toEqual([
      [0, 1.5, 'empty'],
      [1.5, 2, 'tick'],
      [2, 4, 'tick'],
    ]);
    // A rest narrower than a tick just becomes one.
    const tight = normalizeBoundarySegments(
      [{ start: 0, end: 1, kind: 'tick' }, { start: 1.2, end: 4, kind: 'tick' }],
      4,
    );
    expect(shape(dropBoundaryTickAt(tight, 1.1, 4))).toEqual([
      [0, 1, 'tick'],
      [1, 1.2, 'tick'],
      [1.2, 4, 'tick'],
    ]);
  });

  it('clears the tick a click lands on, whole', () => {
    const segs = normalizeBoundarySegments([{ start: 1, end: 3, kind: 'tick' }], 4);
    expect(shape(dropBoundaryTickAt(segs, 2, 4))).toEqual([[0, 4, 'empty']]);
  });

  it('ignores a degenerate paint', () => {
    const segs = normalizeBoundarySegments([{ start: 1, end: 2, kind: 'tick' }], 4);
    expect(paintBoundaryRange(segs, 2, 2, 'tick', 4)).toEqual(segs);
    expect(paintBoundaryRange(segs, 2, 2 + BOUNDARY_MIN_SEGMENT_BEATS / 2, 'tick', 4)).toEqual(segs);
  });

  it('hands a removed block to its previous neighbour', () => {
    const segs = normalizeBoundarySegments(
      [{ start: 1, end: 2, kind: 'tick' }, { start: 2, end: 3, kind: 'tick' }],
      4,
    );
    expect(shape(removeBoundarySegment(segs, 1, 4))).toEqual([
      [0, 2, 'empty'],
      [2, 3, 'tick'],
      [3, 4, 'empty'],
    ]);
  });

  it('removes a mistaken tick by clearing it, not by growing its neighbour', () => {
    // The stray-tap case: a bad tick wedged between two good ones. Handing
    // its span to the previous block would just make that tick longer — the
    // hit would still be there.
    const segs = normalizeBoundarySegments(
      [
        { start: 1, end: 1.5, kind: 'tick' },
        { start: 1.5, end: 1.6, kind: 'tick' },
        { start: 1.6, end: 2, kind: 'tick' },
      ],
      4,
    );
    expect(shape(removeBoundarySegment(segs, 2, 4))).toEqual([
      [0, 1, 'empty'],
      [1, 1.5, 'tick'],
      [1.5, 1.6, 'empty'],
      [1.6, 2, 'tick'],
      [2, 4, 'empty'],
    ]);
  });

  it('hands the first block to the next one when there is no previous', () => {
    const segs = normalizeBoundarySegments([{ start: 0, end: 2, kind: 'tick' }], 4);
    expect(shape(removeBoundarySegment(segs, 0, 4))).toEqual([[0, 4, 'empty']]);
  });

  it('leaves a single full-length rest when the last block is removed', () => {
    const segs = normalizeBoundarySegments([{ start: 0, end: 4, kind: 'tick' }], 4);
    expect(shape(removeBoundarySegment(segs, 0, 4))).toEqual([[0, 4, 'empty']]);
  });
});

describe('node plumbing', () => {
  it('marks only boundary nodes, treating a node with no kind as a grid node', () => {
    expect(isBoundaryNode(newRiffBoundaryNode('b', '#fff'))).toBe(true);
    expect(isBoundaryNode(newRiffNode('g', '#fff'))).toBe(false);
    expect(isBoundaryNode(undefined)).toBe(false);
  });

  it('starts a new boundary node as one full-length rest at its asked length', () => {
    const node = newRiffBoundaryNode('b', '#fff', 8);
    expect(riffNodeLengthBeats(node)).toBe(8);
    expect(shape(node.segments!)).toEqual([[0, 8, 'empty']]);
  });

  it('reports length in beats from the shared grid fields', () => {
    expect(riffNodeLengthBeats({ stepsPerCycle: 16, subbeatsPerBeat: 4 })).toBe(4);
    expect(riffNodeLengthBeats({ stepsPerCycle: 46, subbeatsPerBeat: 4 })).toBe(11.5);
  });

  it('re-tiles blocks when the node is resized', () => {
    const node = { ...newRiffBoundaryNode('b', '#fff', 4), segments: undefined as never };
    const seeded = {
      ...node,
      segments: boundarySegmentsFromHits([1, 3].map((beat) => ({ beat })), 4, { maxTickBeats: 0.5 }),
    };
    const shrunk = resizeBoundaryNodeLength(seeded, 2);
    expect(riffNodeLengthBeats({ ...seeded, ...shrunk })).toBe(2);
    expect(shape(shrunk.segments!)).toEqual([[0, 1, 'empty'], [1, 1.5, 'tick'], [1.5, 2, 'empty']]);

    const grown = resizeBoundaryNodeLength(seeded, 6);
    expect(shape(grown.segments!).at(-1)).toEqual([3.5, 6, 'empty']);
  });
});

describe('appendBoundaryTick', () => {
  it('lays ticks down left to right on repeated use', () => {
    let segs = normalizeBoundarySegments([], 4);
    segs = appendBoundaryTick(segs, 4);
    segs = appendBoundaryTick(segs, 4);
    segs = appendBoundaryTick(segs, 4);
    expect(shape(segs)).toEqual([
      [0, 0.5, 'tick'],
      [0.5, 1, 'tick'],
      [1, 1.5, 'tick'],
      [1.5, 4, 'empty'],
    ]);
  });

  it('resumes after the last tick even when a rest sits in between', () => {
    const segs = normalizeBoundarySegments([{ start: 1, end: 1.5, kind: 'tick' }], 4);
    expect(shape(appendBoundaryTick(segs, 4))).toEqual([
      [0, 1, 'empty'],
      [1, 1.5, 'tick'],
      [1.5, 2, 'tick'],
      [2, 4, 'empty'],
    ]);
  });

  it('falls back to an earlier rest when the tail is already full', () => {
    const segs = normalizeBoundarySegments([{ start: 1, end: 4, kind: 'tick' }], 4);
    expect(shape(appendBoundaryTick(segs, 4))).toEqual([
      [0, 0.5, 'tick'],
      [0.5, 1, 'empty'],
      [1, 4, 'tick'],
    ]);
  });

  it('honours a custom tick length and clips it to the rest', () => {
    const segs = normalizeBoundarySegments([], 0.25);
    expect(shape(appendBoundaryTick(segs, 0.25, 2))).toEqual([[0, 0.25, 'tick']]);
  });

  it('is a no-op when the node is already all ticks', () => {
    const segs = normalizeBoundarySegments([{ start: 0, end: 4, kind: 'tick' }], 4);
    expect(appendBoundaryTick(segs, 4)).toEqual(segs);
  });
});

describe('alignBoundaryToOnsets', () => {
  const segs = (starts: readonly number[], width = 0.25) =>
    normalizeBoundarySegments(starts.map((b) => ({ start: b, end: b + width, kind: 'tick' as const })), 4);

  it('counts the ticks that sit on an onset and reports the lag', () => {
    // Three ticks 50 ms-ish late (0.05 beat) against four onsets.
    const out = alignBoundaryToOnsets(segs([0.05, 1.05, 2.05]), [0, 1, 2, 3], 4);
    expect(out.ticks).toBe(3);
    expect(out.matched).toBe(3);
    expect(out.onsets).toBe(4);
    expect(out.missedOnsets).toBe(1);
    expect(out.medianOffsetBeats).toBeCloseTo(0.05, 6);
    expect(out.maxOffsetBeats).toBeCloseTo(0.05, 6);
  });

  it('does not match a tick further away than the tolerance', () => {
    const out = alignBoundaryToOnsets(segs([0.5]), [0, 1], 4);
    expect(out.matched).toBe(0);
    expect(out.medianOffsetBeats).toBeNull();
    expect(out.missedOnsets).toBe(2);
  });

  it('keeps the sign, so early and late are distinguishable', () => {
    expect(alignBoundaryToOnsets(segs([0.95]), [1], 4).medianOffsetBeats).toBeCloseTo(-0.05, 6);
    expect(alignBoundaryToOnsets(segs([1.05]), [1], 4).medianOffsetBeats).toBeCloseTo(0.05, 6);
  });

  it('ignores onsets outside the node', () => {
    // A placement can be stretched away from its node's length, so the
    // caller's onset list is not bounded by it.
    const out = alignBoundaryToOnsets(segs([1]), [1, 9], 4);
    expect(out.onsets).toBe(1);
    expect(out.missedOnsets).toBe(0);
  });

  it('reports an empty node rather than dividing by nothing', () => {
    const out = alignBoundaryToOnsets(normalizeBoundarySegments([], 4), [1, 2], 4);
    expect(out).toMatchObject({ ticks: 0, matched: 0, missedOnsets: 2, medianOffsetBeats: null });
  });
});

describe('snapBoundaryToOnsets', () => {
  it('slides a near-miss onto the onset and keeps the block’s length', () => {
    const before = normalizeBoundarySegments([{ start: 1.05, end: 1.55, kind: 'tick' }], 4);
    const after = snapBoundaryToOnsets(before, [1], 4);
    expect(shape(after)).toEqual([[0, 1, 'empty'], [1, 1.5, 'tick'], [1.5, 4, 'empty']]);
  });

  it('leaves a tick with no onset near it exactly where it was', () => {
    const before = normalizeBoundarySegments(
      [{ start: 1.05, end: 1.5, kind: 'tick' }, { start: 2.5, end: 3, kind: 'tick' }], 4,
    );
    const after = snapBoundaryToOnsets(before, [1], 4);
    expect(shape(after)).toEqual([
      [0, 1, 'empty'], [1, 1.45, 'tick'], [1.45, 2.5, 'empty'], [2.5, 3, 'tick'], [3, 4, 'empty'],
    ]);
  });

  it('keeps labels on the blocks it moves', () => {
    const before = normalizeBoundarySegments([{ start: 1.05, end: 1.5, kind: 'tick', label: 'chime' }], 4);
    expect(snapBoundaryToOnsets(before, [1], 4).find((s) => s.kind === 'tick')?.label).toBe('chime');
  });

  it('folds two ticks that snap to the same onset into one hit', () => {
    const before = normalizeBoundarySegments(
      [{ start: 0.95, end: 1.1, kind: 'tick' }, { start: 1.1, end: 1.4, kind: 'tick' }], 4,
    );
    const after = snapBoundaryToOnsets(before, [1], 4);
    expect(after.filter((s) => s.kind === 'tick')).toHaveLength(1);
  });

  it('is a no-op with no onsets to snap to', () => {
    const before = normalizeBoundarySegments([{ start: 1.05, end: 1.5, kind: 'tick' }], 4);
    expect(shape(snapBoundaryToOnsets(before, [], 4))).toEqual(shape(before));
  });

  it('never drops a hit to an overlap after moving', () => {
    // Two ticks snapping to two different onsets. The first is long enough
    // that, once the second slides back onto beat 2, it would swallow it —
    // and `normalizeBoundarySegments` resolves an overlap in favour of the
    // EARLIER block, so without the trim the second hit would vanish.
    const before = normalizeBoundarySegments(
      [{ start: 1.05, end: 2.06, kind: 'tick' }, { start: 2.06, end: 2.4, kind: 'tick' }], 4,
    );
    const after = snapBoundaryToOnsets(before, [1, 2], 4);
    expect(shape(after)).toEqual([
      [0, 1, 'empty'], [1, 2, 'tick'], [2, 2.34, 'tick'], [2.34, 4, 'empty'],
    ]);
  });
});

describe('mergeBoundaryHits', () => {
  it('adds the hits the node is not marking and keeps the ones it is', () => {
    const before = normalizeBoundarySegments([{ start: 0, end: 0.5, kind: 'tick', label: 'mine' }], 4);
    const after = mergeBoundaryHits(before, [{ beat: 0 }, { beat: 2 }], 4);
    expect(shape(after)).toEqual([
      [0, 0.5, 'tick'], [0.5, 2, 'empty'], [2, 2.5, 'tick'], [2.5, 4, 'empty'],
    ]);
    expect(after[0].label).toBe('mine');
  });

  it('treats a hit inside an existing tick as already marked', () => {
    const before = normalizeBoundarySegments([{ start: 1, end: 2, kind: 'tick' }], 4);
    expect(shape(mergeBoundaryHits(before, [{ beat: 1.5 }], 4))).toEqual(shape(before));
  });

  it('treats a hit within the match tolerance as already marked', () => {
    const before = normalizeBoundarySegments([{ start: 1, end: 1.5, kind: 'tick' }], 4);
    expect(shape(mergeBoundaryHits(before, [{ beat: 1.1 }], 4))).toEqual(shape(before));
  });

  it('carries an incoming label onto the block it creates', () => {
    const after = mergeBoundaryHits(normalizeBoundarySegments([], 4), [{ beat: 2, label: 'chime' }], 4);
    expect(after.find((s) => s.kind === 'tick')?.label).toBe('chime');
  });

  it('never lets a new block run into the hit after it', () => {
    const after = mergeBoundaryHits(normalizeBoundarySegments([], 4), [{ beat: 1 }, { beat: 1.2 }], 4);
    expect(shape(after)).toEqual([
      [0, 1, 'empty'], [1, 1.2, 'tick'], [1.2, 1.7, 'tick'], [1.7, 4, 'empty'],
    ]);
  });

  it('ignores hits outside the node', () => {
    const before = normalizeBoundarySegments([], 4);
    expect(shape(mergeBoundaryHits(before, [{ beat: -1 }, { beat: 9 }], 4))).toEqual(shape(before));
  });
});
