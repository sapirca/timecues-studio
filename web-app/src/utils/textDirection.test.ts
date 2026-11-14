import { describe, expect, it } from 'vitest';
import { textDir } from './textDirection';

describe('textDir', () => {
  it('reads Hebrew as right to left', () => {
    expect(textDir('שלום עולם')).toBe('rtl');
  });
  it('reads English as left to right', () => {
    expect(textDir("we don't sleep")).toBe('ltr');
  });
  it('skips leading digits and punctuation to the first letter', () => {
    expect(textDir('1, 2… לילה')).toBe('rtl');
    expect(textDir('(3) night')).toBe('ltr');
  });
  it('defaults to left to right with no letters', () => {
    expect(textDir('')).toBe('ltr');
    expect(textDir('…')).toBe('ltr');
  });
});
