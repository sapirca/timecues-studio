import { describe, it, expect } from 'vitest';
import { planGridLockSnap } from './gridLockSnap';
import type { AnnotationLayer } from '../types/annotationLayer';

const snap = (t: number) => Math.round(t * 2) / 2;
const layers = [
  { id: 'b', type: 'boundaries', name: 'Bnd', items: [
    { id: 'b1', time: 1.2, type: 'x', label: 'drop' }, { id: 'b2', time: 2, type: 'x', label: 'on grid' }] },
  { id: 'l', type: 'loops', name: 'Loops', items: [{ id: 'l1', start: 0.9, end: 4.1, label: 'hook' }] },
  { id: 'r', type: 'riff-patterns', name: 'Riffs', items: [
    { id: 'r1', start: 1.2, end: 3.3, label: 'riff', sequence: [], repeatCount: 1 }] },
  { id: 'c', type: 'cues', name: 'Cues', items: [{ id: 'c1', time: 1.2, label: 'hit' }] },
] as unknown as AnnotationLayer[];

describe('planGridLockSnap', () => {
  it('moves only the picked types, and lists exactly what moved', () => {
    const plan = planGridLockSnap(layers, ['boundaries', 'riff-patterns'], snap);
    expect(plan.moves.boundaries.map((m) => [m.label, m.from.start, m.to.start])).toEqual([['drop', 1.2, 1]]);
    expect(plan.moves.loops).toEqual([]);
    expect(plan.layers[1]).toBe(layers[1]);
    expect(plan.layers[3]).toBe(layers[3]);
    const riff = plan.moves['riff-patterns'][0];
    expect(riff.to.start).toBe(1);
    expect(riff.to.end).toBeCloseTo(3.1);
  });

  it('a loop moves both edges', () => {
    const [m] = planGridLockSnap(layers, ['loops'], snap).moves.loops;
    expect(m.from).toEqual({ start: 0.9, end: 4.1 });
    expect(m.to).toEqual({ start: 1, end: 4 });
  });
});

describe('planGridLockSnap at storage resolution', () => {
  // A grid line that falls between milliseconds, and the boundary a snapped
  // add stored on it — rounded to the ms like every add path and detector.
  const line = 0.40541;
  const toLine = (t: number) => (Math.abs(t - line) < 0.25 ? line : t);
  const roundMs = (t: number) => Math.round(t * 1000) / 1000;
  const onGrid = [{ id: 'b', type: 'boundaries', name: 'Bnd', items: [
    { id: 'b1', time: 0.405, type: 'x', label: 'Intro' }] }] as unknown as AnnotationLayer[];

  it('a time already on the grid, stored to the ms, does not move', () => {
    expect(planGridLockSnap(onGrid, ['boundaries'], (t) => roundMs(toLine(t))).moves.boundaries).toEqual([]);
  });

  it('(the raw grid time would have read as a sub-ms move)', () => {
    expect(planGridLockSnap(onGrid, ['boundaries'], toLine).moves.boundaries).toHaveLength(1);
  });
});
