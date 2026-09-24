import { describe, it, expect } from 'vitest';
import type { BoundaryItem } from '../../types/annotationLayer';
import { UNSET_TYPE } from './sectionConstants';
import { insertBoundaryAtPoint, resolvePointAddTime, NEW_SECTION_TYPE } from './boundaryInsert';

const at = (time: number, type: string): BoundaryItem =>
  ({ id: `i${time}`, time, type, label: type });

const shape = (items: readonly BoundaryItem[]) => items.map((s) => [s.time, s.type]);

describe('insertBoundaryAtPoint', () => {
  it('fills the head of an empty layer: section from 0, cap at the mark', () => {
    expect(shape(insertBoundaryAtPoint([], 7.25))).toEqual([
      [0, NEW_SECTION_TYPE],
      [7.25, UNSET_TYPE],
    ]);
  });

  it('needs no cap when the first mark is at the very start', () => {
    expect(shape(insertBoundaryAtPoint([], 0))).toEqual([[0, NEW_SECTION_TYPE]]);
  });

  it('closes the next section against the cap the previous mark left', () => {
    const first = insertBoundaryAtPoint([], 7);
    expect(shape(insertBoundaryAtPoint(first, 14))).toEqual([
      [0, NEW_SECTION_TYPE],
      [7, NEW_SECTION_TYPE],
      [14, UNSET_TYPE],
    ]);
  });

  it('caps a typed trailing section instead of starting one at the mark', () => {
    expect(shape(insertBoundaryAtPoint([at(0, 'intro'), at(8, 'drop')], 20))).toEqual([
      [0, 'intro'],
      [8, 'drop'],
      [20, UNSET_TYPE],
    ]);
  });

  it('splits when the mark lands inside the annotated region', () => {
    const prev = [at(0, 'intro'), at(8, 'drop'), at(20, UNSET_TYPE)];
    expect(shape(insertBoundaryAtPoint(prev, 12))).toEqual([
      [0, 'intro'],
      [8, 'drop'],
      [12, NEW_SECTION_TYPE],
      [20, UNSET_TYPE],
    ]);
  });

  it('is a no-op on a boundary that already exists', () => {
    const prev = [at(0, 'intro'), at(8, 'drop'), at(20, UNSET_TYPE)];
    expect(shape(insertBoundaryAtPoint(prev, 8.02))).toEqual(shape(prev));
  });

  it('rounds the mark to milliseconds', () => {
    expect(insertBoundaryAtPoint([], 7.2504999)[1].time).toBe(7.25);
  });
});

describe('resolvePointAddTime', () => {
  it('prefers the live media clock over the React prop', () => {
    expect(resolvePointAddTime({ live: 41.502, fallback: 41.47 })).toBe(41.502);
  });

  it('falls back to the prop when there is no clock to read', () => {
    expect(resolvePointAddTime({ live: null, fallback: 41.47 })).toBe(41.47);
    expect(resolvePointAddTime({ live: NaN, fallback: 41.47 })).toBe(41.47);
    expect(resolvePointAddTime({ fallback: 41.47 })).toBe(41.47);
  });

  it('keeps the pending mark while the cursor is still sitting on it', () => {
    // Paused right after the click: the pill holds the snapped value the
    // seek aimed at, the media clock landed a few ms off it.
    expect(resolvePointAddTime({ live: 21.104, fallback: 21.104, pendingPoint: 21.1 })).toBe(21.1);
  });

  it('leaves the pending mark behind once playback has moved on', () => {
    expect(resolvePointAddTime({ live: 45.2, fallback: 45.18, pendingPoint: 21.1 })).toBe(45.2);
  });
});
