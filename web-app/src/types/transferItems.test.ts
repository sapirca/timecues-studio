/**
 * Dragging items into another lane. What has to hold: the items arrive whole
 * at the times they had when the drag began, a copy leaves the source exactly
 * as it was (originals restored, fresh ids in the target), a move takes them
 * out and keeps their ids, and every transfer the canvas must refuse — another
 * type, a detector lane, boundaries, loops that would overlap — leaves the
 * document exactly as it was.
 */

import { describe, it, expect } from 'vitest';
import {
  loopsWouldOverlap,
  newBoundaryItem,
  newBoundaryLayer,
  newCueItem,
  newCueLayer,
  newLoopLayer,
  newLyricsItem,
  newLyricsLayer,
  newSpanItem,
  newSpanLayer,
  transferItems,
  type AnnotationLayer,
  type AnnotationLayersDocument,
} from './annotationLayer';

function doc(layers: AnnotationLayer[]): AnnotationLayersDocument {
  return { song: 'a-song', annotated_at: '2026-01-01T00:00:00.000Z', layers };
}

describe('transferItems', () => {
  it('copies spans with every field, fresh ids, and the source untouched', () => {
    const span = { ...newSpanItem(4, 8, 'riser'), pulse: '1/4' as const, color: '#ff0000' };
    const a = { ...newSpanLayer('A', '#111111'), items: [span] };
    const b = newSpanLayer('B', '#222222');
    const next = transferItems(doc([a, b]), a.id, b.id, [span], { move: false });
    expect(next.layers[0].items).toEqual([span]);
    const [copy] = next.layers[1].items as typeof span[];
    expect(copy.id).not.toBe(span.id);
    expect({ ...copy, id: span.id }).toEqual(span);
  });

  it('lands at the times the drag began with, not where a nudge left them', () => {
    const original = newCueItem(2, 'hit');
    const nudged = { ...original, time: 2.4 };
    const a = { ...newCueLayer('A', '#111111'), items: [nudged] };
    const b = newCueLayer('B', '#222222');
    const copied = transferItems(doc([a, b]), a.id, b.id, [original], { move: false });
    expect(copied.layers[0].items).toEqual([original]);
    expect((copied.layers[1].items[0] as typeof original).time).toBe(2);
    const moved = transferItems(doc([a, b]), a.id, b.id, [original], { move: true });
    expect(moved.layers[0].items).toEqual([]);
    expect(moved.layers[1].items).toEqual([original]);
  });

  it('moves a group of lyric words and leaves the rest of the verse', () => {
    const words = [newLyricsItem(1, 'we'), newLyricsItem(1.4, "don't"), newLyricsItem(1.9, 'sleep')];
    const lead = { ...newLyricsLayer('lead', '#111111'), items: words };
    const backing = newLyricsLayer('backing', '#222222');
    const next = transferItems(doc([lead, backing]), lead.id, backing.id, words.slice(1), { move: true });
    expect(next.layers[0].items).toEqual([words[0]]);
    expect(next.layers[1].items).toEqual(words.slice(1));
  });

  it('refuses a lane of another type, and a read-only lane at either end', () => {
    const cue = newCueItem(2);
    const mine = { ...newCueLayer('mine', '#111111'), items: [cue] };
    const spans = newSpanLayer('spans', '#333333');
    const detector = { ...newCueLayer('detector', '#222222'), readOnly: true };
    const d = doc([mine, spans, detector]);
    expect(transferItems(d, mine.id, spans.id, [cue], { move: false })).toBe(d);
    expect(transferItems(d, mine.id, detector.id, [cue], { move: false })).toBe(d);
    const fromDetector = { ...detector, items: [cue] };
    const d2 = doc([fromDetector, { ...mine, items: [] }]);
    expect(transferItems(d2, fromDetector.id, mine.id, [cue], { move: true })).toBe(d2);
  });

  it('refuses boundaries, which tile their lane', () => {
    const item = newBoundaryItem(10, 'chorus');
    const a = { ...newBoundaryLayer('A', '#111111'), items: [item] };
    const b = newBoundaryLayer('B', '#222222');
    const d = doc([a, b]);
    expect(transferItems(d, a.id, b.id, [item], { move: false })).toBe(d);
  });

  it('refuses loops that would overlap a loop already in the target', () => {
    const loop = { id: 'l1', start: 4, end: 8, label: '' };
    const a = { ...newLoopLayer('A', '#111111'), items: [loop] };
    const b = { ...newLoopLayer('B', '#222222'), items: [{ id: 'l2', start: 7, end: 9, label: '' }] };
    const d = doc([a, b]);
    expect(transferItems(d, a.id, b.id, [loop], { move: false })).toBe(d);
    const clear = { ...b, items: [{ id: 'l2', start: 8, end: 9, label: '' }] };
    expect(transferItems(doc([a, clear]), a.id, clear.id, [loop], { move: false }).layers[1].items).toHaveLength(2);
  });

  it('is a no-op onto its own lane or for items that are not there', () => {
    const cue = newCueItem(2);
    const a = { ...newCueLayer('A', '#111111'), items: [cue] };
    const b = newCueLayer('B', '#222222');
    const d = doc([a, b]);
    expect(transferItems(d, a.id, a.id, [cue], { move: true })).toBe(d);
    expect(transferItems(d, a.id, b.id, [{ id: 'missing' }], { move: true })).toBe(d);
  });
});

describe('loopsWouldOverlap', () => {
  it('lets loops touch end to start, but not overlap', () => {
    expect(loopsWouldOverlap([{ start: 0, end: 4 }], [{ start: 4, end: 8 }])).toBe(false);
    expect(loopsWouldOverlap([{ start: 0, end: 4 }], [{ start: 3.9, end: 8 }])).toBe(true);
  });
});
