import { describe, expect, it } from 'vitest';
import { loopLengthWords } from './loopLength';

describe('loopLengthWords', () => {
  it('says bars for whole and half bars', () => {
    expect(loopLengthWords(4)).toBe('1 bar');
    expect(loopLengthWords(8)).toBe('2 bars');
    expect(loopLengthWords(2)).toBe('½ bar');
    expect(loopLengthWords(6)).toBe('1½ bars');
  });
  it('says beats for anything shorter or off the half-bar', () => {
    expect(loopLengthWords(1)).toBe('1 beat');
    expect(loopLengthWords(1.5)).toBe('1½ beats');
    expect(loopLengthWords(0.75)).toBe('¾ beat');
    expect(loopLengthWords(5)).toBe('5 beats');
    expect(loopLengthWords(1.2)).toBe('1.2 beats');
  });
  it('follows the time signature', () => {
    expect(loopLengthWords(3, 3)).toBe('1 bar');
    expect(loopLengthWords(4, 3)).toBe('4 beats');
  });
  it('is empty for no length', () => {
    expect(loopLengthWords(0)).toBe('');
  });
});
