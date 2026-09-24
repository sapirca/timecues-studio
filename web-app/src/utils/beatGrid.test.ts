import { describe, it, expect } from 'vitest';
import {
  adaptiveGridThicknessScale,
  beatDuration,
  beatIndexAt,
  beatTimeAt,
  barIndexAt,
  beatsInRange,
  snapTimeToGrid,
  timeToBarBeat,
  barBeatToTime,
  visibleGridLines,
  formatBeatPosition,
  getBarBeatOrigin,
  setBarBeatOrigin,
  foldGridOffset,
  gridOffsetBarShift,
  coarsenSnapDivision,
  MIN_SNAP_STEP_PX,
} from './beatGrid';
import { resolveGridSegments, beatOverrideKey } from './gridSegments';
import { makeEmptySongInfo } from '../types/songInfo';

// Engine fixtures shared across tests.
const STATIC_120 = { bpm: 120, gridOffset: 0, beatsPerBar: 4 } as const;

// ─── Section 8.1 — Static BPM Mode (legacy unchanged) ────────────────────────

describe('static-BPM mode', () => {
  it('beatIndexAt matches the legacy formula', () => {
    expect(beatIndexAt(0,     STATIC_120.bpm, STATIC_120.gridOffset)).toBe(0);
    expect(beatIndexAt(0.5,   STATIC_120.bpm, STATIC_120.gridOffset)).toBe(1);
    expect(beatIndexAt(1.49,  STATIC_120.bpm, STATIC_120.gridOffset)).toBe(2);
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
    expect(s).toBe('1.0');   // 4 beats in — zero-based default numbering
    expect(barBeatToTime(s!, STATIC_120.bpm, STATIC_120.gridOffset, 4)).toBeCloseTo(2.0, 9);
  });
});

// ─── Metronome click enumeration (beatsInRange) ──────────────────────────────
//
// Regression guard for the "intro is silent" bug: gridOffset is phase only, so
// the click must sound the same before and after the offset. A clamp on the
// start beat index (the original bug) would drop every pre-offset click.

describe('beatsInRange — gridOffset is phase, not a start gate', () => {
  const times = (b: Array<{ t: number }>) => b.map((x) => +x.t.toFixed(6));

  it('emits clicks before the offset (static mode)', () => {
    // 120 BPM (0.5s/beat), offset 2.0s, play the intro [0, 2].
    const beats = beatsInRange(120, 2.0, 4, 0, 2);
    expect(times(beats)).toEqual([0, 0.5, 1.0, 1.5, 2.0]);
    // Downbeats fall on the offset phase, on both sides of it.
    expect(beats.filter((b) => b.isDownbeat).map((b) => +b.t.toFixed(6))).toEqual([0, 2.0]);
  });

  it('is phase-continuous: identical spacing on both sides of the offset', () => {
    const beats = beatsInRange(120, 2.0, 4, 0, 4);
    const ts = times(beats);
    const gaps = ts.slice(1).map((t, i) => +(t - ts[i]).toFixed(6));
    expect(new Set(gaps)).toEqual(new Set([0.5])); // no glitch at the offset
  });

  it('a large/absolute offset still clicks from song start (offset is modulo phase)', () => {
    // offset 10.3 and offset (10.3 mod bar = 0.3) must produce the same clicks.
    const big = beatsInRange(120, 10.3, 4, 0, 2);
    const small = beatsInRange(120, 0.3, 4, 0, 2);
    expect(times(big)).toEqual(times(small));
    expect(times(big)[0]).toBeCloseTo(0.3, 9); // first audible click well before 10.3
  });

  it('never starts negative — clicks stay at t >= from', () => {
    const beats = beatsInRange(120, 2.0, 4, 0, 2);
    expect(beats.every((b) => b.t >= 0)).toBe(true);
  });
});

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
    expect(beatTimeAt(3, 120, 0, { '3': 1.55 })).toBeCloseTo(1.55, 9);
  });

  it('beatTimeAt falls back to the macro grid for un-pinned indices', () => {
    expect(beatTimeAt(4, 120, 0, { '3': 1.55 })).toBeCloseTo(2.0, 9);
  });

  it('beatTimeAt ignores overrides at non-integer beat indices', () => {
    // A fractional index can't match any string-keyed entry.
    expect(beatTimeAt(3.5, 120, 0, { '3': 1.55 })).toBeCloseTo(1.75, 9);
  });

  it('snapTimeToGrid returns the pinned time when the macro snap lands on a pinned beat', () => {
    // Macro snap of 1.48s → beat 3 (1.5s). With beat 3 pinned to 1.55, snap returns 1.55.
    expect(snapTimeToGrid(1.48, 120, 0, 4, 'beat', { '3': 1.55 })).toBeCloseTo(1.55, 9);
  });

  it('snapTimeToGrid returns the macro snap when the nearest beat is not pinned', () => {
    expect(snapTimeToGrid(0.95, 120, 0, 4, 'beat', { '3': 1.55 })).toBeCloseTo(1.0, 9);
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
    // Beat 4 starts the second bar at 2.0s (4/4 grid). Pin it to 2.07s — it
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
    expect(beat4!.barNumber).toBe(1);   // second bar, zero-based default
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

// ─── Bar / beat display origin (the "first bar is 1 or 0" setting) ──────────

describe('bar/beat display origin', () => {
  const G = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

  it('defaults to 0 — the first downbeat is bar 0 · beat 0', () => {
    expect(getBarBeatOrigin()).toBe(0);
    expect(formatBeatPosition(0, G.bpm, G.gridOffset, G.beatsPerBar)).toMatchObject({ bar: 0, beat: 0 });
    expect(timeToBarBeat(0, G.bpm, G.gridOffset, G.beatsPerBar)).toBe('0.0');
  });

  it('one-based origin shifts only the numbering, not the time', () => {
    expect(formatBeatPosition(0, G.bpm, G.gridOffset, G.beatsPerBar, 1))
      .toMatchObject({ bar: 1, beat: 1 });
    // 2.0s at 120 BPM = beat 4 = bar 2 beat 1 (1-based) = bar 1 beat 0 (0-based).
    expect(formatBeatPosition(2.0, G.bpm, G.gridOffset, G.beatsPerBar, 1))
      .toMatchObject({ bar: 2, beat: 1 });
    expect(timeToBarBeat(2.0, G.bpm, G.gridOffset, G.beatsPerBar, 3, 1)).toBe('2.1');
  });

  it('parses and round-trips bar.beat under either origin', () => {
    expect(barBeatToTime('0.0', G.bpm, G.gridOffset, G.beatsPerBar, 0)).toBeCloseTo(0, 9);
    expect(barBeatToTime('1.0', G.bpm, G.gridOffset, G.beatsPerBar, 0)).toBeCloseTo(2.0, 9);
    // Same string means different times under the two conventions.
    expect(barBeatToTime('1.1', G.bpm, G.gridOffset, G.beatsPerBar, 1)).toBeCloseTo(0, 9);
    expect(barBeatToTime('1.1', G.bpm, G.gridOffset, G.beatsPerBar, 0)).toBeCloseTo(2.5, 9);
    // A bar-only entry keeps beat at the origin.
    expect(barBeatToTime('1', G.bpm, G.gridOffset, G.beatsPerBar, 0)).toBeCloseTo(2.0, 9);
    // Beats below the origin are rejected.
    expect(barBeatToTime('1.0', G.bpm, G.gridOffset, G.beatsPerBar, 1)).toBeNull();
  });

  it('numbers grid lines from the origin', () => {
    const opts = { ...G, startTime: 0, endTime: 4 };
    const bars1 = visibleGridLines({ ...opts, barGroupSize: 1, barBeatOrigin: 1 as const }).map((l) => l.barNumber);
    const bars0 = visibleGridLines({ ...opts, barGroupSize: 1 }).map((l) => l.barNumber);
    expect(bars1[0]).toBe(1);
    expect(bars0[0]).toBe(0);
    expect(bars0).toEqual(bars1.map((n) => n - 1));
  });

  it('the module-level origin feeds callers that do not pass one', () => {
    try {
      setBarBeatOrigin(1);
      expect(timeToBarBeat(0, G.bpm, G.gridOffset, G.beatsPerBar)).toBe('1.1');
      expect(visibleGridLines({ ...G, startTime: 0, endTime: 4, barGroupSize: 1 })[0].barNumber).toBe(1);
    } finally {
      setBarBeatOrigin(0);
    }
    expect(timeToBarBeat(0, G.bpm, G.gridOffset, G.beatsPerBar)).toBe('0.0');
  });
});

// ─── Magnetic assist ────────────────────────────────────────────────────────
// `toleranceSec` turns snapTimeToGrid from "always align" into "align only if
// the performance was already essentially there". Used by lyrics layers, whose
// times describe a sung onset rather than a position on the song's grid.
describe('snapTimeToGrid with a magnetic tolerance', () => {
  it('pulls a time that is already within tolerance', () => {
    // 120 BPM → a 1/16 every 0.125s. 0.135s is 10ms past the 0.125 line.
    expect(snapTimeToGrid(0.135, 120, 0, 4, '1/4beat', undefined, 0.03))
      .toBeCloseTo(0.125, 9);
  });

  it('leaves a deliberately off-grid time exactly where it is', () => {
    // 0.185s sits 60ms off the nearest 1/16 (0.125) — a laid-back vocal, not a
    // mistyped one. Without the tolerance it would be dragged 60ms early.
    expect(snapTimeToGrid(0.185, 120, 0, 4, '1/4beat', undefined, 0.03))
      .toBeCloseTo(0.185, 9);
    expect(snapTimeToGrid(0.185, 120, 0, 4, '1/4beat'))
      .toBeCloseTo(0.125, 9);
  });

  it('applies the tolerance to a manual beat override too', () => {
    // Beat 2 is hand-moved to 1.20s (from 1.00s). A time 20ms away snaps onto
    // the override; one 150ms away is left alone rather than yanked to it.
    const overrides = { '2': 1.2 };
    expect(snapTimeToGrid(1.18, 120, 0, 4, 'beat', overrides, 0.03))
      .toBeCloseTo(1.2, 9);
    expect(snapTimeToGrid(1.05, 120, 0, 4, 'beat', overrides, 0.03))
      .toBeCloseTo(1.05, 9);
  });

  it('is a no-op switch: omitting the tolerance keeps the classic behaviour', () => {
    expect(snapTimeToGrid(0.26, 120, 0, 4, 'beat')).toBeCloseTo(0.5, 9);
  });
});

describe('coarsenSnapDivision — the snap a hand can actually aim at', () => {
  // The song from the bug report: 100 BPM 4/4 (0.6s a beat, 2.4s a bar), five
  // minutes long, drawn ~1400px wide at fit zoom → ~4.5 px per second.
  const FIT_PX_PER_SEC = 1400 / 312.6;

  it('widens a beat nobody can aim at into a bar', () => {
    // 0.6s × 4.5 px/s = 2.7px a beat — a snap you can neither see nor steer.
    // A bar is 10.8px, which you can.
    expect(coarsenSnapDivision('beat', 100, 4, FIT_PX_PER_SEC)).toBe('bar');
  });

  it('hands the beat back as soon as zoom makes it targetable', () => {
    // Four times in, a beat is ~11px. Nothing to widen.
    expect(coarsenSnapDivision('beat', 100, 4, FIT_PX_PER_SEC * 4)).toBe('beat');
  });

  it('keeps widening past the bar on a grid that is still too fine', () => {
    // 30 BPM 4/4 is 8s a bar, but at 0.5 px/s a bar is only 4px.
    expect(coarsenSnapDivision('beat', 30, 4, 0.5)).toBe('2bar');
  });

  it('never refines: a division already wide enough is returned untouched', () => {
    expect(coarsenSnapDivision('bar', 100, 4, FIT_PX_PER_SEC)).toBe('bar');
    expect(coarsenSnapDivision('4bar', 100, 4, FIT_PX_PER_SEC)).toBe('4bar');
    expect(coarsenSnapDivision('1/4beat', 100, 4, FIT_PX_PER_SEC * 40)).toBe('1/4beat');
  });

  it('walks the ladder from wherever the requested division sits', () => {
    // A 1/16 at 100 BPM is 0.15s. At 20 px/s that is 3px — too fine; the
    // half-beat (0.3s → 6px) is the first rung that clears the bar.
    expect(coarsenSnapDivision('1/4beat', 100, 4, 20)).toBe('1/2beat');
    expect(MIN_SNAP_STEP_PX).toBe(6);
  });

  it('is a no-op without a usable width or tempo', () => {
    expect(coarsenSnapDivision('beat', 100, 4, 0)).toBe('beat');
    expect(coarsenSnapDivision('beat', 0, 4, FIT_PX_PER_SEC)).toBe('beat');
  });

  it('only ever lands on lines the finer grid already had', () => {
    // The whole point of coarsening rather than re-gridding: every landing
    // spot of the widened division is still a beat of the original one.
    const widened = coarsenSnapDivision('beat', 100, 4, FIT_PX_PER_SEC);
    const t = snapTimeToGrid(93.1, 100, 0, 4, widened);
    expect(t).toBeCloseTo(snapTimeToGrid(t, 100, 0, 4, 'beat'), 9);
    expect(t / 0.6).toBeCloseTo(Math.round(t / 0.6), 9);
  });
});

describe('snapping onto the unit the grid is drawn at', () => {
  // 120 BPM 4/4: a beat is 0.5s, so a triplet is 1/6s and a 32nd is 1/16s.
  // These are the divisions the beat-grid unit selector offers; a snap that
  // cannot express one of them rounds the annotation onto a line the user
  // cannot see.
  it('lands on thirds of a beat, not halves', () => {
    expect(snapTimeToGrid(0.2, 120, 0, 4, '1/3beat')).toBeCloseTo(1 / 6, 9);
    expect(snapTimeToGrid(0.3, 120, 0, 4, '1/3beat')).toBeCloseTo(1 / 3, 9);
    // The half-beat line at 0.25s is NOT a landing spot of a triplet grid.
    expect(snapTimeToGrid(0.26, 120, 0, 4, '1/3beat')).not.toBeCloseTo(0.25, 6);
  });

  it('lands on sixths and eighths of a beat', () => {
    expect(snapTimeToGrid(0.1, 120, 0, 4, '1/6beat')).toBeCloseTo(1 / 12, 9);
    expect(snapTimeToGrid(0.07, 120, 0, 4, '1/8beat')).toBeCloseTo(0.0625, 9);
  });

  it('keeps the beat itself a landing spot in both families', () => {
    for (const d of ['1/3beat', '1/6beat', '1/8beat'] as const) {
      expect(snapTimeToGrid(0.49, 120, 0, 4, d)).toBeCloseTo(0.5, 9);
    }
  });

  it('coarsens a triplet along the triplet ladder, never onto a binary line', () => {
    // 100 BPM: a 1/6 is 0.1s. At 20 px/s that is 2px — too fine to aim at;
    // the 1/3 (0.2s → 4px) is still too fine, so the beat (0.6s → 12px) wins.
    expect(coarsenSnapDivision('1/6beat', 100, 4, 20)).toBe('beat');
    // With more room the 1/3 is targetable and is where it stops — 1/2 beat
    // would be wider, and wrong: no triplet line sits there.
    expect(coarsenSnapDivision('1/6beat', 100, 4, 40)).toBe('1/3beat');
    expect(coarsenSnapDivision('1/3beat', 100, 4, 40)).toBe('1/3beat');
  });

  it('coarsening a triplet still only lands on lines the triplet grid had', () => {
    const widened = coarsenSnapDivision('1/6beat', 100, 4, 40);
    const t = snapTimeToGrid(93.1, 100, 0, 4, widened);
    expect(t).toBeCloseTo(snapTimeToGrid(t, 100, 0, 4, '1/6beat'), 9);
  });
});

describe('folding the grid offset into the first bar', () => {
  // 120 BPM 4/4 → 0.5s a beat, 2s a bar.
  it('reduces a multi-bar offset to its phase inside one bar', () => {
    expect(foldGridOffset(7.5, 120, 4)).toBeCloseTo(1.5, 9);
    expect(gridOffsetBarShift(7.5, 120, 4)).toBe(3);
  });

  it('leaves an offset already inside the first bar untouched', () => {
    expect(foldGridOffset(1.5, 120, 4)).toBe(1.5);
    expect(gridOffsetBarShift(1.5, 120, 4)).toBe(0);
  });

  it('folds an exact multiple of a bar to zero', () => {
    expect(foldGridOffset(8, 120, 4)).toBe(0);
    expect(gridOffsetBarShift(8, 120, 4)).toBe(4);
  });

  it('treats a hair under a full bar as a full bar', () => {
    expect(foldGridOffset(2 - 1e-9, 120, 4)).toBe(0);
  });

  it('has nothing to fold against without a usable tempo', () => {
    expect(foldGridOffset(7.5, 0, 4)).toBe(7.5);
    expect(gridOffsetBarShift(7.5, NaN, 4)).toBe(0);
  });

  it('holds every beat line in place — only the numbering moves', () => {
    const folded = foldGridOffset(7.5, 120, 4);
    // Beat 0 of the folded grid is a beat of the original one, 3 bars earlier.
    expect(beatTimeAt(0, 120, folded)).toBeCloseTo(beatTimeAt(-12, 120, 7.5), 9);
    expect(beatIndexAt(5.0, 120, folded) - beatIndexAt(5.0, 120, 7.5)).toBe(12);
  });

  it('numbers the song forwards once the offset is folded', () => {
    // The intro of a song whose bar 1 was set 3¾ bars in used to read as a
    // negative bar; folded, it reads from the front of the song.
    setBarBeatOrigin(1);
    expect(timeToBarBeat(2.0, 120, 7.5, 4)).toMatch(/^-/);
    expect(timeToBarBeat(2.0, 120, foldGridOffset(7.5, 120, 4), 4)).toBe('1.2');
    setBarBeatOrigin(0);
  });
});

// ─── Grid segments ───────────────────────────────────────────────────────────
//
// A song split into segments resolves its grid from the segment table: each
// segment brings its own tempo, its own meter and its own bar 1, and the bar
// the previous segment was in the middle of is cut where the next one starts.

describe('grid segments', () => {
  // 120 BPM 4/4 from 0.32s, split at 10.07s into 92 BPM 6/8. Segment 1 holds
  // 19.5 beats, so its fifth bar keeps 3.5 of 4 and segment 2 opens bar 6.
  const info = {
    ...makeEmptySongInfo('split'),
    bpm: 120,
    timeSignature: '4/4',
    gridOffset: 0.32,
    gridMode: 'mapped' as const,
    gridSegments: [{ id: 'gs_a', start: 10.07, bpm: 92, timeSignature: '6/8' }],
  };
  const segments = resolveGridSegments(info);
  const unsplit = resolveGridSegments({ ...info, gridSegments: [] });

  it('draws every segment at its own tempo and meter', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 14, segments, barBeatOrigin: 1,
    });
    const first = lines.filter((l) => l.t < 10.07);
    const second = lines.filter((l) => l.t >= 10.07);
    // Segment 1 steps in half seconds; segment 2 in 60/92.
    expect(first[1].t - first[0].t).toBeCloseTo(0.5, 6);
    expect(second[1].t - second[0].t).toBeCloseTo(60 / 92, 6);
  });

  it('starts the new segment on bar 1, beat 1 of its own grid', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 9, endTime: 11, segments, barBeatOrigin: 1,
    });
    const head = lines.find((l) => Math.abs(l.t - 10.07) < 1e-6);
    expect(head).toBeDefined();
    expect(head!.isBar).toBe(true);
  });

  it('emits the head line exactly once', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 14, segments,
    });
    expect(lines.filter((l) => Math.abs(l.t - 10.07) < 1e-6)).toHaveLength(1);
  });

  it('leaves the cut bar short rather than stretching it', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 14, segments,
    });
    const bars = lines.filter((l) => l.isBar).map((l) => l.t);
    // Bar 5 opens at 8.32s and is cut at 10.07s — 1.75s, not a full 2s bar.
    expect(bars).toContainEqual(expect.closeTo(8.32, 6));
    expect(bars.find((t) => t > 8.33 && t < 10.07)).toBeUndefined();
  });

  it('keeps bar numbers running across the split', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 14, segments, barBeatOrigin: 1,
    });
    const head = lines.find((l) => Math.abs(l.t - 10.07) < 1e-6)!;
    expect(head.barNumber).toBe(6);
  });

  it('restarts bar numbers when the song asks it to', () => {
    const restart = resolveGridSegments({ ...info, barNumbering: 'restart' as const });
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 14, segments: restart, barBeatOrigin: 1,
    });
    const head = lines.find((l) => Math.abs(l.t - 10.07) < 1e-6)!;
    expect(head.barNumber).toBe(1);
  });

  it('bars the second segment every six beats, not four', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 10, endTime: 20, segments,
    });
    const bars = lines.filter((l) => l.isBar && l.t >= 10.07).map((l) => l.t);
    expect(bars[1] - bars[0]).toBeCloseTo(6 * (60 / 92), 6);
  });

  it('reads bar.beat in the local meter', () => {
    expect(timeToBarBeat(10.07, 120, 0.32, 4, 3, 1, segments)).toBe('6.1');
    // Five 6/8 beats past the head is bar 6, beat 6.
    const t = 10.07 + 5 * (60 / 92);
    expect(timeToBarBeat(t, 120, 0.32, 4, 3, 1, segments)).toBe('6.6');
  });

  it('round-trips bar.beat through time', () => {
    for (const s of ['2.1', '5.3', '6.1', '7.4']) {
      const t = barBeatToTime(s, 120, 0.32, 4, 1, segments)!;
      expect(timeToBarBeat(t, 120, 0.32, 4, 3, 1, segments)).toBe(s);
    }
  });

  it('snaps inside the segment that owns the time', () => {
    // 10.9s is nearest the head's second 6/8 beat, not a 120 BPM beat.
    const snapped = snapTimeToGrid(10.9, 120, 0.32, 4, 'beat', undefined, undefined, segments);
    expect(snapped).toBeCloseTo(10.07 + 60 / 92, 6);
  });

  it('snaps to bars in the local meter', () => {
    const snapped = snapTimeToGrid(13.5, 120, 0.32, 4, 'bar', undefined, undefined, segments);
    expect(snapped).toBeCloseTo(10.07 + 6 * (60 / 92), 6);
  });

  it('clicks the metronome in the local meter', () => {
    const beats = beatsInRange(120, 0.32, 4, 10.0, 15.0, undefined, segments);
    const downbeats = beats.filter((b) => b.isDownbeat).map((b) => b.t);
    expect(downbeats[0]).toBeCloseTo(10.07, 6);
    expect(downbeats[1] - downbeats[0]).toBeCloseTo(6 * (60 / 92), 6);
  });

  it('honours a pinned beat under its segment-scoped key', () => {
    const overrides = { 'gs_a:2': 11.9 };
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 10, endTime: 14, segments, beatOverrides: overrides,
    });
    const pinned = lines.find((l) => l.isOverridden);
    expect(pinned?.t).toBe(11.9);
  });

  it('still honours a legacy pin keyed by plain beat index', () => {
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 6, segments, beatOverrides: { '4': 2.5 },
    });
    expect(lines.find((l) => l.isOverridden)?.t).toBe(2.5);
  });

  it('agrees with the canonical override key helper', () => {
    // beatGrid keeps its own copy of the key format to avoid a runtime
    // import cycle; the two must never drift apart.
    const lines = visibleGridLines({
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 10, endTime: 13, segments,
      beatOverrides: { [beatOverrideKey(segments, 22)]: 11.75 },
    });
    expect(lines.find((l) => l.isOverridden)?.t).toBe(11.75);
  });

  it('changes nothing for a song that was never split', () => {
    const opts = {
      bpm: 120, gridOffset: 0.32, beatsPerBar: 4,
      startTime: 0, endTime: 12, barBeatOrigin: 1 as const,
    };
    expect(visibleGridLines({ ...opts, segments: unsplit }))
      .toEqual(visibleGridLines(opts));
    expect(beatIndexAt(5, 120, 0.32, unsplit))
      .toBe(beatIndexAt(5, 120, 0.32));
    expect(timeToBarBeat(5, 120, 0.32, 4, 3, 1, unsplit))
      .toBe(timeToBarBeat(5, 120, 0.32, 4, 3, 1));
  });

  it('counts beats and bars continuously across the split', () => {
    // Last beat of segment 1 is index 19; the head is index 20.
    expect(beatIndexAt(9.9, 120, 0.32, segments)).toBe(19);
    expect(beatIndexAt(10.07, 120, 0.32, segments)).toBe(20);
    expect(beatTimeAt(20, 120, 0.32, undefined, segments)).toBeCloseTo(10.07, 9);
    expect(barIndexAt(10.07, 120, 0.32, 4, segments)).toBe(5);
  });
});

describe('adaptiveGridThicknessScale', () => {
  it('is thinnest at fit and grows with zoom', () => {
    const fit = adaptiveGridThicknessScale(1);
    expect(fit).toBeCloseTo(0.4, 6);
    expect(adaptiveGridThicknessScale(4)).toBeGreaterThan(fit);
    expect(adaptiveGridThicknessScale(16)).toBeGreaterThan(adaptiveGridThicknessScale(4));
  });

  it('reads as 1x around the middle of the zoom range', () => {
    expect(adaptiveGridThicknessScale(6.25)).toBeCloseTo(1, 6);
  });

  it('clamps both ends', () => {
    expect(adaptiveGridThicknessScale(0.1)).toBe(0.4);
    expect(adaptiveGridThicknessScale(10_000)).toBe(2);
  });

  it('falls back to 1x on a nonsense zoom', () => {
    expect(adaptiveGridThicknessScale(0)).toBe(1);
    expect(adaptiveGridThicknessScale(NaN)).toBe(1);
  });
});
