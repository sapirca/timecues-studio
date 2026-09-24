import { describe, it, expect } from 'vitest';
import { UNSET_TYPE, isOrphanedSection } from './sectionConstants';
import {
  mergeBoundaryLanes,
  mergeLayerName,
  mergedToSectionBlocks,
  toggleMergeDropped,
  readMergeState,
  writeMergeState,
  type MergeSourceLane,
} from './boundaryMerge';

const lane = (id: string, times: number[]): MergeSourceLane =>
  ({ id, label: id, color: '#fff', times });

/** [time, agreement, kept] per boundary — the three things the lane draws. */
const shape = (bs: ReturnType<typeof mergeBoundaryLanes>) =>
  bs.map((b) => [b.time, b.agreement, b.kept]);

describe('mergeBoundaryLanes', () => {
  it('is a union — every boundary every lane found survives', () => {
    const merged = mergeBoundaryLanes([lane('a', [10, 30]), lane('b', [20]), lane('c', [40])]);
    expect(shape(merged)).toEqual([[10, 1, true], [20, 1, true], [30, 1, true], [40, 1, true]]);
  });

  it('keeps two boundaries one lane placed close together, if they are audibly apart', () => {
    // The union's whole point: a lane that heard a turnaround AND a drop
    // contributes both, however near they sit.
    expect(shape(mergeBoundaryLanes([lane('a', [10, 10.4])])))
      .toEqual([[10, 1, true], [10.4, 1, true]]);
  });

  it('folds boundaries that name the same instant, at the earliest real vote', () => {
    const merged = mergeBoundaryLanes([lane('a', [30]), lane('b', [30.02]), lane('c', [30.04])]);
    expect(shape(merged)).toEqual([[30, 3, true]]);
    expect(merged[0].laneIds).toEqual(['a', 'b', 'c']);
    expect(merged[0].rawTimes).toEqual([30, 30.02, 30.04]);
    expect(merged[0].spreadSec).toBeCloseTo(0.04, 6);
  });

  it('never invents a time — every merged instant is one a detector reported', () => {
    const times = [17.31, 62.08, 103.4];
    const merged = mergeBoundaryLanes([lane('a', times), lane('b', [17.33, 62.1])]);
    for (const b of merged) expect(b.rawTimes).toContain(b.time);
  });

  it('counts a lane once however many boundaries it put in one fold', () => {
    const merged = mergeBoundaryLanes([lane('a', [30, 30.01]), lane('b', [30.02])]);
    expect(merged).toHaveLength(1);
    expect(merged[0].agreement).toBe(2);
    expect(merged[0].laneIds).toEqual(['a', 'b']);
  });

  it('orders laneIds by the order the members were picked', () => {
    const merged = mergeBoundaryLanes([lane('z', [30.02]), lane('a', [30])]);
    expect(merged[0].laneIds).toEqual(['z', 'a']);
  });

  it('drops only the boundaries the annotator struck out', () => {
    const merged = mergeBoundaryLanes([lane('a', [10, 20, 30])], [20]);
    expect(shape(merged)).toEqual([[10, 1, true], [20, 1, false], [30, 1, true]]);
  });

  it('is empty with no lanes, and with lanes that found nothing', () => {
    expect(mergeBoundaryLanes([])).toEqual([]);
    expect(mergeBoundaryLanes([lane('a', [])])).toEqual([]);
  });
});

describe('toggleMergeDropped', () => {
  const lanes = [lane('a', [10, 20])];

  it('drops a kept boundary, and puts it back on a second click', () => {
    const [first] = mergeBoundaryLanes(lanes);
    const dropped = toggleMergeDropped([], first);
    expect(dropped).toEqual([10]);
    expect(shape(mergeBoundaryLanes(lanes, dropped))).toEqual([[10, 1, false], [20, 1, true]]);

    const restored = toggleMergeDropped(dropped, mergeBoundaryLanes(lanes, dropped)[0]);
    expect(restored).toEqual([]);
  });

  it('restores by instant, so a drop stored at a hair off still clears', () => {
    const merged = mergeBoundaryLanes(lanes, [10.01]);
    expect(merged[0].kept).toBe(false);
    expect(toggleMergeDropped([10.01], merged[0])).toEqual([]);
  });
});

describe('merge state storage', () => {
  it('round-trips a blend, and forgets an empty one rather than leaving a row', () => {
    writeMergeState('song-1', { memberIds: ['a', 'b'], dropped: [12.5] });
    expect(readMergeState('song-1')).toEqual({ memberIds: ['a', 'b'], dropped: [12.5] });

    writeMergeState('song-1', { memberIds: [], dropped: [] });
    expect(readMergeState('song-1')).toBeNull();
  });

  it('is per song, and survives junk in storage', () => {
    writeMergeState('song-a', { memberIds: ['a'], dropped: [] });
    expect(readMergeState('song-b')).toBeNull();
    window.localStorage.setItem('tc.merge.song-c', '{not json');
    expect(readMergeState('song-c')).toBeNull();
  });
});

describe('mergedToSectionBlocks', () => {
  it('tiles from 0 and names every block, so none lands as an invisible cap', () => {
    const blocks = mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [30, 60])]));
    expect(blocks.map((b) => b.time)).toEqual([0, 30, 60]);
    expect(blocks.every((b) => b.type === UNSET_TYPE)).toBe(true);
    expect(blocks.map((b) => b.label)).toEqual(['Section 1', 'Section 2', 'Section 3']);
    // The discriminator the lane and the section list both read: a named
    // `unset` section draws and can be retyped; an unnamed one is a cap.
    expect(blocks.every(isOrphanedSection)).toBe(true);
  });

  it('pins a near-zero first boundary to 0 rather than laying a sliver in front', () => {
    const blocks = mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [0.02, 30])]));
    expect(blocks.map((b) => b.time)).toEqual([0, 30]);
  });

  it('leaves out the boundaries the annotator dropped', () => {
    const blocks = mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [30, 60, 90])], [60]));
    expect(blocks.map((b) => b.time)).toEqual([0, 30, 90]);
  });

  it('is empty when nothing is kept', () => {
    expect(mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [30])], [30]))).toEqual([]);
  });
});

describe('mergeLayerName', () => {
  it('names the members, and abbreviates once the list gets long', () => {
    expect(mergeLayerName([])).toBe('Merge');
    expect(mergeLayerName([lane('a', []), lane('b', [])])).toBe('Merge · a + b');
    expect(mergeLayerName([lane('a', []), lane('b', []), lane('c', []), lane('d', [])]))
      .toBe('Merge · a + b +2');
  });
});
