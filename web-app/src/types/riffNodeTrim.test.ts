import { describe, expect, it } from 'vitest';
import {
  PATTERN_SUBBEATS_PER_BEAT,
  newRiffBoundaryNode,
  newRiffCombo,
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  normalizeBoundarySegments,
  riffNodeLengthBeats,
  trimRiffNodeLength,
  type AnnotationLayer,
  type RiffBoundarySegment,
  type RiffNode,
  type RiffPatternItem,
} from './annotationLayer';

/** A 4-beat boundary node with a hit on every whole beat — 16 beats' worth of
 *  rhythm to cut back to, and enough blocks that a trim is visible. */
function boundaryNode(lengthBeats: number, tickAt: number[]): RiffNode {
  const node = newRiffBoundaryNode('B', '#f97316', lengthBeats);
  const segments: RiffBoundarySegment[] = tickAt.map((b) => ({ start: b, end: b + 0.5, kind: 'tick' }));
  return { ...node, segments: normalizeBoundarySegments(segments, lengthBeats) };
}

function layerWith(node: RiffNode, ...items: RiffPatternItem[]): AnnotationLayer<'riff-patterns'> {
  return { ...newRiffPatternLayer('Riffs', '#22c55e'), nodes: [node], items };
}

/** A placement of `node` `beats` long, in the sequence's own 4-steps-per-beat grid. */
function placement(nodeId: string, beats: number): RiffPatternItem {
  return {
    ...newRiffPatternItem(0, beats * 0.5, 'Instance 1'),
    sequence: [newRiffSeqEntry(nodeId, beats * PATTERN_SUBBEATS_PER_BEAT)],
  };
}

const ticksOf = (node: RiffNode) => (node.segments ?? []).filter((s) => s.kind === 'tick');

describe('trimRiffNodeLength', () => {
  it('drops a boundary node’s blocks past the new end and leaves the rest where they were', () => {
    const node = boundaryNode(16, [0, 2, 4, 6, 8, 10, 12, 14]);
    const next = trimRiffNodeLength(layerWith(node), node.id, 10);
    const trimmed = next.nodes![0];

    expect(riffNodeLengthBeats(trimmed)).toBe(10);
    // The four hits at 10, 12, 14 and beyond are gone; nothing that survived moved.
    expect(ticksOf(trimmed).map((s) => s.start)).toEqual([0, 2, 4, 6, 8]);
    expect(ticksOf(trimmed).map((s) => s.end)).toEqual([0.5, 2.5, 4.5, 6.5, 8.5]);
  });

  it('shrinks every placement by the same ratio, so the surviving blocks keep their scale', () => {
    const node = boundaryNode(16, [0, 4, 8, 12]);
    const layer = layerWith(node, placement(node.id, 16), placement(node.id, 16));
    const next = trimRiffNodeLength(layer, node.id, 8);

    // Half the node, half the slot: one block is drawn exactly as wide as before.
    for (const item of next.items as RiffPatternItem[]) {
      expect(item.sequence[0].lengthSteps).toBe(8 * PATTERN_SUBBEATS_PER_BEAT);
    }
  });

  it('keeps a stretched placement stretched by the same factor', () => {
    const node = boundaryNode(16, [0, 8]);
    // Deliberately drag-stretched to 2× the node's natural length.
    const layer = layerWith(node, placement(node.id, 32));
    const next = trimRiffNodeLength(layer, node.id, 8);

    expect((next.items as RiffPatternItem[])[0].sequence[0].lengthSteps).toBe(16 * PATTERN_SUBBEATS_PER_BEAT);
  });

  it('carries combo children along too, and leaves other nodes’ entries alone', () => {
    const node = boundaryNode(16, [0]);
    const other = newRiffNode('other', '#38bdf8');
    const combo = {
      ...newRiffCombo('C', '#a78bfa'),
      sequence: [newRiffSeqEntry(node.id, 64), newRiffSeqEntry(other.id, 16)],
    };
    const layer = { ...layerWith(node), nodes: [node, other], combos: [combo] };
    const next = trimRiffNodeLength(layer, node.id, 4);

    expect(next.combos![0].sequence[0].lengthSteps).toBe(16);
    expect(next.combos![0].sequence[1].lengthSteps).toBe(16);
    expect(next.nodes!.find((n) => n.id === other.id)).toEqual(other);
  });

  it('trims a grid node’s ticks the same way', () => {
    const node: RiffNode = { ...newRiffNode('G', '#38bdf8'), highlightedBeats: [0, 4, 8, 12] };
    const next = trimRiffNodeLength(layerWith(node, placement(node.id, 4)), node.id, 2);

    expect(next.nodes![0].stepsPerCycle).toBe(8);
    expect(next.nodes![0].highlightedBeats).toEqual([0, 4]);
    expect((next.items as RiffPatternItem[])[0].sequence[0].lengthSteps).toBe(8);
  });

  it('extends as well as trims, and is a no-op for an unknown node', () => {
    const node = boundaryNode(4, [0]);
    const layer = layerWith(node, placement(node.id, 4));

    const grown = trimRiffNodeLength(layer, node.id, 8);
    expect(riffNodeLengthBeats(grown.nodes![0])).toBe(8);
    expect((grown.items as RiffPatternItem[])[0].sequence[0].lengthSteps).toBe(32);
    // The new room arrives as an explicit rest, not as a stretched hit.
    expect(ticksOf(grown.nodes![0]).map((s) => s.end)).toEqual([0.5]);

    expect(trimRiffNodeLength(layer, 'nope', 2).items).toBe(layer.items);
  });
});
