import { describe, it, expect } from 'vitest';
import { canMergeLayers, mergeLayers } from './annotationLayers';
import {
  emptyDocument,
  newCueLayer,
  newSpanLayer,
  newLyricsLayer,
  newCueItem,
  newSpanItem,
  newLyricsItem,
  type AnnotationLayer,
  type AnnotationLayersDocument,
} from '../types/annotationLayer';

function docOf(...layers: AnnotationLayer[]): AnnotationLayersDocument {
  return { ...emptyDocument('song'), layers };
}

describe('mergeLayers', () => {
  it('moves the source items into the target, sorted, and drops the source', () => {
    const a = { ...newSpanLayer('Wordless vocals', '#f00'), items: [newSpanItem(10, 12, 'ooh')] };
    const b = { ...newSpanLayer('Wordless other', '#0f0'), items: [newSpanItem(2, 4, 'aah'), newSpanItem(20, 21, 'mm')] };
    const out = mergeLayers(docOf(a, b), b.id, a.id);
    expect(out.layers.map((l) => l.id)).toEqual([a.id]);
    expect(out.layers[0].name).toBe('Wordless vocals');
    expect(out.layers[0].color).toBe('#f00');
    expect((out.layers[0].items as { start: number }[]).map((i) => i.start)).toEqual([2, 10, 20]);
  });

  it('keeps an exact duplicate once and renews a colliding id', () => {
    const shared = newCueItem(1, 'hit');
    const clash = { ...newCueItem(5, 'other'), id: shared.id };
    const a = { ...newCueLayer('A', '#f00'), items: [shared] };
    const b = { ...newCueLayer('B', '#0f0'), items: [{ ...shared }, clash] };
    const items = mergeLayers(docOf(a, b), b.id, a.id).layers[0].items as { id: string; time: number }[];
    expect(items.map((i) => i.time)).toEqual([1, 5]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it('refuses different types, read-only layers and riff patterns', () => {
    const cue = newCueLayer('C', '#f00');
    const span = newSpanLayer('S', '#0f0');
    const ro = { ...newSpanLayer('R', '#00f'), readOnly: true };
    const riffA = { ...newCueLayer('P', '#fff'), type: 'riff-patterns' } as AnnotationLayer;
    const riffB = { ...newCueLayer('Q', '#fff'), type: 'riff-patterns' } as AnnotationLayer;
    const doc = docOf(cue, span, ro, riffA, riffB);
    expect(canMergeLayers(doc, cue.id, span.id)).toBe(false);
    expect(canMergeLayers(doc, ro.id, span.id)).toBe(false);
    expect(canMergeLayers(doc, span.id, ro.id)).toBe(false);
    expect(canMergeLayers(doc, riffA.id, riffB.id)).toBe(false);
    expect(canMergeLayers(doc, span.id, span.id)).toBe(false);
    expect(mergeLayers(doc, cue.id, span.id)).toBe(doc);
  });

  it('lyrics: stored vocal runs on either side survive, the other side is derived', () => {
    const a = {
      ...newLyricsLayer('Vocals', '#f00'),
      items: [newLyricsItem(1, 'la', 'word', 1.5)],
      vocalRuns: [{ id: 'run-a', start: 1, end: 1.5, prominence: [{ t: 0, level: 'lead' as const }] }],
    } as AnnotationLayer;
    const b = { ...newLyricsLayer('Other', '#0f0'), items: [newLyricsItem(30, 'oh', 'word', 31)] };
    const merged = mergeLayers(docOf(a, b), b.id, a.id).layers[0];
    expect(merged.items).toHaveLength(2);
    expect(merged.vocalRuns?.[0].id).toBe('run-a');
    expect(merged.vocalRuns?.[0].prominence).toBeDefined();
    expect(merged.vocalRuns!.length).toBeGreaterThanOrEqual(2);
    expect(merged.vocalRuns![1].start).toBeGreaterThanOrEqual(30);
  });

  it('lyrics: with no stored runs nothing is stored', () => {
    const a = { ...newLyricsLayer('Vocals', '#f00'), items: [newLyricsItem(1, 'la')] };
    const b = { ...newLyricsLayer('Other', '#0f0'), items: [newLyricsItem(3, 'oh')] };
    expect(mergeLayers(docOf(a, b), b.id, a.id).layers[0].vocalRuns).toBeUndefined();
  });
});
