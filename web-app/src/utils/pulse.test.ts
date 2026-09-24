import { describe, expect, it } from 'vitest';
import {
  PULSE_MAX_TICKS,
  pulseGridOptions,
  pulseIntervalSec,
  pulseReadout,
  pulseTickTimes,
  pulseTicksPerBar,
} from './pulse';
import {
  PULSE_OPTIONS,
  PULSE_RATES,
  PULSE_SILENT,
  isTickingPulse,
  pulsePeriodBeats,
} from '../types/annotationLayer';

/** 120 BPM ⇒ a beat every 0.5 s, a 4/4 bar every 2 s. Grid origin at 0, so
 *  every expected tick time below can be read off by hand. */
const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

const round = (ts: number[]) => ts.map((t) => Number(t.toFixed(4)));

describe('pulsePeriodBeats', () => {
  it('reads every rate as a fraction of a beat', () => {
    expect(pulsePeriodBeats('8th')).toBe(0.5);
    expect(pulsePeriodBeats('8th-triplet')).toBeCloseTo(1 / 3, 10);
    expect(pulsePeriodBeats('beat')).toBe(1);
  });

  it('resolves a bar against the meter, not against 4/4', () => {
    expect(pulsePeriodBeats('bar', 4)).toBe(4);
    expect(pulsePeriodBeats('bar', 3)).toBe(3);
    // 6/8: the BPM counts 8ths, so a bar is six of them — the whole reason
    // the vocabulary is beat-relative.
    expect(pulsePeriodBeats('bar', 6)).toBe(6);
  });
});

describe('pulseTickTimes', () => {
  it('puts a tick on every beat', () => {
    const ticks = pulseTickTimes({ rate: 'beat', start: 0, end: 2, ...GRID });
    expect(round(ticks)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('subdivides the beat', () => {
    const ticks = pulseTickTimes({ rate: '8th', start: 0, end: 1, ...GRID });
    expect(round(ticks)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('places triplets evenly inside the beat', () => {
    const ticks = pulseTickTimes({ rate: '8th-triplet', start: 0, end: 1, ...GRID });
    expect(round(ticks)).toEqual([0, 0.1667, 0.3333, 0.5, 0.6667, 0.8333, 1]);
  });

  it('ticks once per bar at the bar rate', () => {
    const ticks = pulseTickTimes({ rate: 'bar', start: 0, end: 8, ...GRID });
    expect(round(ticks)).toEqual([0, 2, 4, 6, 8]);
  });

  it('stays on the grid when the window does not', () => {
    // A span dragged to a ragged 1.1 s–2.4 s still marks the beats inside it;
    // it does not start counting from its own left edge. This is the property
    // that makes a derived pulse survive a trim.
    const ticks = pulseTickTimes({ rate: 'beat', start: 1.1, end: 2.4, ...GRID });
    expect(round(ticks)).toEqual([1.5, 2]);
  });

  it('follows the grid offset', () => {
    const ticks = pulseTickTimes({ rate: 'beat', start: 0, end: 1.5, bpm: 120, gridOffset: 0.2, beatsPerBar: 4 });
    expect(round(ticks)).toEqual([0.2, 0.7, 1.2]);
  });

  it('honours a per-beat override, so the ticks match the beats drawn', () => {
    // Beat 2 pinned 40 ms late in Manual mode: the pulse has to move with it,
    // or the annotation sits off the grid it is describing.
    const ticks = pulseTickTimes({
      rate: 'beat', start: 0, end: 1.5, ...GRID, beatOverrides: { 2: 1.04 },
    });
    // Beat 3 is untouched at 1.5 — an override moves its own beat, not the
    // grid after it.
    expect(round(ticks)).toEqual([0, 0.5, 1.04, 1.5]);
  });

  it('returns nothing without a tempo — a pulse needs a grid to mean anything', () => {
    expect(pulseTickTimes({ rate: 'beat', start: 0, end: 10, bpm: undefined })).toEqual([]);
    expect(pulseTickTimes({ rate: 'beat', start: 0, end: 10, bpm: 0 })).toEqual([]);
  });

  it('returns nothing for a degenerate window', () => {
    expect(pulseTickTimes({ rate: 'beat', start: 4, end: 4, ...GRID })).toEqual([]);
    expect(pulseTickTimes({ rate: 'beat', start: 4, end: 1, ...GRID })).toEqual([]);
  });

  it('gives up rather than thinning out an over-dense pulse', () => {
    // Half the rate would be a different annotation, so the caller gets
    // nothing to draw and names the rate in words instead.
    const tooMany = pulseTickTimes({ rate: '32nd', start: 0, end: 600, ...GRID });
    expect(tooMany).toEqual([]);
    const justEnough = pulseTickTimes({ rate: 'beat', start: 0, end: 20, ...GRID, maxTicks: 10 });
    expect(justEnough).toEqual([]);
  });

  it('draws right up to the cap', () => {
    // 120 BPM ⇒ 0.5 s per beat: 200 beats in 100 s, plus the tick on the
    // closing edge, is comfortably inside the default cap.
    const ticks = pulseTickTimes({ rate: 'beat', start: 0, end: 100, ...GRID });
    expect(ticks.length).toBe(201);
    expect(ticks.length).toBeLessThanOrEqual(PULSE_MAX_TICKS);
  });

  it('never emits a tick outside the window', () => {
    for (const rate of PULSE_RATES) {
      const ticks = pulseTickTimes({ rate, start: 3.3, end: 7.7, ...GRID });
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(3.3);
        expect(t).toBeLessThanOrEqual(7.7);
      }
    }
  });

  it('spaces its ticks by the rate it was asked for', () => {
    for (const rate of PULSE_RATES) {
      const ticks = pulseTickTimes({ rate, start: 0, end: 8, ...GRID });
      expect(ticks.length).toBeGreaterThan(1);
      const expected = pulseIntervalSec(rate, 120, 4)!;
      for (let i = 1; i < ticks.length; i += 1) {
        expect(ticks[i] - ticks[i - 1]).toBeCloseTo(expected, 6);
      }
    }
  });
});

describe('silence', () => {
  it('is an option the picker offers, but never a rate the grid draws', () => {
    expect(PULSE_OPTIONS).toContain(PULSE_SILENT);
    expect(PULSE_RATES).not.toContain(PULSE_SILENT as never);
    expect(isTickingPulse(PULSE_SILENT)).toBe(false);
    expect(isTickingPulse(undefined)).toBe(false);
    expect(isTickingPulse('8th')).toBe(true);
  });

  it('emits no ticks, however good the grid is', () => {
    expect(pulseTickTimes({ rate: PULSE_SILENT, start: 0, end: 8, ...GRID })).toEqual([]);
  });

  it('has no interval and no hits per bar', () => {
    expect(pulseIntervalSec(PULSE_SILENT, 120, 4)).toBeNull();
    expect(pulseTicksPerBar(PULSE_SILENT, 4)).toBe(0);
  });

  it('reads out in words rather than in milliseconds', () => {
    expect(pulseReadout(PULSE_SILENT, 120, 4)).toBe('Silent · nothing hits here');
    // And says the same thing before the song has a grid — unlike a rate,
    // silence does not need one to be true.
    expect(pulseReadout(PULSE_SILENT, undefined)).toBe('Silent · nothing hits here');
  });
});

describe('pulseGridOptions', () => {
  it('asks the grid emitter for the same lines the viz bar would draw', () => {
    expect(pulseGridOptions('16th')).toEqual({ subBeatDivision: 4 });
    expect(pulseGridOptions('beat')).toEqual({});
    expect(pulseGridOptions('bar')).toEqual({ barGroupSize: 1 });
  });
});

describe('readouts', () => {
  it('measures the gap between hits', () => {
    expect(pulseIntervalSec('8th', 120)).toBeCloseTo(0.25, 10);
    expect(pulseIntervalSec('bar', 120, 4)).toBeCloseTo(2, 10);
    expect(pulseIntervalSec('beat', undefined)).toBeNull();
  });

  it('counts hits per bar', () => {
    expect(pulseTicksPerBar('16th', 4)).toBe(16);
    expect(pulseTicksPerBar('beat', 3)).toBe(3);
    expect(pulseTicksPerBar('bar', 4)).toBe(1);
  });

  it('spells the rate out, and falls back to the label without a tempo', () => {
    expect(pulseReadout('8th', 120, 4)).toBe('1/2 beat · every 250 ms · 8 per bar');
    expect(pulseReadout('bar', 120, 4)).toBe('Bar · every 2.00 s · 1 per bar');
    expect(pulseReadout('8th', undefined)).toBe('1/2 beat');
  });
});
