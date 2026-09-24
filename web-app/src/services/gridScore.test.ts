import { describe, it, expect } from 'vitest';
import { bpmRelation, octaveHint, orderTrackers } from './gridScore';

describe('bpmRelation', () => {
  it('treats a half-BPM difference as the same tempo', () => {
    // Below the resolution any of this matters at.
    expect(bpmRelation(124.3, 124)).toBe('match');
    expect(bpmRelation(124, 124)).toBe('match');
  });

  it('calls a couple of BPM close, not wrong', () => {
    // A frame-grid artifact or a rounding, not a disagreement — trackers
    // quantize beat times, so a steady track reads a shade off.
    expect(bpmRelation(125.5, 124)).toBe('close');
  });

  it('identifies half and double time as an octave, not an error', () => {
    expect(bpmRelation(62, 124)).toBe('octave');
    expect(bpmRelation(248, 124)).toBe('octave');
    expect(bpmRelation(65.22, 130.44)).toBe('octave');   // real corpus values
    expect(bpmRelation(31, 124)).toBe('octave');         // ×4
  });

  it('calls a genuine mismatch off', () => {
    // 1.8x is a real tempo change, not a metrical level. Widening the octave
    // test far enough to swallow it would be the worse failure.
    expect(bpmRelation(223, 124)).toBe('off');
    expect(bpmRelation(92.29, 123)).toBe('off');         // real corpus values
  });

  it('is unknown when either side is missing', () => {
    expect(bpmRelation(null, 124)).toBe('unknown');
    expect(bpmRelation(124, null)).toBe('unknown');
    expect(bpmRelation(124, 0)).toBe('unknown');
  });
});

describe('octaveHint', () => {
  it('says which way the level differs', () => {
    expect(octaveHint(62, 124)).toBe('÷2');
    expect(octaveHint(248, 124)).toBe('×2');
    expect(octaveHint(31, 124)).toBe('÷4');
    expect(octaveHint(496, 124)).toBe('×4');
  });

  it('returns nothing for a tempo that is not octave-related', () => {
    expect(octaveHint(130, 124)).toBeNull();
  });
});

describe('orderTrackers', () => {
  it('puts the stem-reading tracker first, then the best mix trackers', () => {
    expect(orderTrackers(['librosa-beat-track', 'beat-this', 'beat-transformer']))
      .toEqual(['beat-transformer', 'beat-this', 'librosa-beat-track']);
  });

  it('keeps unknown detectors last rather than dropping them', () => {
    const out = orderTrackers(['something-new', 'beat-this']);
    expect(out[0]).toBe('beat-this');
    expect(out).toContain('something-new');
  });
});
