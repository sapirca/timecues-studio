import { describe, expect, it } from 'vitest';
import {
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  type AnnotationLayer,
  type RiffNode,
} from '../../types/annotationLayer';
import { detectorPalette, familyRuns, foldVariants, handPalette, laneSection, pitchSummary } from './paletteModel';

const BEAT = 60 / 88;

function layerWith(nodes: RiffNode[], placements: [RiffNode, number, number][]): AnnotationLayer<'riff-patterns'> {
  const layer = newRiffPatternLayer('Riff Patterns 2', '#22c55e');
  return {
    ...layer,
    nodes,
    items: placements.map(([node, start, reps]) => ({
      ...newRiffPatternItem(start, start + 8 * BEAT, node.name),
      sequence: [newRiffSeqEntry(node.id, 32)],
      repeatCount: reps,
    })),
  };
}

// El Jaguar's hand layer: a 2-bar drum figure ×10 and a 2-bar bass riff ×6.
const drums: RiffNode = { ...newRiffNode('Drums', '#2dd4bf'), stepsPerCycle: 32, subbeatsPerBeat: 4,
  segments: [{ start: 0, end: 0.5, kind: 'tick' }, { start: 0.5, end: 8, kind: 'empty' }] };
const bass: RiffNode = { ...newRiffNode('Bass riff', '#f97316'), stepsPerCycle: 32, subbeatsPerBeat: 4,
  segments: [
    { start: 0, end: 2.5, kind: 'tick', label: 'C1', note: 24 },
    { start: 2.5, end: 3.5, kind: 'tick', label: 'C2', note: 36 },
    { start: 3.5, end: 5.5, kind: 'tick', label: 'B♭1', note: 34 },
    { start: 5.5, end: 7, kind: 'tick', label: 'A1', note: 33 },
    { start: 7, end: 8, kind: 'tick', label: 'E♭2', note: 39 },
  ] };

describe('handPalette', () => {
  it('lists every node once, with where it plays', () => {
    const [group] = handPalette([layerWith([bass, drums], [[drums, 32.75, 10], [bass, 54.57, 6]])], 88);
    expect(group.figures.map((f) => f.name)).toEqual(['Drums', 'Bass riff']);
    const [d] = group.figures;
    expect(d.lengthBeats).toBe(8);
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0].reps).toBe(10);
    expect(d.runs[0].end).toBeCloseTo(32.75 + 10 * 8 * BEAT, 6);
    expect(d.variants).toEqual([]);
  });

  it('says what notes a pitched node plays', () => {
    const [group] = handPalette([layerWith([bass], [[bass, 54.57, 6]])], 88);
    expect(group.figures[0].pitch).toBe('C1–D#2 · 5 notes');
  });

  it('keeps an unplaced node, with no runs', () => {
    const [group] = handPalette([layerWith([drums], [])], 88);
    expect(group.figures[0].runs).toEqual([]);
  });

  it('places a node inside a longer sequence at its own slot', () => {
    const layer = layerWith([drums, bass], []);
    // Drums then bass, 8 beats each: one 16-beat turn, played twice.
    layer.items = [{ ...newRiffPatternItem(10, 10 + 16 * BEAT), sequence: [newRiffSeqEntry(drums.id, 32), newRiffSeqEntry(bass.id, 32)], repeatCount: 2 }];
    const figs = handPalette([layer], 88)[0].figures;
    const b = figs.find((f) => f.name === 'Bass riff')!;
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0].reps).toBe(2);
    expect(b.runs[0].firstTurn.start).toBeCloseTo(10 + 8 * BEAT, 6);
    expect(b.runs[0].firstTurn.end).toBeCloseTo(10 + 16 * BEAT, 6);
    expect(b.runs[0].end).toBeCloseTo(10 + 32 * BEAT, 6);
  });

  it('drops a layer with no nodes', () => {
    expect(handPalette([layerWith([], [])], 88)).toEqual([]);
  });
});

describe('pitchSummary', () => {
  it('is null for a figure with no pitches', () => {
    expect(pitchSummary(drums.segments ?? [])).toBeNull();
  });
  it('names a single pitch as "only"', () => {
    expect(pitchSummary([{ start: 0, end: 1, kind: 'tick', note: 24 }])).toBe('C1 only');
  });
});

describe('foldVariants', () => {
  it('folds a letter\'s other lengths under it, and leaves B alone', () => {
    const fig = (name: string) => ({ id: name, name, color: '#fff', lengthBeats: 4, strip: { kind: 'blocks' as const, segments: [], lengthBeats: 4 }, runs: [], variants: [] });
    const out = foldVariants([fig('A · 8 beats'), fig('B'), fig('A'), fig('A · 16 beats')]);
    expect(out.map((f) => [f.name, f.variants.map((v) => v.name)])).toEqual([
      ['A', ['A · 16 beats', 'A · 8 beats']],
      ['B', []],
    ]);
  });
});

describe('detectorPalette', () => {
  // A detector's kick lane: A (four on the floor) twice, then A at 8 beats.
  const a = { ...newRiffNode('A', '#2dd4bf', 4), id: 'a', segments: [0, 1, 2, 3].map((b) => ({ start: b, end: b + 0.25, kind: 'tick' as const })) };
  const a8 = { ...newRiffNode('A · 8 beats', '#2dd4bf', 8), id: 'a8' };
  const lane: AnnotationLayer<'riff-patterns'> = {
    ...newRiffPatternLayer('Kick grooves', '#2dd4bf'),
    id: 'detector-riff:drum_transients~grooves_kick',
    nodes: [a, a8],
    items: [
      { ...newRiffPatternItem(10, 10 + 4 * BEAT, 'A'), sequence: [newRiffSeqEntry('a', 16)], repeatCount: 2 },
      { ...newRiffPatternItem(100, 100 + 8 * BEAT, 'A · 8 beats'), sequence: [newRiffSeqEntry('a8', 32)], repeatCount: 1 },
    ],
  };

  it('folds a letter\'s other lengths under it and places each at its runs', () => {
    const [group] = detectorPalette([lane], 88);
    expect(group.section).toBe('kit');
    expect(group.figures).toHaveLength(1);
    const [fig] = group.figures;
    expect(fig.name).toBe('A');
    expect(fig.runs.map((r) => [r.start, r.reps])).toEqual([[10, 2]]);
    expect(fig.variants.map((v) => v.name)).toEqual(['A · 8 beats']);
    expect(fig.variants[0].runs[0].start).toBe(100);
  });

  it('shows the whole letter on the figure\'s row, other lengths marked', () => {
    const [fig] = detectorPalette([lane], 88)[0].figures;
    expect(familyRuns(fig).map((r) => [r.start, r.variant])).toEqual([[10, undefined], [100, '8 beats']]);
  });
});

describe('laneSection', () => {
  it('keeps the whole kit, single drums and pitched parts apart', () => {
    expect(laneSection('detector-riff:drum_transients~grooves_kick')).toBe('kit');
    expect(laneSection('detector-riff:instrument_layers~kick_pattern')).toBe('drum');
    expect(laneSection('detector-riff:instrument_layers~hat1_pattern')).toBe('drum');
    expect(laneSection('detector-riff:pitched_layers~bass_pattern')).toBe('pitched');
  });
});
