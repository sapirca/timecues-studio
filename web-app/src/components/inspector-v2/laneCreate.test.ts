import { describe, it, expect } from 'vitest';
import {
  emptyDocument,
  newCueLayer,
  newLoopLayer,
  newLyricsLayer,
  newSpanLayer,
  type AnnotationLayer,
  type AnnotationLayersDocument,
} from '../../types/annotationLayer';
import { createLaneItem, sameLayersDoc, withoutItem } from './laneCreate';

function docWith(...layers: AnnotationLayer[]): AnnotationLayersDocument {
  return { ...emptyDocument('song'), layers };
}

function itemsOf(doc: AnnotationLayersDocument, layerId: string) {
  return doc.layers.find((l) => l.id === layerId)!.items as unknown as readonly Record<string, unknown>[];
}

describe('createLaneItem', () => {
  it('a click on a cue lane drops one cue at that time', () => {
    const cues = newCueLayer('Kicks', '#ff0000');
    const r = createLaneItem(docWith(cues), cues.id, 12.5, null, 200);
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(itemsOf(r.doc, cues.id)).toEqual([expect.objectContaining({ id: r.itemId, time: 12.5 })]);
  });

  it('a drag makes the item in the lane it was drawn on, not another of its type', () => {
    const a = newSpanLayer('A', '#00ff00');
    const b = newSpanLayer('B', '#0000ff');
    const r = createLaneItem(docWith(a, b), b.id, 10, 14, 200);
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(itemsOf(r.doc, a.id)).toHaveLength(0);
    expect(itemsOf(r.doc, b.id)).toEqual([expect.objectContaining({ start: 10, end: 14 })]);
  });

  it('orders a right-to-left drag and clamps it to the song', () => {
    const loops = newLoopLayer('Loops', '#ffff00');
    const r = createLaneItem(docWith(loops), loops.id, 205, 190, 200);
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(itemsOf(r.doc, loops.id)).toEqual([
      expect.objectContaining({ start: 190, end: 200, snapZeroCross: true }),
    ]);
  });

  it('a lyrics drag makes an empty line over the stretch', () => {
    const lyrics = newLyricsLayer('Vocals', '#ff00ff');
    const r = createLaneItem(docWith(lyrics), lyrics.id, 3, 7, 200);
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(itemsOf(r.doc, lyrics.id)).toEqual([
      expect.objectContaining({ time: 3, end: 7, kind: 'line', text: '' }),
    ]);
  });

  it('refuses a second item on exactly the same spot and names the one there', () => {
    const spans = newSpanLayer('Spans', '#00ffff');
    const first = createLaneItem(docWith(spans), spans.id, 4, 8, 200);
    if (first.kind !== 'added') throw new Error(first.kind);
    const again = createLaneItem(first.doc, spans.id, 4, 8, 200);
    expect(again).toEqual(expect.objectContaining({ kind: 'duplicate', itemId: first.itemId }));
  });

  it('does nothing on a detector lane, an interval with no length, or a lane it cannot make', () => {
    const detector = { ...newSpanLayer('Detector', '#888888'), readOnly: true };
    const spans = newSpanLayer('Spans', '#00ffff');
    const doc = docWith(detector, spans);
    expect(createLaneItem(doc, detector.id, 1, 5, 200).kind).toBe('none');
    expect(createLaneItem(doc, spans.id, 5, 5.01, 200).kind).toBe('none');
    expect(createLaneItem(doc, spans.id, 5, null, 200).kind).toBe('none');
    expect(createLaneItem(doc, 'missing', 1, 5, 200).kind).toBe('none');
  });
});

describe('withoutItem', () => {
  it('takes a dropped draft back out, wherever it now sits', () => {
    const a = newSpanLayer('A', '#00ff00');
    const b = newSpanLayer('B', '#0000ff');
    const base = docWith(a, b);
    const r = createLaneItem(base, b.id, 1, 2, 200);
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(sameLayersDoc(withoutItem(r.doc, r.itemId), base)).toBe(true);
  });

  it('returns the same document when the item is not in it', () => {
    const doc = docWith(newCueLayer('Cues', '#ff0000'));
    expect(withoutItem(doc, 'nope')).toBe(doc);
    expect(withoutItem(null, 'nope')).toBe(null);
  });
});
