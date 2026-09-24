import { describe, it, expect } from 'vitest';
import {
  SAME_SPOT_EPS,
  duplicateItemNotice,
  findItemAtSpot,
  isSameSpot,
} from './duplicateItem';

describe('isSameSpot', () => {
  it('treats the identical instant as the same spot', () => {
    expect(isSameSpot({ at: 12.345 }, { at: 12.345 })).toBe(true);
  });

  it('absorbs float dust below the storage resolution', () => {
    expect(isSameSpot({ at: 12.345 }, { at: 12.345 + SAME_SPOT_EPS / 2 })).toBe(true);
  });

  it('keeps two events an annotator could hear apart', () => {
    // A flam: 30 ms apart, well inside the boundary layer's 50 ms EDGE_EPS
    // but still two deliberate marks.
    expect(isSameSpot({ at: 12.345 }, { at: 12.375 })).toBe(false);
  });

  it('compares both edges of an interval', () => {
    expect(isSameSpot({ at: 1, end: 3 }, { at: 1, end: 3 })).toBe(true);
    expect(isSameSpot({ at: 1, end: 3 }, { at: 1, end: 4 })).toBe(false);
  });

  it('does not confuse a point with an interval that starts there', () => {
    expect(isSameSpot({ at: 1 }, { at: 1, end: 3 })).toBe(false);
  });
});

describe('findItemAtSpot', () => {
  const cues = [
    { id: 'a', time: 1 },
    { id: 'b', time: 2.5 },
  ];
  const asPoint = (c: { time: number }) => ({ at: c.time });

  it('returns the item already sitting there', () => {
    expect(findItemAtSpot(cues, { at: 2.5 }, asPoint)?.id).toBe('b');
  });

  it('returns undefined when the spot is free', () => {
    expect(findItemAtSpot(cues, { at: 2.6 }, asPoint)).toBeUndefined();
  });

  it('returns undefined on an empty layer', () => {
    expect(findItemAtSpot([], { at: 1 }, asPoint)).toBeUndefined();
  });
});

describe('duplicateItemNotice', () => {
  it('names the point it refused', () => {
    expect(duplicateItemNotice('cue', { at: 12.345 })).toContain('0:12.345');
  });

  it('names both edges of an interval', () => {
    const msg = duplicateItemNotice('span', { at: 61, end: 63 });
    expect(msg).toContain('1:01.000');
    expect(msg).toContain('1:03.000');
  });
});
