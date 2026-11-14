import { describe, it, expect } from 'vitest';
import {
  lockedLayerEdited, mergeTargets, splitKinds, splitLayerByKind, copyLayerRegion, regionLabel,
} from './laneActions';
import {
  emptyDocument, newCueLayer, newSpanLayer, newCueItem, newSpanItem,
  type AnnotationLayer, type AnnotationLayersDocument,
} from '../types/annotationLayer';

const docOf = (...layers: AnnotationLayer[]): AnnotationLayersDocument => ({ ...emptyDocument('s'), layers });

describe('lockedLayerEdited', () => {
  const lane = () => {
    const l = newCueLayer('Kicks', '#111');
    l.items = [newCueItem(1, 'kick')];
    l.locked = true;
    return l;
  };

  it('flags an edit to a locked lane\'s items', () => {
    const a = lane();
    const prev = docOf(a);
    const next = docOf({ ...a, items: [...a.items, newCueItem(2, 'kick')] });
    expect(lockedLayerEdited(prev, next)?.id).toBe(a.id);
  });

  it('lets name, colour, visibility and group change', () => {
    const a = lane();
    const next = docOf({ ...a, name: 'K', color: '#222', visible: false, groupId: 'g' });
    expect(lockedLayerEdited(docOf(a), next)).toBeNull();
  });

  it('lets a lane be unlocked or deleted, and ignores a rebuilt-but-equal layer', () => {
    const a = lane();
    expect(lockedLayerEdited(docOf(a), docOf({ ...a, locked: false, items: [] }))).toBeNull();
    expect(lockedLayerEdited(docOf(a), docOf())).toBeNull();
    expect(lockedLayerEdited(docOf(a), docOf(structuredClone(a)))).toBeNull();
  });

  it('counts a nested name as content (a riff node rename)', () => {
    const a = { ...lane(), nodes: [{ id: 'n', name: 'A' }] } as unknown as AnnotationLayer;
    const b = { ...a, nodes: [{ id: 'n', name: 'B' }] } as unknown as AnnotationLayer;
    expect(lockedLayerEdited(docOf(a), docOf(b))).not.toBeNull();
  });
});

describe('mergeTargets', () => {
  it('offers same-type authored lanes, never a locked one', () => {
    const a = newCueLayer('A', '#1');
    const b = newCueLayer('B', '#2');
    const c = { ...newCueLayer('C', '#3'), locked: true };
    const s = newSpanLayer('S', '#4');
    const doc = docOf(a, b, c, s);
    expect(mergeTargets(doc, a.id).map((l) => l.id)).toEqual([b.id]);
    expect(mergeTargets(doc, c.id)).toEqual([]);
  });
});

describe('splitLayerByKind', () => {
  it('replaces a lane with one per kind, in place, the biggest keeping the id', () => {
    const a = newCueLayer('Drums', '#111');
    a.items = [newCueItem(1, 'snare'), newCueItem(2, 'kick · soft'), newCueItem(3, 'kick'), newCueItem(4, '')];
    a.groupId = 'g';
    const z = newCueLayer('Z', '#999');
    expect(splitKinds(a)).toEqual(['kick', 'snare', 'unlabelled']);
    let n = 0;
    const next = splitLayerByKind(docOf(a, z), a.id, () => `id${++n}`);
    expect(next.layers.map((l) => l.name)).toEqual(['Drums · kick', 'Drums · snare', 'Drums · unlabelled', 'Z']);
    expect(next.layers[0].id).toBe(a.id);
    expect(next.layers[0].color).toBe('#111');
    expect(next.layers[0].items).toHaveLength(2);
    expect(next.layers.slice(0, 3).every((l) => l.groupId === 'g')).toBe(true);
    expect(new Set(next.layers.map((l) => l.color)).size).toBe(4);
  });

  it('leaves a one-kind lane alone', () => {
    const a = newCueLayer('K', '#1');
    a.items = [newCueItem(1, 'kick'), newCueItem(2, 'kick')];
    const doc = docOf(a);
    expect(splitKinds(a)).toEqual([]);
    expect(splitLayerByKind(doc, a.id)).toBe(doc);
  });
});

describe('copyLayerRegion', () => {
  it('copies points inside and spans overlapping the region, whole', () => {
    const s = newSpanLayer('Riser', '#1');
    s.items = [newSpanItem(0, 10, 'a'), newSpanItem(25, 40, 'b'), newSpanItem(50, 60, 'c')];
    s.locked = true;
    const next = copyLayerRegion(docOf(s), s.id, 30, 45, 'cp');
    const copy = next.layers[1];
    expect(copy.id).toBe('cp');
    expect(copy.name).toBe('Riser 0:30–0:45');
    expect((copy as AnnotationLayer<'spans'>).items.map((it) => [it.start, it.end])).toEqual([[25, 40]]);
    expect(copy.locked).toBeUndefined();

    const c = newCueLayer('Hits', '#2');
    c.items = [newCueItem(29, 'x'), newCueItem(30, 'y'), newCueItem(45, 'z')];
    expect((copyLayerRegion(docOf(c), c.id, 30, 45).layers[1] as AnnotationLayer<'cues'>).items.map((it) => it.label)).toEqual(['y', 'z']);
  });

  it('makes nothing when no item is in the region', () => {
    const c = newCueLayer('Hits', '#2');
    c.items = [newCueItem(1, 'x')];
    const doc = docOf(c);
    expect(copyLayerRegion(doc, c.id, 30, 45)).toBe(doc);
  });

  it('labels a region m:ss–m:ss', () => {
    expect(regionLabel(90.4, 125.9)).toBe('1:30–2:05');
  });
});
