import { describe, expect, it } from 'vitest';
import {
  BPM_CLAMP,
  bpmScore,
  meterScore,
  pairScore,
  greedyBpmLadder,
  DEFAULT_WEIGHTS,
} from './setlist';
import type { SetlistEntry } from '../types/setlist';

const entry = (slug: string, bpm: number | null, meter: string | null = '4/4'): SetlistEntry => ({
  slug,
  name: slug,
  bpm,
  meter,
});

describe('bpmScore', () => {
  it('is 1 when BPMs are identical', () => {
    expect(bpmScore(120, 120)).toBe(1);
  });

  it('is 0 when BPMs are at or beyond the clamp', () => {
    expect(bpmScore(100, 100 + BPM_CLAMP)).toBe(0);
    expect(bpmScore(100, 100 + BPM_CLAMP + 5)).toBe(0);
  });

  it('decreases monotonically with the BPM gap', () => {
    const sClose = bpmScore(120, 122);
    const sMid = bpmScore(120, 125);
    const sFar = bpmScore(120, 127);
    expect(sClose).toBeGreaterThan(sMid);
    expect(sMid).toBeGreaterThan(sFar);
  });

  it('is symmetric', () => {
    expect(bpmScore(120, 124)).toBeCloseTo(bpmScore(124, 120), 10);
  });

  it('returns 0 when either side is missing', () => {
    expect(bpmScore(null, 120)).toBe(0);
    expect(bpmScore(120, null)).toBe(0);
    expect(bpmScore(undefined, undefined)).toBe(0);
  });
});

describe('meterScore', () => {
  it('matching meter wins, mismatch is penalised, unknown is neutral', () => {
    expect(meterScore('4/4', '4/4')).toBe(1);
    expect(meterScore('4/4', '3/4')).toBe(0.3);
    expect(meterScore(null, '4/4')).toBe(0.5);
  });
});

describe('pairScore', () => {
  it('reduces to bpmScore when only the bpm weight is nonzero', () => {
    const a = entry('a', 120);
    const b = entry('b', 124);
    expect(pairScore(a, b, { bpm: 1, meter: 0, energy: 0 })).toBeCloseTo(bpmScore(120, 124), 10);
  });

  it('combines BPM + meter with their relative weights', () => {
    const a = entry('a', 120, '4/4');
    const b = entry('b', 120, '3/4');
    // identical bpm → bpm contributes 1; meter mismatch → meter contributes 0.3.
    // With weights 1/1 the average is 0.65.
    expect(pairScore(a, b, { bpm: 1, meter: 1, energy: 0 })).toBeCloseTo(0.65, 10);
  });

  it('returns 0 when every weight is 0', () => {
    expect(pairScore(entry('a', 120), entry('b', 120), { bpm: 0, meter: 0, energy: 0 })).toBe(0);
  });
});

describe('greedyBpmLadder', () => {
  it('orders by ascending BPM when all gaps are within the clamp', () => {
    const entries = [entry('c', 124), entry('a', 120), entry('b', 122)];
    const { order } = greedyBpmLadder(entries, DEFAULT_WEIGHTS);
    expect(order.map((e) => e.slug)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic — same input → same output', () => {
    const entries = [entry('a', 120), entry('b', 120), entry('c', 120)];
    const r1 = greedyBpmLadder(entries, DEFAULT_WEIGHTS);
    const r2 = greedyBpmLadder(entries, DEFAULT_WEIGHTS);
    expect(r1.order.map((e) => e.slug)).toEqual(r2.order.map((e) => e.slug));
  });

  it('parks songs with no BPM at the end in original order', () => {
    const entries = [entry('a', 120), entry('x', null), entry('b', 122), entry('y', null)];
    const { order } = greedyBpmLadder(entries, DEFAULT_WEIGHTS);
    expect(order.map((e) => e.slug)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('returns one pair score per adjacent pair of BPM-having songs', () => {
    const entries = [entry('a', 120), entry('b', 122), entry('c', 124)];
    const { order, pairScores } = greedyBpmLadder(entries, DEFAULT_WEIGHTS);
    expect(order.map((e) => e.slug)).toEqual(['a', 'b', 'c']);
    expect(pairScores).toHaveLength(2);
    // pair (120, 122) is closer than (122, 124)? No — same gap. Just sanity-check both are positive.
    expect(pairScores[0]).toBeGreaterThan(0);
    expect(pairScores[1]).toBeGreaterThan(0);
  });

  it('returns an empty order when given no entries', () => {
    expect(greedyBpmLadder([], DEFAULT_WEIGHTS).order).toEqual([]);
  });
});
