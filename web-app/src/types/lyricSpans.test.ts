import { describe, expect, it } from 'vitest';
import { LYRIC_DEFAULT_SEC, LYRIC_MIN_SEC, newLyricsItem, withLyricSpans } from './annotationLayer';

describe('every lyric is a span', () => {
  it('a word added by hand gets the default length', () => {
    const w = newLyricsItem(10, 'la');
    expect(w.end).toBeCloseTo(10 + LYRIC_DEFAULT_SEC);
  });

  it('a given end is kept', () => {
    expect(newLyricsItem(10, 'la', 'word', 10.8).end).toBe(10.8);
  });

  it('a zero-length word snapped onto one beat gets its length back, short of the next word', () => {
    const items = [
      { time: 39.68611111111111, end: 39.68611111111111 },
      { time: 39.88, end: 42.46 },
    ];
    const out = withLyricSpans(items);
    expect(out[0].end).toBeCloseTo(39.88);
    expect(out[1]).toBe(items[1]);
  });

  it('a word with no end and no neighbour gets the default', () => {
    const out = withLyricSpans([{ time: 5 } as { time: number; end?: number }]);
    expect(out[0].end).toBeCloseTo(5 + LYRIC_DEFAULT_SEC);
  });

  it('never shorter than the minimum, even when the next word is right behind', () => {
    const out = withLyricSpans([{ time: 5, end: 5 }, { time: 5.01, end: 5.5 }]);
    expect(out[0].end! - out[0].time).toBeGreaterThanOrEqual(LYRIC_MIN_SEC - 1e-9);
  });

  it('returns the same array when every lyric already has a length', () => {
    const items = [{ time: 1, end: 1.4 }, { time: 2, end: 2.3 }];
    expect(withLyricSpans(items)).toBe(items);
  });
});
