/**
 * Zoomed out, a one-bar band has room for about three characters a line, so
 * the rate and bar count shorten to a letter or two instead of truncating.
 */

import { describe, it, expect } from 'vitest';
import { compactBandLabelPart } from './bandLabel';

describe('compactBandLabelPart', () => {
  it('shortens counts of beats and bars', () => {
    expect(compactBandLabelPart('Beat')).toBe('1b');
    expect(compactBandLabelPart('1/2 beat')).toBe('1/2b');
    expect(compactBandLabelPart('Bar')).toBe('1br');
    expect(compactBandLabelPart('24 bars')).toBe('24br');
    expect(compactBandLabelPart('triplet')).toBe('trip');
  });

  it('leaves the instrument alone', () => {
    expect(compactBandLabelPart('Kick')).toBe('Kick');
    expect(compactBandLabelPart('Upbeat stabs')).toBe('Upbeat stabs');
  });
});
