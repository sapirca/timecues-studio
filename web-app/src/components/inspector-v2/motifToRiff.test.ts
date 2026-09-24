/** Copying a LoCoMotif overlay has to preserve the one thing a motif detector
 *  knows that a span layer cannot express: which occurrences are the SAME
 *  figure. That fact lives in the node/instance split, so these pin the
 *  grouping, the lengths, and the refusal to guess without a beat grid. */

import { describe, expect, it } from 'vitest';
import { riffLayerFromMotifs, type MotifSection } from './motifToRiff';
import {
  PATTERN_SUBBEATS_PER_BEAT,
  riffNodeLengthBeats,
  type RiffNode,
  type RiffPatternItem,
} from '../../types/annotationLayer';

const BPM = 120;                       // 2 beats/sec — 1 beat = 0.5 s
const OPTS = { name: 'LoCoMotif', layerColor: '#10b981', importedFrom: 'locomotif' };

function sec(time: number, endTime: number, type: string, label = ''): MotifSection {
  return { time, endTime, type, label };
}

/** Two motifs: motif-0 occurs twice (2 s = 4 beats each), motif-1 once. */
const SECTIONS: MotifSection[] = [
  sec(0, 2, 'motif-0'),
  sec(10, 12, 'motif-0'),
  sec(20, 23, 'motif-1'),
];

describe('riffLayerFromMotifs', () => {
  it('makes one node per motif and one instance per occurrence', () => {
    const layer = riffLayerFromMotifs(SECTIONS, BPM, OPTS)!;
    expect(layer).not.toBeNull();
    expect(layer.type).toBe('riff-patterns');

    const nodes = layer.nodes as RiffNode[];
    const items = layer.items as RiffPatternItem[];
    expect(nodes.map((n) => n.name)).toEqual(['Motif 0', 'Motif 1']);
    expect(items).toHaveLength(3);

    // Both motif-0 occurrences point at the SAME node — the whole point.
    const motif0 = nodes.find((n) => n.name === 'Motif 0')!;
    const pointingAt0 = items.filter((it) => it.sequence[0].type === motif0.id);
    expect(pointingAt0).toHaveLength(2);
    expect(pointingAt0.map((it) => it.start)).toEqual([0, 10]);
  });

  it('gives each node a boundary body, not an empty chip grid', () => {
    const layer = riffLayerFromMotifs(SECTIONS, BPM, OPTS)!;
    const node = (layer.nodes as RiffNode[])[0];
    expect(node.kind).toBe('boundary');
    // One sounding block covering the node — the model claimed no rests.
    expect(node.segments).toHaveLength(1);
    expect(node.segments![0].kind).toBe('tick');
    expect(node.segments![0].start).toBeCloseTo(0, 6);
    expect(node.segments![0].end).toBeCloseTo(riffNodeLengthBeats(node), 6);
  });

  it("takes the node's natural length from the median occurrence, not the first", () => {
    // 2 s, 6 s, 4 s at 120bpm ⇒ 4, 12, 8 beats. Median is 8, not the first (4).
    const warped = [
      sec(0, 2, 'motif-0'),
      sec(10, 16, 'motif-0'),
      sec(20, 24, 'motif-0'),
    ];
    const layer = riffLayerFromMotifs(warped, BPM, OPTS)!;
    expect(riffNodeLengthBeats((layer.nodes as RiffNode[])[0])).toBeCloseTo(8, 6);
  });

  it('keeps each occurrence at its own length in its sequence entry', () => {
    const warped = [sec(0, 2, 'motif-0'), sec(10, 16, 'motif-0')];
    const items = riffLayerFromMotifs(warped, BPM, OPTS)!.items as RiffPatternItem[];
    // 4 beats and 12 beats, in sub-beat steps.
    expect(items[0].sequence[0].lengthSteps).toBe(4 * PATTERN_SUBBEATS_PER_BEAT);
    expect(items[1].sequence[0].lengthSteps).toBe(12 * PATTERN_SUBBEATS_PER_BEAT);
  });

  it('derives each instance end from its sequence rather than the raw detector end', () => {
    // 2.01 s is not a whole number of sub-beats; end must land on the grid.
    const layer = riffLayerFromMotifs([sec(0, 2.01, 'motif-0')], BPM, OPTS)!;
    const item = (layer.items as RiffPatternItem[])[0];
    const secPerStep = (60 / BPM) / PATTERN_SUBBEATS_PER_BEAT;
    expect(item.end).toBeCloseTo(item.start + item.sequence[0].lengthSteps * secPerStep, 6);
  });

  it('sorts instances by start time across motifs', () => {
    const interleaved = [sec(30, 32, 'motif-1'), sec(0, 2, 'motif-0'), sec(15, 17, 'motif-1')];
    const items = riffLayerFromMotifs(interleaved, BPM, OPTS)!.items as RiffPatternItem[];
    expect(items.map((it) => it.start)).toEqual([0, 15, 30]);
  });

  it('returns null without a BPM — a riff node has no length without a beat', () => {
    expect(riffLayerFromMotifs(SECTIONS, undefined, OPTS)).toBeNull();
    expect(riffLayerFromMotifs(SECTIONS, 0, OPTS)).toBeNull();
  });

  it('drops zero-width occurrences and returns null when nothing survives', () => {
    expect(riffLayerFromMotifs([sec(5, 5, 'motif-0')], BPM, OPTS)).toBeNull();
    const mixed = riffLayerFromMotifs([sec(5, 5, 'motif-0'), sec(0, 2, 'motif-0')], BPM, OPTS)!;
    expect(mixed.items).toHaveLength(1);
  });

  it('marks the layer as the user\'s own, tagged with the detector it came from', () => {
    const layer = riffLayerFromMotifs(SECTIONS, BPM, OPTS)!;
    expect(layer.source).toBe('user');
    expect(layer.importedFrom).toBe('locomotif');
    expect(layer.readOnly).toBeUndefined();
  });
});
