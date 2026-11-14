import { describe, expect, it } from 'vitest';
import type { AnnotationLayer } from '../types/annotationLayer';
import { isSnappableLane, snapLayerItems } from './laneSnap';

// Beats every half second.
const snap = (t: number) => Math.round(t * 2) / 2;

const layer = (type: string, items: unknown[]) =>
  ({ id: 'l', name: 'L', type, color: '#fff', visible: true, items } as unknown as AnnotationLayer);

describe('snapLayerItems', () => {
  it('moves cue and boundary times and their candidates onto the beat', () => {
    const { layer: out, moved } = snapLayerItems(layer('cues', [
      { id: 'a', time: 1.1, candidates: [1.6] },
      { id: 'b', time: 2.0 },
    ]), snap);
    expect(moved).toBe(1);
    expect(out.items).toEqual([
      { id: 'a', time: 1.0, candidates: [1.5] },
      { id: 'b', time: 2.0 },
    ]);
  });

  it('moves both edges of a span or loop', () => {
    const { layer: out, moved } = snapLayerItems(layer('spans', [{ id: 'a', start: 0.9, end: 2.2 }]), snap);
    expect(moved).toBe(1);
    expect(out.items).toEqual([{ id: 'a', start: 1.0, end: 2.0 }]);
  });

  it('leaves a span alone rather than squeeze it to nothing', () => {
    const items = [{ id: 'a', start: 1.05, end: 1.2 }];
    const { layer: out, moved } = snapLayerItems(layer('loops', items), snap);
    expect(moved).toBe(0);
    expect(out.items).toEqual(items);
  });

  it('returns the same layer when nothing moves', () => {
    const l = layer('boundaries', [{ id: 'a', time: 1.5 }]);
    expect(snapLayerItems(l, snap)).toEqual({ layer: l, moved: 0 });
  });

  it('never touches lyrics or riff patterns', () => {
    expect(isSnappableLane(layer('lyrics', []))).toBe(false);
    expect(isSnappableLane(layer('riff-patterns', []))).toBe(false);
    const l = layer('lyrics', [{ id: 'a', start: 1.1, end: 1.9 }]);
    expect(snapLayerItems(l, snap)).toEqual({ layer: l, moved: 0 });
  });
});
