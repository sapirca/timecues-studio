import { describe, it, expect } from 'vitest';
import {
  newRiffPatternLayer,
  type AnnotationLayer,
  type RiffPatternItem,
} from '../../types/annotationLayer';
import {
  createRiffDraft,
  editNotes,
  insertEntry,
  moveEntry,
  nextNodeName,
  nodeNotes,
  occurrenceFor,
  playedNotes,
  playsOfNode,
  removeEntry,
  replaceEntry,
  riffRuns,
  setRunCount,
  swapEntries,
  withNodeNotes,
  withoutEmptyUnusedNodes,
  withSequence,
  withoutRiffDraft,
} from './riffLaneEdit';

const BPM = 120;

function lane(): AnnotationLayer<'riff-patterns'> {
  return newRiffPatternLayer('Riffs', '#f59e0b');
}

/** A draft A, plus a node B, in a lane. */
function abLane() {
  const { layer, itemId, nodeId } = createRiffDraft(lane(), 10, 2, BPM);
  const b = createRiffDraft(layer, 30, 2, BPM);
  const bNode = b.nodeId;
  const layer2 = { ...b.layer, items: (b.layer.items as RiffPatternItem[]).filter((it) => it.id !== b.itemId) };
  return { layer: layer2, itemId, a: nodeId, b: bNode };
}

const itemOf = (layer: AnnotationLayer<'riff-patterns'>, id: string) =>
  (layer.items as RiffPatternItem[]).find((it) => it.id === id)!;

describe('nextNodeName', () => {
  it('takes the next letter no node has', () => {
    expect(nextNodeName([])).toBe('A');
    expect(nextNodeName([{ name: 'A' }, { name: 'C' }])).toBe('B');
  });
});

describe('createRiffDraft', () => {
  it('starts an instance where the drag began, playing one new empty node as long as the drag', () => {
    const { layer, itemId, nodeId } = createRiffDraft(lane(), 10, 2, BPM);
    const item = itemOf(layer, itemId);
    expect(item.start).toBe(10);
    expect(item.end).toBeCloseTo(11);
    expect(item.sequence).toEqual([{ type: nodeId, lengthSteps: 8 }]);
    expect(layer.nodes).toHaveLength(1);
    expect(layer.nodes![0]).toMatchObject({ name: 'A', stepsPerCycle: 8, subbeatsPerBeat: 4 });
    expect(nodeNotes(layer.nodes![0])).toEqual([]);
  });
});

describe('the sequence keeps every occurrence on its own play', () => {
  // A B A, with an occurrence on the second A (entry 2) of repeat 0 and of
  // repeat 1 (index 1×3 + 2 = 5).
  function aba() {
    const { layer, itemId, a, b } = abLane();
    let item = itemOf(layer, itemId);
    item = insertEntry(layer, item, 1, b);
    item = insertEntry(layer, item, 2, a);
    item = {
      ...item,
      repeatCount: 2,
      occurrences: [
        { index: 2, event: 'variation', missing: [{ start: 0 }] },
        { index: 5, event: 'drop', missing: [{ start: 0 }] },
      ],
    };
    return { layer, item, a, b };
  }

  it('inserting before a play moves its occurrence along', () => {
    const { layer, item, b } = aba();
    const next = insertEntry(layer, item, 0, b);
    expect(next.sequence).toHaveLength(4);
    expect(next.occurrences!.map((o) => o.index)).toEqual([3, 7]);
  });

  it('removing a play drops its occurrence and renumbers the rest', () => {
    const { item } = aba();
    expect(removeEntry(item, 2).occurrences).toBeUndefined();
    expect(removeEntry(item, 0).occurrences!.map((o) => o.index)).toEqual([1, 3]);
  });

  it('moving and swapping carry the occurrence with its entry', () => {
    const { item } = aba();
    expect(moveEntry(item, 2, 0).occurrences!.map((o) => o.index)).toEqual([0, 3]);
    expect(swapEntries(item, 0, 2).occurrences!.map((o) => o.index)).toEqual([0, 3]);
  });

  it('a slot swapped to another node is a new play, with no occurrence', () => {
    const { layer, item, b } = aba();
    expect(replaceEntry(layer, item, 2, b).occurrences).toBeUndefined();
  });

  it('a dangling occurrence never survives a rewrite', () => {
    const { item } = aba();
    const slots = item.sequence.map((e, i) => ({ ...e, from: i === 2 ? null : i }));
    expect(withSequence(item, slots).occurrences).toBeUndefined();
  });
});

describe('in a row', () => {
  it('A ×2 is A twice in the sequence; lowering it keeps the first', () => {
    const { layer, itemId, a, b } = abLane();
    let item = insertEntry(layer, itemOf(layer, itemId), 1, b);
    item = setRunCount(item, 0, 3);
    expect(riffRuns(item.sequence).map((r) => [r.type, r.count])).toEqual([[a, 3], [b, 1]]);
    item = setRunCount(item, 0, 1);
    expect(item.sequence.map((e) => e.type)).toEqual([a, b]);
  });

  it('counts every play of a node across the lane, repeats included', () => {
    const { layer, itemId, a } = abLane();
    const item = { ...setRunCount(itemOf(layer, itemId), 0, 2), repeatCount: 3 };
    const l = { ...layer, items: [item] };
    expect(playsOfNode(l, a)).toBe(6);
  });
});

describe('notes', () => {
  it('a press adds a one-step note, a press on it removes it, a drag holds one note', () => {
    let notes = editNotes([], 2, 2, 4, 2);
    expect(notes.map((n) => [n.start, n.end])).toEqual([[0.5, 0.75]]);
    notes = editNotes(notes, 2, 2, 4, 2);
    expect(notes).toEqual([]);
    notes = editNotes([], 4, 6, 4, 2);
    expect(notes.map((n) => [n.start, n.end])).toEqual([[1, 1.75]]);
  });

  it('a held note written over hits cuts them', () => {
    const hits = editNotes(editNotes([], 1, 1, 4, 2), 2, 2, 4, 2);
    const held = editNotes(hits, 0, 3, 4, 2);
    expect(held.map((n) => [n.start, n.end])).toEqual([[0, 1]]);
  });
});

describe('one play, played differently', () => {
  it('a left-out note is missing, a new one added, and the node stays as it is', () => {
    const { layer, a } = abLane();
    const node = withNodeNotes(layer.nodes!.find((n) => n.id === a)!, editNotes(editNotes([], 0, 0, 4, 2), 4, 4, 4, 2));
    const want = editNotes(editNotes(nodeNotes(node), 0, 0, 4, 2), 6, 6, 4, 2);
    const occ = occurrenceFor(node, 3, want)!;
    expect(occ).toMatchObject({ index: 3, event: 'variation', missing: [{ start: 0 }], added: [{ start: 1.5, end: 1.75 }] });
    expect(playedNotes(node, occ).map((n) => n.start)).toEqual([1, 1.5]);
    expect(nodeNotes(node).map((n) => n.start)).toEqual([0, 1]);
  });

  it('only adding is a fill, leaving every note out a drop, and the node itself no occurrence', () => {
    const { layer, a } = abLane();
    const node = withNodeNotes(layer.nodes!.find((n) => n.id === a)!, editNotes([], 0, 0, 4, 2));
    expect(occurrenceFor(node, 0, editNotes(nodeNotes(node), 4, 4, 4, 2))!.event).toBe('fill');
    expect(occurrenceFor(node, 0, [])!.event).toBe('drop');
    expect(occurrenceFor(node, 0, nodeNotes(node))).toBeNull();
  });
});

describe('withoutEmptyUnusedNodes', () => {
  it('drops a fresh node nothing plays, keeps one that has notes', () => {
    const { layer, itemId, a, b } = abLane();
    const swapped = { ...layer, items: [replaceEntry(layer, itemOf(layer, itemId), 0, b)] };
    expect(withoutEmptyUnusedNodes(swapped).nodes!.map((n) => n.id)).toEqual([b]);
    const withNotes = {
      ...swapped,
      nodes: swapped.nodes!.map((n) => (n.id === a ? withNodeNotes(n, editNotes([], 0, 0, 4, 2)) : n)),
    };
    expect(withoutEmptyUnusedNodes(withNotes).nodes!.map((n) => n.id)).toEqual([a, b]);
  });
});

describe('withoutRiffDraft', () => {
  it('takes the draft instance and the nodes made for it back out', () => {
    const base = lane();
    const doc = { song: 's', annotated_at: '', layers: [base] };
    const { layer, itemId, nodeId } = createRiffDraft(base, 10, 2, BPM);
    const withDraft = { ...doc, layers: [layer] };
    const back = withoutRiffDraft(withDraft, { layerId: base.id, itemId, nodeIds: [nodeId] });
    expect(back.layers[0].items).toEqual([]);
    expect((back.layers[0] as AnnotationLayer<'riff-patterns'>).nodes).toEqual([]);
    expect(withoutRiffDraft(doc, { layerId: base.id, itemId, nodeIds: [nodeId] })).toBe(doc);
  });
});

describe('withoutDanglingRiffInstances', () => {
  it('drops an instance whose node was deleted, and renumbers a survivor\'s plays', async () => {
    const { withoutDanglingRiffInstances } = await import('../../types/annotationLayer');
    const { layer, itemId, a, b } = abLane();
    const both = insertEntry(layer, itemOf(layer, itemId), 0, b); // B A
    const onlyA = { ...itemOf(layer, itemId), id: 'only-a' };
    const withOcc = { ...both, repeatCount: 2, occurrences: [{ index: 3, event: 'drop' as const, missing: [{ start: 0 }] }] };
    const lane2 = { ...layer, nodes: layer.nodes!.filter((n) => n.id !== a), items: [withOcc, onlyA] };
    const doc = { song: 's', annotated_at: '', layers: [lane2] };
    const out = withoutDanglingRiffInstances(doc);
    const items = out.layers[0].items as RiffPatternItem[];
    expect(items.map((it) => it.sequence.map((e) => e.type))).toEqual([[b]]);
    // play 3 was repeat 1, entry 1 (A) — gone with A.
    expect(items[0].occurrences).toBeUndefined();
    expect(withoutDanglingRiffInstances(out)).toBe(out);
  });
});
