import { describe, expect, it } from 'vitest';
import {
  PATTERN_SUBBEATS_PER_BEAT,
  emptyDocument,
  fitRiffInstanceEnd,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  riffCycleSteps,
  riffSequenceSteps,
  withFittedRiffInstances,
  type AnnotationLayer,
  type AnnotationLayersDocument,
  type RiffPatternItem,
} from './annotationLayer';

const BPM = 120;
/** One sub-step at 120 bpm: a 16th note, 125 ms. */
const STEP = (60 / BPM) / PATTERN_SUBBEATS_PER_BEAT;

function instance(start: number, end: number, ...lengths: number[]): RiffPatternItem {
  return {
    ...newRiffPatternItem(start, end, 'Instance 1'),
    sequence: lengths.map((n) => newRiffSeqEntry('node-a', n)),
  };
}

function docWith(...items: RiffPatternItem[]): AnnotationLayersDocument {
  const layer = { ...newRiffPatternLayer('Riff Patterns 1', '#22c55e'), items } as AnnotationLayer;
  return { ...emptyDocument('song'), layers: [layer] };
}

const itemsOf = (doc: AnnotationLayersDocument) =>
  doc.layers[0].items as RiffPatternItem[];

describe('fitRiffInstanceEnd', () => {
  it('trims a cycle that is longer than its sequence', () => {
    // 16 steps = 4 beats = 2.0s at 120 bpm, placed in a 3.0s window.
    const fitted = fitRiffInstanceEnd(instance(10, 13, 16), BPM);
    expect(fitted.end).toBeCloseTo(12, 9);
    expect(fitted.start).toBe(10);
  });

  it('extends a cycle that is shorter than its sequence', () => {
    const fitted = fitRiffInstanceEnd(instance(10, 10.5, 16), BPM);
    expect(fitted.end).toBeCloseTo(12, 9);
  });

  it('sums every entry, so a multi-entry sequence fits its total', () => {
    const fitted = fitRiffInstanceEnd(instance(0, 9, 16, 8, 4), BPM);
    expect(riffSequenceSteps(fitted)).toBe(28);
    expect(fitted.end).toBeCloseTo(28 * STEP, 9);
  });

  it('leaves the cycle exactly as many steps as the sequence has', () => {
    const fitted = fitRiffInstanceEnd(instance(7.31, 99, 13), BPM);
    expect(riffCycleSteps(fitted.end - fitted.start, BPM)).toBe(13);
  });

  it('is a fixed point — refitting changes nothing, by reference', () => {
    const once = fitRiffInstanceEnd(instance(10, 13, 16), BPM);
    expect(fitRiffInstanceEnd(once, BPM)).toBe(once);
  });

  it('leaves an empty sequence alone — nothing to be as long as', () => {
    const item = instance(10, 13);
    expect(fitRiffInstanceEnd(item, BPM)).toBe(item);
  });

  it('leaves everything alone without a tempo grid', () => {
    const item = instance(10, 13, 16);
    expect(fitRiffInstanceEnd(item, 0)).toBe(item);
  });

  it('never moves start — the placement is the anchor', () => {
    expect(fitRiffInstanceEnd(instance(41.7, 44.2, 24), BPM).start).toBe(41.7);
  });
});

describe('withFittedRiffInstances', () => {
  it('fits every instance in every riff layer', () => {
    const doc = docWith(instance(0, 3, 16), instance(20, 20.1, 8));
    const [a, b] = itemsOf(withFittedRiffInstances(doc, BPM));
    expect(a.end).toBeCloseTo(2, 9);
    expect(b.end).toBeCloseTo(21, 9);
  });

  it('returns the same document reference when nothing needs fitting', () => {
    const doc = withFittedRiffInstances(docWith(instance(0, 3, 16)), BPM);
    expect(withFittedRiffInstances(doc, BPM)).toBe(doc);
  });

  it('returns the same reference without a bpm', () => {
    const doc = docWith(instance(0, 3, 16));
    expect(withFittedRiffInstances(doc, 0)).toBe(doc);
  });

  it('leaves read-only layers untouched — they are re-derived, not edited', () => {
    const doc = docWith(instance(0, 3, 16));
    doc.layers[0] = { ...doc.layers[0], readOnly: true } as AnnotationLayer;
    expect(withFittedRiffInstances(doc, BPM)).toBe(doc);
  });

  it('leaves other layer types alone', () => {
    const doc = { ...emptyDocument('song'), layers: [] } as AnnotationLayersDocument;
    expect(withFittedRiffInstances(doc, BPM)).toBe(doc);
  });
});
