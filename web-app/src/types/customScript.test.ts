import { describe, expect, it } from 'vitest';
import { DRUM_KIT_DETECTOR, kitFirst } from './customScript';

describe('kitFirst', () => {
  it('runs the kit split before everything that reads drums', () => {
    expect(kitFirst(['pulse', 'drum_hits', DRUM_KIT_DETECTOR, 'melody']))
      .toEqual([DRUM_KIT_DETECTOR, 'pulse', 'drum_hits', 'melody']);
  });

  it('leaves a list without the kit as it was', () => {
    expect(kitFirst(['pulse', 'melody'])).toEqual(['pulse', 'melody']);
  });
});
