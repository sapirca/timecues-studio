/**
 * The contract between the grid you see and the grid you snap to.
 *
 * Two functions decide those separately — `resolveBeatGrid` turns the unit
 * selector into drawn lines, `beatGridUnitToSnapDivision` turns it into a snap
 * — and nothing but this test holds them together. They drifted: the sub-beat
 * units were flattened onto the nearest binary rung, so `1/3 beat · triplet`
 * drew thirds and snapped to halves, and an annotation dropped between two
 * visible lines was pulled to a position where no line exists.
 *
 * The rule is one-directional and deliberately weak: every drawn line must be
 * a landing spot. A snap FINER than the drawn grid is fine (the coarse
 * multi-bar units snap per bar, so you can still place between phrase lines);
 * a snap that lands anywhere else is not.
 */

import { describe, it, expect } from 'vitest';
import { snapTimeToGrid, visibleGridLines } from './beatGrid';
import { beatGridUnitToSnapDivision } from './beatTimeFormat';
import { BEAT_GRID_UNIT_OPTIONS, resolveBeatGrid } from '../components/inspector-v2/SharedVizPanel';

const BPM = 120;
const BEATS_PER_BAR = 4;
const END = 140;   // 70 bars at 120 BPM 4/4 — enough for the 16-bar unit to repeat

describe('every drawn grid line is a place the snap can land', () => {
  for (const unit of BEAT_GRID_UNIT_OPTIONS) {
    it(`holds for "${unit}"`, () => {
      const grid = resolveBeatGrid(BPM, BEATS_PER_BAR, true, unit);
      const lines = visibleGridLines({
        bpm: BPM,
        gridOffset: 0,
        beatsPerBar: BEATS_PER_BAR,
        startTime: 0,
        endTime: END,
        barGroupSize: grid.barGroupSize ?? null,
        subBeatDivision: grid.subBeatDivision,
        beatGroupSize: grid.beatGroupSize,
      });
      const division = beatGridUnitToSnapDivision(unit);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(snapTimeToGrid(line.t, BPM, 0, BEATS_PER_BAR, division))
          .toBeCloseTo(line.t, 6);
      }
    });
  }
});

describe('beatGridUnitToSnapDivision', () => {
  it('gives each sub-beat unit its own division, triplets included', () => {
    expect(beatGridUnitToSnapDivision('32nd')).toBe('1/8beat');
    expect(beatGridUnitToSnapDivision('16th-triplet')).toBe('1/6beat');
    expect(beatGridUnitToSnapDivision('16th')).toBe('1/4beat');
    expect(beatGridUnitToSnapDivision('8th-triplet')).toBe('1/3beat');
    expect(beatGridUnitToSnapDivision('8th')).toBe('1/2beat');
    expect(beatGridUnitToSnapDivision('beat')).toBe('beat');
  });

  it('stops at the bar for the multi-bar units', () => {
    // Deliberate: landing only every fourth bar would be a worse tool, and the
    // rule above still holds — every 4-bar line IS a bar line.
    for (const unit of ['bar', '2bar', '4bar', '8bar', '16bar']) {
      expect(beatGridUnitToSnapDivision(unit)).toBe('bar');
    }
  });
});
