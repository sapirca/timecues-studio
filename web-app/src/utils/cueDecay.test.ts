import { describe, it, expect } from 'vitest';
import { decayReadout, stepCueDecay } from './cueDecay';

describe('stepCueDecay', () => {
  it('starts a cue with no decay from the tick', () => {
    expect(stepCueDecay(undefined, 0.01, 5)).toBe(0.01);
  });
  it('steps to the millisecond without float drift', () => {
    expect(stepCueDecay(0.29, 0.01, 5)).toBe(0.3);
  });
  it('clears at or past the tick', () => {
    expect(stepCueDecay(0.01, -0.01, 5)).toBeUndefined();
    expect(stepCueDecay(0.05, -0.1, 5)).toBeUndefined();
    expect(stepCueDecay(undefined, -0.01, 5)).toBeUndefined();
  });
  it('never rings past the end of the song', () => {
    expect(stepCueDecay(0.95, 0.1, 1)).toBe(1);
  });
});

describe('decayReadout', () => {
  it('reads ms, or that there is none', () => {
    expect(decayReadout(0.42)).toBe('decay 420 ms');
    expect(decayReadout(undefined)).toBe('no decay');
  });
});
