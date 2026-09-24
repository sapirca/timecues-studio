/**
 * Vocal runs — the sung stretches a lyrics layer contributes to the Prominence
 * lane. What matters here is the shape of the grouping, so most of this file
 * pins down the three things the derivation must not do: split a verse on an
 * ordinary breath, fuse two choruses across a real break, and let the outward
 * bar snap swallow the gap that separated them.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOCAL_RUN_GAP_BARS,
  deriveVocalRuns,
  mergeVocalRunWithNext,
  resolveVocalRuns,
  splitVocalRun,
  vocalRunsAreDerived,
  type VocalRunGrid,
} from './vocalRuns';
import type { AnnotationLayer, LyricsItem, VocalRun } from '../types/annotationLayer';

/** 120 BPM, 4/4 — one beat is 0.5s and one bar is exactly 2s, which keeps every
 *  expectation in this file readable as a bar number. */
const GRID: VocalRunGrid = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

function word(time: number, text = 'la'): LyricsItem {
  return { id: `w${time}`, time, text, kind: 'word' };
}

/** Words on every beat from `from` to `to`, exclusive — one sung phrase. */
function phrase(from: number, to: number): LyricsItem[] {
  const out: LyricsItem[] = [];
  for (let t = from; t < to; t += 0.5) out.push(word(Number(t.toFixed(3))));
  return out;
}

describe('deriveVocalRuns', () => {
  it('returns nothing for a layer with no lyrics', () => {
    expect(deriveVocalRuns([], GRID)).toEqual([]);
    expect(deriveVocalRuns(undefined, GRID)).toEqual([]);
  });

  it('gives a chorus / break / chorus three-part song exactly two runs', () => {
    // Bars 1-4 sung, bars 5-8 instrumental, bars 9-12 sung.
    const items = [...phrase(0, 8), ...phrase(16, 24)];
    const runs = deriveVocalRuns(items, GRID);
    expect(runs).toHaveLength(2);
    expect(runs[0].start).toBeCloseTo(0);
    expect(runs[0].end).toBeCloseTo(8);
    expect(runs[1].start).toBeCloseTo(16);
    expect(runs[1].end).toBeCloseTo(24);
  });

  it('does not split a verse on one bar of rest between lines', () => {
    // Two lines with a single bar (2s) of silence between them — ordinary
    // phrasing, and the whole reason the default threshold is two bars.
    const items = [...phrase(0, 4), ...phrase(6, 10)];
    const runs = deriveVocalRuns(items, GRID);
    expect(runs).toHaveLength(1);
  });

  it('splits that same verse when the annotator tightens the gap to one bar', () => {
    const items = [...phrase(0, 4), ...phrase(6, 10)];
    expect(deriveVocalRuns(items, GRID, { gapBars: 1 })).toHaveLength(2);
  });

  it('measures the gap in bars, so the same rest survives a tempo change', () => {
    // 1.5 bars of rest. At 120 BPM that is 3s; at 60 BPM the same 1.5 bars is
    // 6s. Neither should split at the 2-bar default.
    const fast = deriveVocalRuns([...phrase(0, 4), word(7), word(7.5)], GRID);
    const slowGrid: VocalRunGrid = { bpm: 60, gridOffset: 0, beatsPerBar: 4 };
    const slow = deriveVocalRuns([...phrase(0, 4), word(10), word(10.5)], slowGrid);
    expect(fast).toHaveLength(1);
    expect(slow).toHaveLength(1);
  });

  it('snaps a run that starts on a pickup back to its bar line', () => {
    // First word half a beat before bar 3 (t=4): the block must open on the bar
    // the chorus opens on, not a quaver late.
    const runs = deriveVocalRuns([word(4.25), word(4.75), word(5.25)], GRID);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBeCloseTo(4);
    expect(runs[0].end).toBeCloseTo(6);
  });

  it('leaves an edge already sitting on a bar line exactly where it is', () => {
    const runs = deriveVocalRuns([word(4), word(5.5)], GRID);
    expect(runs[0].start).toBeCloseTo(4);
  });

  it('keeps two runs disjoint when the outward snap would have fused them', () => {
    // Sung to 3.9s, silent until 8.1s — a real 4.2s break, but bar-snapping the
    // first end forward to 4.0 and the second start back to 8.0 leaves them
    // adjacent, and a longer break would have them overlap outright.
    const items = [...phrase(0, 3.9), word(8.1), word(8.6)];
    const runs = deriveVocalRuns(items, GRID);
    expect(runs).toHaveLength(2);
    expect(runs[0].end).toBeLessThanOrEqual(runs[1].start);
  });

  it('retreats both edges to the middle of the silence rather than overlapping', () => {
    // Snapping 5.9 → 6 and 6.1 → 6 would make a zero-length gap; with a wider
    // outward push they would cross. Both are pulled to the midpoint of the
    // original silence instead.
    const runs = deriveVocalRuns([word(0), word(5.9), word(6.4), word(11)], GRID, { gapBars: 0.5 });
    for (let i = 0; i < runs.length - 1; i++) {
      expect(runs[i].end).toBeLessThanOrEqual(runs[i + 1].start + 1e-9);
    }
  });

  it('still groups when the song has no usable tempo', () => {
    const items = [...phrase(0, 3), word(20), word(20.5)];
    const runs = deriveVocalRuns(items, undefined);
    expect(runs).toHaveLength(2);
    // No grid, no snap: the edges are the words themselves.
    expect(runs[0].start).toBeCloseTo(0);
  });

  it('sorts unsorted items before grouping', () => {
    const items = [word(6), word(0), word(0.5), word(6.5)];
    const runs = deriveVocalRuns(items, GRID);
    expect(runs[0].start).toBeLessThan(runs[runs.length - 1].start);
  });

  it('lets a line item cover its whole sung length, not just its onset', () => {
    // A `line` with an `end` bridges a gap that its onset alone would split.
    const line: LyricsItem = { id: 'l1', time: 0, end: 7, text: 'held note', kind: 'line' };
    expect(deriveVocalRuns([line, word(7.5)], GRID)).toHaveLength(1);
    expect(deriveVocalRuns([word(0), word(7.5)], GRID)).toHaveLength(2);
  });

  it('gives the same run the same id every time it is derived', () => {
    const items = [...phrase(0, 8), ...phrase(16, 24)];
    expect(deriveVocalRuns(items, GRID).map((r) => r.id))
      .toEqual(deriveVocalRuns(items, GRID).map((r) => r.id));
  });

  it('clamps an out-of-range gap rather than trusting it', () => {
    const items = [...phrase(0, 4), ...phrase(6, 10)];
    // 0 bars would split on every word; the floor keeps it musical.
    expect(deriveVocalRuns(items, GRID, { gapBars: 0 }).length).toBeGreaterThan(0);
    expect(deriveVocalRuns(items, GRID, { gapBars: 1000 })).toHaveLength(1);
  });
});

describe('resolveVocalRuns', () => {
  const layer = (extra: Partial<AnnotationLayer<'lyrics'>> = {}): AnnotationLayer<'lyrics'> => ({
    id: 'L', name: 'Vocal', type: 'lyrics', visible: true, color: '#a78bfa', snap: 'off',
    items: [...phrase(0, 8), ...phrase(16, 24)],
    ...extra,
  } as AnnotationLayer<'lyrics'>);

  it('derives when nothing is stored', () => {
    const l = layer();
    expect(vocalRunsAreDerived(l)).toBe(true);
    expect(resolveVocalRuns(l, GRID)).toHaveLength(2);
  });

  it('reads the layer own gap setting', () => {
    expect(resolveVocalRuns(layer({ vocalRunGapBars: 8 }), GRID)).toHaveLength(1);
    expect(DEFAULT_VOCAL_RUN_GAP_BARS).toBe(2);
  });

  it('prefers stored runs outright and never re-derives behind them', () => {
    // The stored list disagrees with what the words imply; it wins, because a
    // lyric correction must not reshape a run the annotator already levelled.
    const stored: VocalRun[] = [{ id: 'kept', start: 0, end: 30 }];
    const l = layer({ vocalRuns: stored });
    expect(vocalRunsAreDerived(l)).toBe(false);
    expect(resolveVocalRuns(l, GRID)).toEqual(stored);
  });

  it('ignores a stored run with no length', () => {
    const l = layer({ vocalRuns: [{ id: 'a', start: 4, end: 4 }, { id: 'b', start: 8, end: 12 }] });
    expect(resolveVocalRuns(l, GRID).map((r) => r.id)).toEqual(['b']);
  });

  it('returns nothing for a layer that is not lyrics', () => {
    expect(resolveVocalRuns({ type: 'spans', items: [], vocalRuns: undefined } as never, GRID))
      .toEqual([]);
  });
});

describe('splitVocalRun', () => {
  const runs: VocalRun[] = [{ id: 'a', start: 0, end: 10, prominence: [{ t: 0, level: 'lead' }] }];

  it('cuts a run in two at the given time', () => {
    const next = splitVocalRun(runs, 'a', 4);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ start: 0, end: 4 });
    expect(next[1]).toMatchObject({ start: 4, end: 10 });
  });

  it('carries the level in effect at the cut into the tail', () => {
    const next = splitVocalRun(runs, 'a', 4);
    expect(next[1].prominence).toEqual([{ t: 0, level: 'lead' }]);
  });

  it('re-bases the tail breakpoints onto its own start', () => {
    const withArc: VocalRun[] = [{
      id: 'a', start: 0, end: 10,
      prominence: [{ t: 0, level: 'lead' }, { t: 6, level: 'backing' }],
    }];
    const next = splitVocalRun(withArc, 'a', 4);
    // The backing breakpoint was 6s into a run starting at 0; it is now 2s into
    // a run starting at 4.
    expect(next[1].prominence).toEqual([{ t: 0, level: 'lead' }, { t: 2, level: 'backing' }]);
  });

  it('refuses a cut at or outside the run edges', () => {
    expect(splitVocalRun(runs, 'a', 0)).toHaveLength(1);
    expect(splitVocalRun(runs, 'a', 10)).toHaveLength(1);
    expect(splitVocalRun(runs, 'a', 40)).toHaveLength(1);
  });

  it('leaves the list alone for an unknown id', () => {
    expect(splitVocalRun(runs, 'nope', 4)).toEqual(runs);
  });
});

describe('mergeVocalRunWithNext', () => {
  const runs: VocalRun[] = [
    { id: 'a', start: 0, end: 4, prominence: [{ t: 0, level: 'lead' }] },
    { id: 'b', start: 8, end: 12, prominence: [{ t: 0, level: 'counter' }] },
  ];

  it('joins a run to the one after it, closing the gap', () => {
    const next = mergeVocalRunWithNext(runs, 'a');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'a', start: 0, end: 12 });
  });

  it('keeps the first run identity so an annotated block does not change under the annotator', () => {
    expect(mergeVocalRunWithNext(runs, 'a')[0].id).toBe('a');
  });

  it('re-bases the second run breakpoints onto the survivor', () => {
    // 'b' said counter from its own start (t=8 in track terms), which is 8s
    // into the merged run.
    expect(mergeVocalRunWithNext(runs, 'a')[0].prominence)
      .toEqual([{ t: 0, level: 'lead' }, { t: 8, level: 'counter' }]);
  });

  it('does nothing on the last run, or an unknown id', () => {
    expect(mergeVocalRunWithNext(runs, 'b')).toEqual(runs);
    expect(mergeVocalRunWithNext(runs, 'nope')).toEqual(runs);
  });
});
