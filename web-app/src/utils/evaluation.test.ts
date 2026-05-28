import { describe, it, expect } from 'vitest';
import {
  intervalIoU,
  evaluateSpans,
  evaluateLoops,
  evaluateLyrics,
  effectiveLayerMode,
} from './evaluation';
import type { SpanItem, LoopItem, LyricsItem } from '../types/annotationLayer';

// ─── Interval IoU ────────────────────────────────────────────────────────────

describe('intervalIoU', () => {
  it('returns 1 for identical intervals', () => {
    expect(intervalIoU([0, 2], [0, 2])).toBe(1);
  });

  it('returns 0 for disjoint intervals', () => {
    expect(intervalIoU([0, 1], [2, 3])).toBe(0);
  });

  it('returns intersection/union for partial overlap', () => {
    // [0,2] ∩ [1,3] = [1,2] (len 1); union = [0,3] (len 3) → 1/3
    expect(intervalIoU([0, 2], [1, 3])).toBeCloseTo(1 / 3, 5);
  });

  it('treats touching but not overlapping as 0', () => {
    expect(intervalIoU([0, 1], [1, 2])).toBe(0);
  });
});

// ─── effectiveLayerMode ──────────────────────────────────────────────────────

describe('effectiveLayerMode', () => {
  it('honours the layer mode when the global override is off', () => {
    expect(effectiveLayerMode('full-annotation', false)).toBe('full-annotation');
    expect(effectiveLayerMode('multiple-candidates', false)).toBe('multiple-candidates');
  });

  it('defaults a missing layer mode to full-annotation when override is off', () => {
    expect(effectiveLayerMode(undefined, false)).toBe('full-annotation');
  });

  it('forces multiple-candidates when the global override is on, regardless of layer mode', () => {
    expect(effectiveLayerMode('full-annotation', true)).toBe('multiple-candidates');
    expect(effectiveLayerMode(undefined, true)).toBe('multiple-candidates');
  });
});

// ─── evaluateSpans ───────────────────────────────────────────────────────────

const span = (id: string, start: number, end: number, label = 'voice'): SpanItem => ({
  id, start, end, label,
});

describe('evaluateSpans', () => {
  const DUR = 10;

  it('returns empty result when either side is empty', () => {
    const empty = evaluateSpans([], [], DUR);
    expect(empty.refCount).toBe(0);
    expect(empty.estCount).toBe(0);
    expect(empty.matchedPairs).toBe(0);
  });

  it('scores a perfect prediction as 1.0 across all metrics', () => {
    const ref = [span('r1', 0, 2), span('r2', 5, 8)];
    const est = [span('p1', 0, 2), span('p2', 5, 8)];
    const r = evaluateSpans(ref, est, DUR);
    expect(r.meanIoU).toBe(1);
    expect(r.frameF1).toBe(1);
    expect(r.frameP).toBe(1);
    expect(r.frameR).toBe(1);
    expect(r.onsetF1).toBe(1);
    expect(r.offsetF1).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.matchedPairs).toBe(2);
  });

  it('penalises edge shifts in onset/offset F1 but tolerates them in IoU', () => {
    const ref = [span('r1', 0, 2)];
    // Shifted by 0.5s — well outside the 100 ms default tolerance for edges,
    // but inside the IoU overlap region (3/4 IoU).
    const est = [span('p1', 0.5, 2.5)];
    const r = evaluateSpans(ref, est, DUR);
    expect(r.meanIoU).toBeCloseTo(3 / 5, 2);  // intersection 1.5, union 2.5
    expect(r.onsetF1).toBe(0);
    expect(r.offsetF1).toBe(0);
    // Frame F1 should remain high — most frames still overlap.
    expect(r.frameF1).toBeGreaterThan(0.5);
  });

  it('drops coverage when prediction misses a ref span', () => {
    const ref = [span('r1', 0, 2), span('r2', 5, 8)];
    const est = [span('p1', 0, 2)];
    const r = evaluateSpans(ref, est, DUR);
    expect(r.matchedPairs).toBe(1);
    // 2/5 of ref-frames covered (ref total: 2+3=5 frames @ 1s; covered: 2)
    expect(r.coverage).toBeCloseTo(2 / 5, 2);
  });

  it('multiple-candidates mode collapses recall to binary per layer', () => {
    const ref = [span('r1', 0, 2), span('r2', 5, 8)];
    // Match only one of the two alternates.
    const est = [span('p1', 0, 2)];
    const full   = evaluateSpans(ref, est, DUR, { mode: 'full-annotation' });
    const cand   = evaluateSpans(ref, est, DUR, { mode: 'multiple-candidates' });
    // Standard recall: 1 of 2 hit → frame-R drops.
    expect(full.frameR).toBeLessThan(1);
    // Multiple-candidates: ANY hit satisfies the layer → recall = 1.
    expect(cand.frameR).toBe(1);
  });

  it('uses per-item candidates to widen the matching window', () => {
    // The single ref item is at [10, 12] BUT also accepts [0, 2] as an alternate.
    const ref: SpanItem[] = [{
      id: 'r1', start: 10, end: 12, label: 'voice',
      candidates: [[0, 2]],
    }];
    const est = [span('p1', 0, 2)];
    const r = evaluateSpans(ref, est, DUR);
    // With candidates honoured, the prediction matches perfectly.
    expect(r.meanIoU).toBe(1);
    expect(r.matchedPairs).toBe(1);
  });
});

// ─── stub forwards ───────────────────────────────────────────────────────────

describe('evaluateLoops + evaluateLyrics stubs', () => {
  it('evaluateLoops forwards to evaluateSpans on shared shape', () => {
    const ref: LoopItem[] = [{ id: 'r1', start: 0, end: 4, label: 'a' }];
    const est: LoopItem[] = [{ id: 'p1', start: 0, end: 4, label: 'a' }];
    const r = evaluateLoops(ref, est, 10);
    expect(r.meanIoU).toBe(1);
  });

  it('evaluateLyrics uses 50 ms tolerance for edge F1', () => {
    const ref: LyricsItem[] = [{ id: 'r1', time: 0, end: 0.4, text: 'hi', kind: 'line' }];
    const est: LyricsItem[] = [{ id: 'p1', time: 0.03, end: 0.43, text: 'hi', kind: 'line' }];
    const r = evaluateLyrics(ref, est, 10);
    // 30 ms shift is inside the 50 ms tolerance → onsetF1 = 1.
    expect(r.onsetF1).toBe(1);
  });
});
