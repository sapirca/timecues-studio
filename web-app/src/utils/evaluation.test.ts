import { describe, it, expect } from 'vitest';
import {
  intervalIoU,
  evaluateSpans,
  evaluateLoops,
  evaluateLyrics,
  evaluatePatterns,
  effectiveLayerMode,
} from './evaluation';
import type { SpanItem, LoopItem, LyricsItem, PatternItem } from '../types/annotationLayer';

function pattern(id: string, start: number, end: number, repeatCount: number, highlightedBeats: number[] = []): PatternItem {
  return { id, start, end, label: id, repeatCount, highlightedBeats };
}

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
    // No word-kind items, so WER is 0 and word onset F1 is the empty-set 1.
    expect(r.wer).toBe(0);
    expect(r.wordOnsetF1).toBe(1);
    expect(r.refWordCount).toBe(0);
  });

  it('evaluateLyrics word path: perfect text + inside tolerance → tp=N', () => {
    const ref: LyricsItem[] = [
      { id: 'r1', time: 0.0, text: 'hello', kind: 'word' },
      { id: 'r2', time: 0.5, text: 'world', kind: 'word' },
    ];
    const est: LyricsItem[] = [
      { id: 'p1', time: 0.02, text: 'Hello', kind: 'word' },     // case-insensitive
      { id: 'p2', time: 0.54, text: 'world!', kind: 'word' },    // punctuation stripped
    ];
    const r = evaluateLyrics(ref, est, 10);
    expect(r.wer).toBe(0);
    expect(r.matchedWords).toBe(2);
    expect(r.wordOnsetF1).toBe(1);
  });

  it('evaluateLyrics word path: substitution counts in WER, not in onset F1', () => {
    const ref: LyricsItem[] = [
      { id: 'r1', time: 0.0, text: 'one', kind: 'word' },
      { id: 'r2', time: 1.0, text: 'two', kind: 'word' },
    ];
    const est: LyricsItem[] = [
      { id: 'p1', time: 0.0, text: 'one', kind: 'word' },
      { id: 'p2', time: 1.0, text: 'TWICE', kind: 'word' }, // sub
    ];
    const r = evaluateLyrics(ref, est, 10);
    expect(r.wer).toBeCloseTo(0.5, 5);
    expect(r.matchedWords).toBe(1);
    // 1 tp / 2 est, 1 tp / 2 ref → F1 = 0.5
    expect(r.wordOnsetF1).toBeCloseTo(0.5, 5);
  });

  it('evaluateLyrics word path: word matches text but onset > 50 ms → not tp', () => {
    const ref: LyricsItem[] = [{ id: 'r1', time: 0.0, text: 'late', kind: 'word' }];
    const est: LyricsItem[] = [{ id: 'p1', time: 0.2, text: 'late', kind: 'word' }];
    const r = evaluateLyrics(ref, est, 10);
    expect(r.wer).toBe(0);             // text matches
    expect(r.matchedWords).toBe(1);    // text-aligned
    expect(r.wordOnsetF1).toBe(0);     // but onset too far off
  });
});

describe('evaluateLoops bar-grid metrics', () => {
  // 120 BPM, 4/4 → bar length = 60/120 * 4 = 2.0 sec
  const barGrid = { bpm: 120, beatsPerBar: 4 };

  it('barSnapFraction = 1 when every predicted loop is bar-aligned', () => {
    const ref: LoopItem[] = [{ id: 'r1', start: 0, end: 2, label: 'a' }];
    const est: LoopItem[] = [
      { id: 'p1', start: 0, end: 2, label: 'a' },   // starts and ends on grid
      { id: 'p2', start: 4, end: 8, label: 'b' },   // 2-bar loop, also aligned
    ];
    const r = evaluateLoops(ref, est, 10, { barGrid });
    expect(r.barSnapFraction).toBe(1);
    expect(r.phasePopFreeFraction).toBe(1);
  });

  it('phasePopFreeFraction penalises non-integer-bar durations', () => {
    const ref: LoopItem[] = [{ id: 'r1', start: 0, end: 2, label: 'a' }];
    const est: LoopItem[] = [
      { id: 'p1', start: 0, end: 2,   label: 'a' },   // 1-bar — phase-pop free
      { id: 'p2', start: 0, end: 2.3, label: 'b' },   // 1.15-bar — pop
    ];
    const r = evaluateLoops(ref, est, 10, { barGrid });
    expect(r.phasePopFreeFraction).toBe(0.5);
  });

  it('NaN when no bar grid is provided — table shows "—"', () => {
    const ref: LoopItem[] = [{ id: 'r1', start: 0, end: 2, label: 'a' }];
    const est: LoopItem[] = [{ id: 'p1', start: 0, end: 2, label: 'a' }];
    const r = evaluateLoops(ref, est, 10);
    expect(Number.isNaN(r.barSnapFraction)).toBe(true);
    expect(Number.isNaN(r.phasePopFreeFraction)).toBe(true);
  });
});

describe('evaluatePatterns', () => {
  it('cycle F1 expands repeats: ref start=0 end=1 repeat=4 → 4 tile starts', () => {
    const ref: PatternItem[] = [pattern('r1', 0, 1, 4)];
    const est: PatternItem[] = [pattern('p1', 0, 1, 4)];
    const r = evaluatePatterns(ref, est, 10);
    expect(r.refCycleCount).toBe(4);
    expect(r.estCycleCount).toBe(4);
    expect(r.cycleAlignmentF1).toBe(1);
  });

  it('cycle F1 penalises missing repeats', () => {
    const ref: PatternItem[] = [pattern('r1', 0, 1, 4)];   // 4 tiles at 0,1,2,3
    const est: PatternItem[] = [pattern('p1', 0, 1, 2)];   // 2 tiles at 0,1
    const r = evaluatePatterns(ref, est, 10);
    // tp=2, fp=0, fn=2 → P=1, R=0.5, F1=2/3
    expect(r.cycleAlignmentF1).toBeCloseTo(2 / 3, 5);
  });

  it('accent Jaccard scores highlightedBeats agreement on paired patterns', () => {
    const ref: PatternItem[] = [pattern('r1', 0, 4, 1, [0, 2, 4])];
    const est: PatternItem[] = [pattern('p1', 0, 4, 1, [0, 2, 6])];
    const r = evaluatePatterns(ref, est, 10);
    // |{0,2}| / |{0,2,4,6}| = 2/4 = 0.5
    expect(r.accentJaccard).toBe(0.5);
    expect(r.matchedAccentPairs).toBe(1);
  });

  it('accent Jaccard returns 1 when both pair sets are empty (no accents)', () => {
    const ref: PatternItem[] = [pattern('r1', 0, 4, 1, [])];
    const est: PatternItem[] = [pattern('p1', 0, 4, 1, [])];
    const r = evaluatePatterns(ref, est, 10);
    expect(r.accentJaccard).toBe(1);
  });
});
