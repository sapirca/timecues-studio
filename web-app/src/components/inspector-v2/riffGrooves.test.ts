import { describe, it, expect } from 'vitest';
import {
  RIFF_NODE_SILENCE_ID,
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  type AnnotationLayer,
  type RiffNode,
  type RiffOccurrence,
  type RiffPatternItem,
} from '../../types/annotationLayer';
import { REST_MOTIF, riffGrooveLane, toggleBarStep, toggleNodeStep } from './riffGrooves';

const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

/** A one-bar node of one-16th hits at `steps`. */
function node(name: string, steps: number[], extra: Partial<RiffNode> = {}): RiffNode {
  const base = newRiffNode(name, '#f59e0b', 4);
  return {
    ...base,
    segments: steps.map((st) => ({ start: st / 4, end: (st + 1) / 4, kind: 'tick' as const })),
    ...extra,
  };
}

function item(start: number, n: RiffNode | string, reps = 1, occurrences?: RiffOccurrence[]): RiffPatternItem {
  const id = typeof n === 'string' ? n : n.id;
  return {
    ...newRiffPatternItem(start, start + 2, ''), sequence: [newRiffSeqEntry(id, 16)], repeatCount: reps,
    ...(occurrences ? { occurrences } : {}),
  };
}

function layer(nodes: RiffNode[], items: RiffPatternItem[], extra: Partial<AnnotationLayer<'riff-patterns'>> = {}) {
  return { ...newRiffPatternLayer('Hi-hat pattern', '#38bdf8'), nodes, items, ...extra };
}

// Groove A on the &s. One play adds two hits (a fill); another drops one and
// adds one.
const A = node('A', [2, 6, 10, 14]);
const B = node('B', [0, 4, 8, 12]);
const FILL: RiffOccurrence = { index: 0, event: 'fill', added: [{ start: 2, end: 2.25 }, { start: 3, end: 3.25 }] };
const CHANGE: RiffOccurrence = { index: 0, event: 'variation', added: [{ start: 0, end: 0.25 }], missing: [{ start: 2.5 }] };

describe('riffGrooveLane', () => {
  const hat = layer([A], [item(0, A, 3), item(6, A, 1, [FILL]), item(8, A), item(10, A, 1, [CHANGE])], { drum: 'hat' });

  it('draws every repeat of every instance as a bar, on its drum', () => {
    const { model } = riffGrooveLane(hat, GRID);
    expect(model.rows).toEqual(['hat']);
    expect(model.bars.map((b) => [b.bar, b.start, b.end])).toEqual([
      [1, 0, 2], [2, 2, 4], [3, 4, 6], [4, 6, 8], [5, 8, 10], [6, 10, 12],
    ]);
  });

  it('reads a node and the plays that changed it as one run of the node', () => {
    const { model } = riffGrooveLane(hat, GRID);
    expect(new Set(model.bars.map((b) => b.run)).size).toBe(1);
    expect(model.bars.map((b) => b.motif)).toEqual(['A', 'A', 'A', 'A', 'A', 'A']);
    expect(model.bars[0].runBars).toBe(6);
    // Which plays are exact repeats; a changed play is news every time.
    expect(model.bars.map((b) => b.repeat)).toEqual([false, true, true, false, false, false]);
  });

  it('draws an occurrence over its node: added hits ringed, dropped ones hollow', () => {
    const { model } = riffGrooveLane(hat, GRID);
    const fill = model.bars[3];
    expect(fill).toMatchObject({ event: 'fill', motif: 'A' });
    expect(fill.rows.hat.filter((s) => s.state === 'added').map((s) => s.step)).toEqual([8, 12]);
    const changed = model.bars[5];
    expect(changed.event).toBe('variation');
    expect(changed.rows.hat.filter((s) => s.state === 'missing').map((s) => s.step)).toEqual([10]);
    expect(changed.rows.hat.filter((s) => s.state === 'added').map((s) => s.step)).toEqual([0]);
    // The card finds the node by its name, and counts every play of it.
    expect(model.grooves.find((g) => g.motif === 'A')).toMatchObject({ bars: 6 });
  });

  it('says where each bar came from, so a click edits the right thing', () => {
    const { refs } = riffGrooveLane(hat, GRID);
    expect(refs[1]).toMatchObject({ rep: 1, entryIndex: 0, nodeId: A.id, inCombo: false, play: 1 });
    expect(refs[3]).toMatchObject({ nodeId: A.id, play: 0 });
  });

  it('draws a hand-drawn riff on one plain line, its notes held and named', () => {
    const bass = node('Bass A', [], {
      segments: [
        { start: 0, end: 1, kind: 'tick', note: 28 },
        { start: 1, end: 2, kind: 'empty' },
        { start: 2, end: 2.5, kind: 'tick', note: 31 },
      ],
    });
    const { model } = riffGrooveLane(layer([bass], [item(0, bass, 2)]), GRID);
    expect(model.rows).toEqual(['notes']);
    expect(model.bars[0].rows.notes).toEqual([
      { step: 0, state: 'played', length: 4, label: 'E1' },
      { step: 8, state: 'played', length: 2, label: 'G1' },
    ]);
  });

  it('draws a rest as a drop-out of its own', () => {
    const { model, refs } = riffGrooveLane(layer([A], [item(0, RIFF_NODE_SILENCE_ID)]), GRID);
    expect(model.bars[0]).toMatchObject({ motif: REST_MOTIF, event: 'drop' });
    expect(refs[0].nodeId).toBeNull();
  });

  it('marks a combo leaf, which no bar can change alone', () => {
    const combo = { id: 'c1', name: 'AB', color: '#fff', sequence: [newRiffSeqEntry(A.id, 16), newRiffSeqEntry(B.id, 16)] };
    const l = { ...layer([A, B], [{ ...item(0, 'c1'), end: 4, sequence: [newRiffSeqEntry('c1', 32)] }]), combos: [combo] };
    const { model, refs } = riffGrooveLane(l, GRID);
    expect(model.bars.map((b) => [b.start, b.end])).toEqual([[0, 2], [2, 4]]);
    expect(refs.map((r) => [r.nodeId, r.inCombo])).toEqual([[A.id, true], [B.id, true]]);
  });

  it('plays A A B A as one instance, and numbers every play of it', () => {
    const l = layer([A, B], [{
      ...newRiffPatternItem(0, 8, 'Verse'),
      sequence: [A, A, B, A].map((n) => newRiffSeqEntry(n.id, 16)),
      repeatCount: 2,
      occurrences: [{ index: 7, event: 'drop', missing: [{ start: 0.5 }, { start: 1.5 }, { start: 2.5 }, { start: 3.5 }] }],
    }]);
    const { model, refs } = riffGrooveLane(l, GRID);
    expect(model.bars.map((b) => b.motif)).toEqual(['A', 'A', 'B', 'A', 'A', 'A', 'B', 'A']);
    expect(refs.map((r) => r.play)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(model.bars[7].event).toBe('drop');
    expect(model.bars[7].rows.notes.every((s) => s.state === 'missing')).toBe(true);
  });

  it('stacks instances that overlap, and keeps a run to its own lane', () => {
    const { model, laneCount } = riffGrooveLane(layer([A], [item(0, A, 2), item(1, A)]), GRID);
    expect(laneCount).toBe(2);
    expect(model.bars.map((b) => b.lane)).toEqual([0, 1, 0]);
    expect(model.bars[0].runBars).toBe(2);
  });
});

describe('editing a bar from the card', () => {
  const hat = layer([A, B], [item(0, A, 3), item(6, B)]);

  it('toggles a step of the node, for every bar that plays it', () => {
    const added = toggleNodeStep(hat, A.id, 0);
    const steps = (l: AnnotationLayer<'riff-patterns'>, id: string) => (l.nodes ?? []).find((n) => n.id === id)!.segments!
      .filter((s) => s.kind === 'tick').map((s) => s.start * 4);
    expect(steps(added, A.id)).toEqual([0, 2, 6, 10, 14]);
    expect(steps(toggleNodeStep(added, A.id, 6), A.id)).toEqual([0, 2, 10, 14]);
  });

  it('records a step toggled on one bar as that play’s occurrence, leaving the node and the other bars alone', () => {
    const { refs } = riffGrooveLane(hat, GRID);
    const next = toggleBarStep(hat, refs[1], 0)!;
    expect(next.nodes).toBe(hat.nodes);
    const items = next.items as RiffPatternItem[];
    expect(items.map((it) => [it.start, it.repeatCount])).toEqual([[0, 3], [6, 1]]);
    expect(items[0].occurrences).toEqual([{ index: 1, event: 'fill', added: [{ start: 0, end: 0.25 }] }]);
    const { model } = riffGrooveLane(next, GRID);
    expect(model.bars.map((b) => [b.motif, b.event])).toEqual([['A', 'exact'], ['A', 'fill'], ['A', 'exact'], ['B', 'exact']]);
  });

  it('drops the occurrence when the bar is toggled back to its node', () => {
    const { refs } = riffGrooveLane(hat, GRID);
    const once = toggleBarStep(hat, refs[2], 6)!;
    expect((once.items as RiffPatternItem[])[0].occurrences).toEqual([{ index: 2, event: 'variation', missing: [{ start: 1.5 }] }]);
    const back = toggleBarStep(once, refs[2], 6)!;
    expect((back.items as RiffPatternItem[])[0].occurrences).toBeUndefined();
  });

  it('a click anywhere on a held note deletes the whole note, never splits it', () => {
    const held = node('H', [], { segments: [{ start: 1, end: 2, kind: 'tick' }] });
    const l = layer([held], [item(0, held, 2)]);
    const ticks = (x: AnnotationLayer<'riff-patterns'>) => x.nodes![0].segments!.filter((s) => s.kind === 'tick');
    for (const step of [4, 5, 7]) expect(ticks(toggleNodeStep(l, held.id, step))).toEqual([]);

    const { refs } = riffGrooveLane(l, GRID);
    const once = toggleBarStep(l, refs[1], 6)!;
    expect((once.items as RiffPatternItem[])[0].occurrences).toEqual([{ index: 1, event: 'drop', missing: [{ start: 1 }] }]);
    expect((toggleBarStep(once, refs[1], 5)!.items as RiffPatternItem[])[0].occurrences).toBeUndefined();
  });

  it('a click anywhere on a held note this bar added takes the addition back', () => {
    const { refs } = riffGrooveLane(hat, GRID);
    const items = hat.items as RiffPatternItem[];
    const withHeld = { ...hat, items: [{ ...items[0], occurrences: [{ index: 1, event: 'fill' as const, added: [{ start: 0, end: 0.5 }] }] }, items[1]] };
    expect((toggleBarStep(withHeld, refs[1], 1)!.items as RiffPatternItem[])[0].occurrences).toBeUndefined();
  });

  it('will not change a combo leaf or a rest alone', () => {
    const { refs } = riffGrooveLane(hat, GRID);
    expect(toggleBarStep(hat, { ...refs[0], inCombo: true }, 0)).toBeNull();
    expect(toggleBarStep(hat, { ...refs[0], nodeId: null }, 0)).toBeNull();
  });
});
