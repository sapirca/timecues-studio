import { describe, it, expect } from 'vitest';
import {
  beatDuration,
  beatIndexAt,
  beatTimeAt,
  barIndexAt,
  snapTimeToGrid,
  timeToBarBeat,
  barBeatToTime,
  visibleGridLines,
  findBoundingAnchor,
  findBoundingAnchorIndex,
  cumulativeBeatsAtAnchor,
} from './beatGrid';
import type { TempoAnchor } from '../types/songInfo';

// Engine fixtures shared across tests.
const STATIC_120 = { bpm: 120, gridOffset: 0, beatsPerBar: 4 } as const;

// A three-anchor song:
//   - Anchor 0 at  0.0s, 120 BPM   (segment 0: [0,    20)  — 40 beats)
//   - Anchor 1 at 20.0s, 100 BPM   (segment 1: [20,   50)  — 50 beats)
//   - Anchor 2 at 50.0s, 140 BPM   (segment 2: [50, +inf)        )
const THREE: TempoAnchor[] = [
  { timestamp:  0.0, bpm: 120 },
  { timestamp: 20.0, bpm: 100 },
  { timestamp: 50.0, bpm: 140 },
];

// ─── Section 8.1 — Static BPM Mode (legacy unchanged) ────────────────────────

describe('static-BPM mode (no anchors)', () => {
  it('beatIndexAt matches the legacy formula', () => {
    expect(beatIndexAt(0,     STATIC_120.bpm, STATIC_120.gridOffset)).toBe(0);
    expect(beatIndexAt(0.5,   STATIC_120.bpm, STATIC_120.gridOffset)).toBe(1);
    expect(beatIndexAt(1.49,  STATIC_120.bpm, STATIC_120.gridOffset)).toBe(2);
    // Passing an empty anchor array must behave exactly like passing undefined.
    expect(beatIndexAt(1.49, STATIC_120.bpm, STATIC_120.gridOffset, [])).toBe(2);
  });

  it('beatTimeAt matches the legacy formula', () => {
    expect(beatTimeAt(0, STATIC_120.bpm, STATIC_120.gridOffset)).toBeCloseTo(0,    9);
    expect(beatTimeAt(1, STATIC_120.bpm, STATIC_120.gridOffset)).toBeCloseTo(0.5,  9);
    expect(beatTimeAt(8, STATIC_120.bpm, STATIC_120.gridOffset)).toBeCloseTo(4.0,  9);
  });

  it('barIndexAt is consistent with beatIndexAt / beatsPerBar', () => {
    expect(barIndexAt(0,   STATIC_120.bpm, STATIC_120.gridOffset, STATIC_120.beatsPerBar)).toBe(0);
    expect(barIndexAt(2.0, STATIC_120.bpm, STATIC_120.gridOffset, STATIC_120.beatsPerBar)).toBe(1);
  });

  it('snapTimeToGrid snaps to the nearest beat', () => {
    expect(snapTimeToGrid(0.24, STATIC_120.bpm, STATIC_120.gridOffset, 4, 'beat')).toBeCloseTo(0,   9);
    expect(snapTimeToGrid(0.26, STATIC_120.bpm, STATIC_120.gridOffset, 4, 'beat')).toBeCloseTo(0.5, 9);
  });

  it('timeToBarBeat / barBeatToTime round-trip', () => {
    const s = timeToBarBeat(2.0, STATIC_120.bpm, STATIC_120.gridOffset, 4);
    expect(s).toBe('2.1');
    expect(barBeatToTime(s!, STATIC_120.bpm, STATIC_120.gridOffset, 4)).toBeCloseTo(2.0, 9);
  });

  it('visibleGridLines static output is unchanged by passing empty anchors', () => {
    const opts = {
      bpm: 120, gridOffset: 0, beatsPerBar: 4,
      startTime: 0, endTime: 2,
    };
    const a = visibleGridLines(opts);
    const b = visibleGridLines({ ...opts, anchors: [] });
    expect(b).toEqual(a);
  });
});

// ─── Section 8.2 — Anchor Traversal ──────────────────────────────────────────

describe('anchor traversal', () => {
  it('findBoundingAnchor at the beginning', () => {
    // Right at anchor 0's timestamp — bounding is anchor 0.
    expect(findBoundingAnchorIndex(THREE, 0.0)).toBe(0);
    expect(findBoundingAnchor(THREE, 0.0)).toEqual(THREE[0]);
  });

  it('findBoundingAnchor in the middle', () => {
    // 35s is inside segment 1 ([20, 50)).
    expect(findBoundingAnchorIndex(THREE, 35.0)).toBe(1);
    expect(findBoundingAnchor(THREE, 35.0)).toEqual(THREE[1]);
  });

  it('findBoundingAnchor at the end', () => {
    // 75s is in segment 2 (>= 50).
    expect(findBoundingAnchorIndex(THREE, 75.0)).toBe(2);
    expect(findBoundingAnchor(THREE, 75.0)).toEqual(THREE[2]);
  });

  it('returns -1 for times before the first anchor', () => {
    // Anchored song with first anchor at t > 0: tests need a different fixture.
    const offset: TempoAnchor[] = [
      { timestamp: 5.0, bpm: 120 },
      { timestamp: 25.0, bpm: 100 },
    ];
    expect(findBoundingAnchorIndex(offset, 2.0)).toBe(-1);
    expect(findBoundingAnchor(offset, 2.0)).toBeNull();
  });

  it('cumulativeBeatsAtAnchor accumulates per segment', () => {
    // Anchor 0 at t=0 with global bpm=120, gridOffset=0 → cum at idx 0 = 0.
    expect(cumulativeBeatsAtAnchor(THREE, 0, 120, 0)).toBe(0);
    // Segment 0 covers 20s at 120 BPM → 40 beats. Cum at idx 1 = 40.
    expect(cumulativeBeatsAtAnchor(THREE, 1, 120, 0)).toBe(40);
    // Segment 1 covers 30s at 100 BPM → 50 beats. Cum at idx 2 = 90.
    expect(cumulativeBeatsAtAnchor(THREE, 2, 120, 0)).toBe(90);
  });

  it('beatIndexAt routes through the correct segment', () => {
    // 10s inside segment 0 at 120 BPM → 20 beats.
    expect(beatIndexAt(10.0, 120, 0, THREE)).toBe(20);
    // 35s = 20 + 15s into segment 1 at 100 BPM → 40 + 25 = 65.
    expect(beatIndexAt(35.0, 120, 0, THREE)).toBe(65);
    // 50s = exactly anchor 2's start → cum = 90.
    expect(beatIndexAt(50.0, 120, 0, THREE)).toBe(90);
    // 60s = 90 + 10s at 140 BPM → 90 + 23 = 113 (floor of 23.333).
    expect(beatIndexAt(60.0, 120, 0, THREE)).toBe(113);
  });

  it('beatTimeAt is the inverse of beatIndexAt at integer beats', () => {
    // Beat 40 = start of segment 1 = 20s.
    expect(beatTimeAt(40, 120, 0, THREE)).toBeCloseTo(20.0, 9);
    // Beat 65 = 20s + 25 beats at 100 BPM = 20 + 15 = 35s.
    expect(beatTimeAt(65, 120, 0, THREE)).toBeCloseTo(35.0, 9);
    // Beat 90 = start of segment 2 = 50s.
    expect(beatTimeAt(90, 120, 0, THREE)).toBeCloseTo(50.0, 9);
  });

  it('visibleGridLines emits continuous bar numbers across anchors', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0, beatsPerBar: 4,
      startTime: 0, endTime: 55,
      anchors: THREE,
    });
    // Bar boundaries only — sanity-check there's no "bar 1" twice.
    const barOnly = lines.filter((l) => l.isBar);
    const barNumbers = barOnly.map((l) => l.barNumber);
    // Continuous, strictly ascending sequence.
    for (let i = 1; i < barNumbers.length; i++) {
      expect(barNumbers[i]).toBeGreaterThan(barNumbers[i - 1]);
    }
    // Bars per segment: seg0 = 40beats/4 = 10 bars, seg1 = 50/4 = 12 bars,
    // seg2 (0..5s) = ~7 beats / 4 = 1+ partial bar.
    expect(barNumbers[0]).toBe(1);
    // Last visible bar within [0,55] is at or above 22 (= 10 + 12).
    expect(barNumbers[barNumbers.length - 1]).toBeGreaterThanOrEqual(22);
  });
});

// ─── Section 8.5 — Snap-to-Grid boundary ─────────────────────────────────────

describe('snap-to-grid boundary near a manual anchor', () => {
  // Imagine a manual-mode song where the curator dragged a beat to land
  // exactly at t=40.000s with a local 100 BPM segment starting at t=20.000s.
  const manual: TempoAnchor[] = [
    { timestamp:  0.0, bpm: 120 },
    { timestamp: 20.0, bpm: 100 },
  ];

  it('snaps a time near the manual anchor to its local grid', () => {
    // Local dBeat in segment 1 (100 BPM) = 0.6s. Times near segment 1's
    // beat-1 (= 20.6s) snap onto that segment's grid.
    expect(snapTimeToGrid(20.55, 120, 0, 4, 'beat', manual)).toBeCloseTo(20.6, 9);
    expect(snapTimeToGrid(20.65, 120, 0, 4, 'beat', manual)).toBeCloseTo(20.6, 9);
  });

  it('snaps a time BEFORE the manual anchor using the previous tempo', () => {
    // 19.5s is still inside segment 0 (bounding is anchor 0, 120 BPM, dBeat=0.5).
    // Segment 0 beat at 19.5s should snap to 19.5 (already on grid).
    expect(snapTimeToGrid(19.5, 120, 0, 4, 'beat', manual)).toBeCloseTo(19.5, 9);
    // 19.4s rounds to 19.5 under 120 BPM grid (nearest of 19.0 vs 19.5).
    expect(snapTimeToGrid(19.4, 120, 0, 4, 'beat', manual)).toBeCloseTo(19.5, 9);
    // 19.2s is closer to 19.0 than 19.5 under 120 BPM, snaps to 19.0.
    expect(snapTimeToGrid(19.2, 120, 0, 4, 'beat', manual)).toBeCloseTo(19.0, 9);
  });

  it('static path is unaffected when the same time is queried without anchors', () => {
    // Without anchors, 20.55s with 120 BPM snaps to 20.5 (nearest of 20.5 / 21.0).
    expect(snapTimeToGrid(20.55, 120, 0, 4, 'beat')).toBeCloseTo(20.5, 9);
  });
});

// Sanity: beatDuration is a stable trivial helper used by many tests above.
describe('beatDuration', () => {
  it('returns 60/bpm', () => {
    expect(beatDuration(120)).toBeCloseTo(0.5, 9);
    expect(beatDuration(60)).toBeCloseTo(1.0, 9);
  });
});

// ─── Per-beat overrides (Manual mode micro-adjustments) ──────────────────────

describe('beat overrides', () => {
  // 120 BPM, gridOffset=0 → macro beats at 0.0, 0.5, 1.0, 1.5, 2.0, ...

  it('beatTimeAt returns the override when an integer beat is pinned', () => {
    expect(beatTimeAt(3, 120, 0, undefined, { '3': 1.55 })).toBeCloseTo(1.55, 9);
  });

  it('beatTimeAt falls back to the macro grid for un-pinned indices', () => {
    expect(beatTimeAt(4, 120, 0, undefined, { '3': 1.55 })).toBeCloseTo(2.0, 9);
  });

  it('beatTimeAt ignores overrides at non-integer beat indices', () => {
    // A fractional index can't match any string-keyed entry.
    expect(beatTimeAt(3.5, 120, 0, undefined, { '3': 1.55 })).toBeCloseTo(1.75, 9);
  });

  it('snapTimeToGrid returns the pinned time when the macro snap lands on a pinned beat', () => {
    // Macro snap of 1.48s → beat 3 (1.5s). With beat 3 pinned to 1.55, snap returns 1.55.
    expect(snapTimeToGrid(1.48, 120, 0, 4, 'beat', undefined, { '3': 1.55 })).toBeCloseTo(1.55, 9);
  });

  it('snapTimeToGrid returns the macro snap when the nearest beat is not pinned', () => {
    expect(snapTimeToGrid(0.95, 120, 0, 4, 'beat', undefined, { '3': 1.55 })).toBeCloseTo(1.0, 9);
  });

  it('visibleGridLines displaces the line position for pinned integer beats', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0, beatsPerBar: 4,
      startTime: 0, endTime: 3,
      beatOverrides: { '3': 1.55 },
    });
    const beat3 = lines.find((l) => l.beatIndex === 3);
    expect(beat3).toBeDefined();
    expect(beat3!.t).toBeCloseTo(1.55, 9);
    expect(beat3!.isOverridden).toBe(true);
    // Neighbours remain on the macro grid.
    expect(lines.find((l) => l.beatIndex === 2)!.t).toBeCloseTo(1.0, 9);
    expect(lines.find((l) => l.beatIndex === 4)!.t).toBeCloseTo(2.0, 9);
    expect(lines.find((l) => l.beatIndex === 2)!.isOverridden).toBeUndefined();
  });

  it('an overridden bar line keeps its bar classification', () => {
    // Beat 4 is bar 2 boundary at 2.0s (4/4 grid). Pin it to 2.07s — it
    // must still report isBar = true and the same barNumber.
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0, beatsPerBar: 4,
      startTime: 0, endTime: 3,
      beatOverrides: { '4': 2.07 },
    });
    const beat4 = lines.find((l) => l.beatIndex === 4);
    expect(beat4).toBeDefined();
    expect(beat4!.t).toBeCloseTo(2.07, 9);
    expect(beat4!.isBar).toBe(true);
    expect(beat4!.barNumber).toBe(2);
    expect(beat4!.isOverridden).toBe(true);
  });

  it('overrides do not apply to sub-beat lines even when subdivision is on', () => {
    // 8th-note subdivision (subBeatDivision=2). Pin beat 2 to 1.05s.
    // The 8th note between beats 2 and 3 (beatIndex 2.5) must stay on the macro grid.
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0, beatsPerBar: 4,
      startTime: 0, endTime: 3,
      subBeatDivision: 2,
      beatOverrides: { '2': 1.05 },
    });
    const halfBeat = lines.find((l) => Math.abs(l.beatIndex - 2.5) < 1e-9);
    expect(halfBeat).toBeDefined();
    expect(halfBeat!.t).toBeCloseTo(1.25, 9);
    expect(halfBeat!.isOverridden).toBeUndefined();
    expect(halfBeat!.isSubBeat).toBe(true);
  });
});
