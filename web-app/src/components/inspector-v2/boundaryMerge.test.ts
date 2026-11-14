import { describe, it, expect } from 'vitest';
import { UNSET_TYPE, isOrphanedSection } from './sectionConstants';
import {
  mergeBoundaryLanes,
  mergeLayerName,
  mergedToSectionBlocks,
  toggleMergeDropped,
  patchMergeEdit,
  readMergeState,
  writeMergeState,
  addMergeBoundary,
  removeMergeBoundary,
  isHandOnly,
  HAND_LANE_ID,
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
    const edits = [{ at: 30, label: 'drop', type: 'drop' }];
    writeMergeState('song-1', { memberIds: ['a', 'b'], dropped: [12.5], edits, added: [] });
    expect(readMergeState('song-1')).toEqual({ memberIds: ['a', 'b'], dropped: [12.5], edits, added: [] });

    writeMergeState('song-1', { memberIds: [], dropped: [], edits: [], added: [] });
    expect(readMergeState('song-1')).toBeNull();
  });

  it('is per song, and survives junk in storage', () => {
    writeMergeState('song-a', { memberIds: ['a'], dropped: [], edits: [], added: [] });
    expect(readMergeState('song-b')).toBeNull();
    window.localStorage.setItem('tc.merge.song-c', '{not json');
    expect(readMergeState('song-c')).toBeNull();
  });

  it('remembers which members are hidden from the canvas', () => {
    writeMergeState('song-e', { memberIds: ['a', 'b'], dropped: [], edits: [], added: [], hidden: ['b'] });
    expect(readMergeState('song-e')?.hidden).toEqual(['b']);
  });

  it('reads a blend stored before edits existed as having none', () => {
    window.localStorage.setItem('tc.merge.song-d', JSON.stringify({ memberIds: ['a'], dropped: [] }));
    expect(readMergeState('song-d')).toEqual({ memberIds: ['a'], dropped: [], edits: [], added: [] });
  });
});

describe('merge boundary edits', () => {
  it('follow the boundary by the time the lanes reported, through a membership change', () => {
    const [b] = mergeBoundaryLanes([lane('a', [30])]);
    const edits = patchMergeEdit([], b, { label: 'the drop', type: 'drop' });
    const again = mergeBoundaryLanes([lane('b', [30.02]), lane('a', [30])], [], edits);
    expect(again[0].edit).toMatchObject({ label: 'the drop', type: 'drop' });
  });

  it('patch the existing edit rather than stacking a second one', () => {
    const [b] = mergeBoundaryLanes([lane('a', [30])]);
    const edits = patchMergeEdit(patchMergeEdit([], b, { label: 'x' }), b, { description: 'y' });
    expect(edits).toEqual([{ at: 30, label: 'x', description: 'y' }]);
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

  it('carries the popover edits, and re-sorts a boundary moved past its neighbour', () => {
    const merged = mergeBoundaryLanes([lane('a', [30, 60])]);
    let edits = patchMergeEdit([], merged[0], { time: 70, type: 'drop', label: 'drop 1', description: 'big one' });
    edits = patchMergeEdit(edits, merged[1], { importance: 'critical' });
    const blocks = mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [30, 60])], [], edits));
    expect(blocks.map((b) => [b.time, b.type, b.label])).toEqual([
      [0, UNSET_TYPE, 'Section 1'], [60, UNSET_TYPE, 'Section 2'], [70, 'drop', 'drop 1'],
    ]);
    expect(blocks[2].description).toBe('big one');
    expect(blocks[1].importance).toBe('critical');
  });

  it('is empty when nothing is kept', () => {
    expect(mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [30])], [30]))).toEqual([]);
  });
});

describe('splitting the merge by hand', () => {
  it('adds a boundary where no lane has one, voting as the hand lane', () => {
    const added = addMergeBoundary([], 45.0004);
    const merged = mergeBoundaryLanes([lane('a', [30, 60])], [], [], added);
    expect(shape(merged)).toEqual([[30, 1, true], [45, 1, true], [60, 1, true]]);
    expect(isHandOnly(merged[1])).toBe(true);
    expect(isHandOnly(merged[0])).toBe(false);
  });

  it('folds into a lane boundary at the same instant, detectors named first', () => {
    const merged = mergeBoundaryLanes([lane('a', [30])], [], [], addMergeBoundary([], 30.02));
    expect(merged).toHaveLength(1);
    expect(merged[0].laneIds).toEqual(['a', HAND_LANE_ID]);
    expect(isHandOnly(merged[0])).toBe(false);
  });

  it('ignores a second split at the same instant, and removes cleanly', () => {
    const added = addMergeBoundary(addMergeBoundary([], 45), 45.01);
    expect(added).toEqual([45]);
    const [, hand] = mergeBoundaryLanes([lane('a', [30])], [], [], added);
    expect(removeMergeBoundary(added, hand)).toEqual([]);
  });

  it('is committed like any other boundary', () => {
    const blocks = mergedToSectionBlocks(mergeBoundaryLanes([lane('a', [30])], [], [], [45]));
    expect(blocks.map((b) => b.time)).toEqual([0, 30, 45]);
  });

  it('survives a reload', () => {
    writeMergeState('song-h', { memberIds: ['a'], dropped: [], edits: [], added: [45] });
    expect(readMergeState('song-h')?.added).toEqual([45]);
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
