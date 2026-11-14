import { describe, expect, it } from 'vitest';

import type { AnnotationLayer, SpanItem } from '../../types/annotationLayer';
import { labelInPart, partLaneBaseId, splitLaneByPart } from './detectorLayers';

const STEM_PARTS = { drums: ['Kick', 'Snare', 'Hat'], bass: ['Bass'], other: ['Other'] };

function span(i: number, label: string, color?: string): SpanItem {
  return { id: `pulse:${i}:${i * 1000}`, start: i, end: i + 1, label, ...(color ? { color } : {}) };
}

function lane(items: SpanItem[]): AnnotationLayer<'spans'> {
  return {
    id: 'detector-span:pulse', name: 'Pulse (mix)', type: 'spans', visible: true,
    color: '#abcdef', snap: 'beat', items, readOnly: true, source: 'detector:pulse',
  };
}

describe('labelInPart', () => {
  it('matches the part name, or the name followed by " · "', () => {
    expect(labelInPart('Kick', 'Kick')).toBe(true);
    expect(labelInPart('Kick · Beat · 8 bars', 'Kick')).toBe(true);
    expect(labelInPart('Kicker · Beat', 'Kick')).toBe(false);
    expect(labelInPart(null, 'Kick')).toBe(false);
  });
});

describe('splitLaneByPart', () => {
  it('gives each dense part a lane and puts the sparse ones in one lane', () => {
    const items = [
      span(0, 'Hat · 1/2 beat', '#hat'), span(1, 'Kick · Beat', '#kick'), span(2, 'Kick · Beat', '#kick'),
      span(3, 'Hat · 1/2 beat', '#hat'), span(4, 'Kick · Beat', '#kick'), span(5, 'Hat · 1/4 beat', '#hat'),
      span(6, 'Bass · Beat'), span(7, 'Other · Bar'),
    ];
    const out = splitLaneByPart(lane(items), STEM_PARTS);
    expect(out.map((l) => l.id)).toEqual([
      'detector-span:pulse~kick', 'detector-span:pulse~hat', 'detector-span:pulse~bass+other',
    ]);
    expect(out.map((l) => l.name)).toEqual(['Kick', 'Hat', 'Bass · Other']);
    expect(out.map((l) => l.color)).toEqual(['#kick', '#hat', '#abcdef']);
    expect(out[2].items.map((it) => it.label)).toEqual(['Bass · Beat', 'Other · Bar']);
    expect(out.every((l) => l.source === 'detector:pulse')).toBe(true);
    expect(out.map((l) => partLaneBaseId(l.id))).toEqual(Array(3).fill('detector-span:pulse'));
  });

  it('leaves the lane whole when splitting would give one lane', () => {
    const one = lane([span(0, 'Kick · Beat'), span(1, 'Kick · Beat'), span(2, 'Kick · Beat')]);
    expect(splitLaneByPart(one, STEM_PARTS)).toEqual([one]);
    const sparse = lane([span(0, 'Kick · Beat'), span(1, 'Snare · Beat')]);
    expect(splitLaneByPart(sparse, STEM_PARTS)).toEqual([sparse]);
    const noParts = lane([span(0, 'x'), span(1, 'y')]);
    expect(splitLaneByPart(noParts, null)).toEqual([noParts]);
  });

  it('keeps an unmatched label in the shared lane rather than dropping it', () => {
    const items = [0, 1, 2].map((i) => span(i, 'Kick · Beat')).concat(span(3, 'Mystery'));
    const out = splitLaneByPart(lane(items), STEM_PARTS);
    expect(out.map((l) => l.name)).toEqual(['Kick', 'Rest']);
  });
});

// ─── A `lanes` detector ──────────────────────────────────────────────────────

import type { CustomRegistryEntry, CustomResultEnvelope } from '../../types/customScript';
import { RIFF_NODE_COLORS } from '../../types/annotationLayer';
import { rawDetectorItem } from './shared/detectorRaw';
import {
  asDetectorLane, detectorCueLayer, detectorItemCount, detectorRiffLayer, expandDetectorLanes,
  laneDetectorName,
} from './detectorLayers';

const LANES_DET = {
  name: 'instrument_layers', label: 'Instrument layers', output_kind: 'lanes', status: 'ok',
  stem: 'stems', group: null, description: 'Each instrument as its own layer',
} as unknown as CustomRegistryEntry;

/** Kick A, four on the floor, played twice; the second play drops the last kick.
 *  The detector set no colour on A and its own on B. */
const KICK_NODES = [
  { id: 'n-a', name: 'A', stepsPerCycle: 16, subbeatsPerBeat: 4, names: ['four on the floor'],
    segments: [0, 1, 2, 3].map((b) => ({ start: b, end: b + 0.25, kind: 'tick' as const, accent: 120 })) },
  { id: 'n-b', name: 'B', color: '#123456', stepsPerCycle: 16, subbeatsPerBeat: 4,
    segments: [{ start: 0, end: 4, kind: 'empty' as const }] },
];
const KICK_RIFF = {
  start: 0, end: 2, label: 'A', sequence: [{ type: 'n-a', lengthSteps: 16 }], repeatCount: 2,
  occurrences: [{ index: 1, event: 'variation' as const, missing: [{ start: 3 }] }],
};

const LANES_ENV = {
  name: 'instrument_layers', slug: 's', output_kind: 'lanes', ran_at: '', duration_ms: 4000,
  items: [], errors: [], stats: { accepted: 3, rejected: 0 }, fatal: null,
  lanes: [
    { id: 'kick_notes', label: 'Kick notes', output_kind: 'cue', group: 'Kick',
      items: [{ time_ms: 0, label: 'kick · A' }, { time_ms: 500, label: 'kick · A' }] },
    { id: 'kick_pattern', label: 'Kick pattern', output_kind: 'riff', group: 'Kick', items: [KICK_RIFF],
      nodes: KICK_NODES, combos: [], drum: 'kick', summary: '1 main loop over 2 bars.' },
  ],
} as unknown as CustomResultEnvelope;

describe('detectorRiffLayer', () => {
  const det = { name: 'kit', label: 'Kick pattern', stem: null, description: 'The kick', output_kind: 'riff' as const };
  const env = {
    name: 'kit', slug: 's', output_kind: 'riff', ran_at: '', duration_ms: 4000, errors: [],
    stats: { accepted: 1, rejected: 0 }, fatal: null,
    items: [KICK_RIFF], nodes: KICK_NODES, combos: [], drum: 'kick', summary: '1 main loop over 2 bars.',
  } as unknown as CustomResultEnvelope;

  it('is the run as a read-only Riff Patterns layer, the detector’s library and plays kept', () => {
    const layer = detectorRiffLayer(det, env, '#fff')!;
    expect(layer).toMatchObject({
      id: 'detector-riff:kit', type: 'riff-patterns', color: '#fff', readOnly: true, source: 'detector:kit',
      drum: 'kick', summary: '1 main loop over 2 bars.',
    });
    expect(layer.items.map((it) => it.id)).toEqual(['detector-riff:kit:0']);
    expect(layer.items[0]).toMatchObject({ start: 0, end: 2, repeatCount: 2, sequence: KICK_RIFF.sequence });
    expect(layer.items[0].occurrences).toEqual(KICK_RIFF.occurrences);
    expect(layer.nodes!.map((n) => n.id)).toEqual(['n-a', 'n-b']);
    expect(layer.nodes![0].segments).toEqual(KICK_NODES[0].segments);
    expect(layer.nodes![0].names).toEqual(['four on the floor']);
  });

  it('colours a node the detector left uncoloured, and keeps a colour it set', () => {
    const [a, b] = detectorRiffLayer(det, env, '#fff')!.nodes!;
    expect(a.color).toBe(RIFF_NODE_COLORS[0]);
    expect(b.color).toBe('#123456');
  });

  it('draws nothing for an empty or failed run, or another kind', () => {
    expect(detectorRiffLayer(det, { ...env, items: [] }, '#fff')).toBeNull();
    expect(detectorRiffLayer(det, { ...env, fatal: { code: 'x', message: 'boom' } } as never, '#fff')).toBeNull();
    expect(detectorRiffLayer({ ...det, output_kind: 'span' }, env, '#fff')).toBeNull();
    expect(detectorRiffLayer(det, null, '#fff')).toBeNull();
  });
});

describe('expandDetectorLanes', () => {
  it('turns each lane into the single-kind detector it would have been', () => {
    const { detectors, results } = expandDetectorLanes([LANES_DET], { instrument_layers: LANES_ENV });
    expect(detectors.map((d) => [d.name, d.output_kind, d.label, d.group])).toEqual([
      ['instrument_layers~kick_notes', 'cue', 'Kick notes', 'Kick'],
      ['instrument_layers~kick_pattern', 'riff', 'Kick pattern', 'Kick'],
    ]);
    expect(results['instrument_layers~kick_notes'].items).toHaveLength(2);
    expect(results['instrument_layers~kick_pattern'].output_kind).toBe('riff');
  });

  it('carries a riff lane\'s library onto its entry: nodes, combos, drum and summary', () => {
    const { results } = expandDetectorLanes([LANES_DET], { instrument_layers: LANES_ENV });
    const riff = results['instrument_layers~kick_pattern'];
    expect(riff.nodes).toEqual(KICK_NODES);
    expect(riff.combos).toEqual([]);
    expect(riff.drum).toBe('kick');
    expect(riff.summary).toBe('1 main loop over 2 bars.');
    expect(riff.items).toEqual([KICK_RIFF]);
  });

  it('leaves out lanes of a kind the caller does not draw', () => {
    const { detectors } = expandDetectorLanes([LANES_DET], { instrument_layers: LANES_ENV }, new Set(['cue'] as const));
    expect(detectors.map((d) => d.name)).toEqual(['instrument_layers~kick_notes']);
  });

  it('lets the existing builders draw the lanes, handed back to their detector', () => {
    const { detectors, results } = expandDetectorLanes([LANES_DET], { instrument_layers: LANES_ENV });
    const cues = asDetectorLane(detectorCueLayer(detectors[0], results[detectors[0].name], '#fff')!);
    expect(cues.id).toBe('detector-cue:instrument_layers~kick_notes');
    expect(cues.name).toBe('Kick notes');
    expect(cues.source).toBe('detector:instrument_layers');
    const riff = asDetectorLane(detectorRiffLayer(detectors[1], results[detectors[1].name], '#fff')!);
    expect(riff.id).toBe('detector-riff:instrument_layers~kick_pattern');
    expect(riff.name).toBe('Kick pattern');
    expect(riff.source).toBe('detector:instrument_layers');
    expect(riff.drum).toBe('kick');
    expect(riff.items[0].occurrences).toEqual(KICK_RIFF.occurrences);
  });

  it('finds each lane item behind its id, and counts the items in the lanes', () => {
    const { detectors, results } = expandDetectorLanes([LANES_DET], { instrument_layers: LANES_ENV });
    const cues = asDetectorLane(detectorCueLayer(detectors[0], results[detectors[0].name], '#fff')!);
    expect(rawDetectorItem(cues.source, cues.items[1].id, { instrument_layers: LANES_ENV }))
      .toEqual({ time_ms: 500, label: 'kick · A' });
    expect(detectorItemCount(LANES_ENV)).toBe(3);
    expect(laneDetectorName('instrument_layers~kick_notes')).toBe('instrument_layers');
    expect(laneDetectorName('pulse')).toBe('pulse');
  });
});

describe('expandDetectorLanes on a result saved before the detector had lanes', () => {
  it('shows it as the detector\'s one lane until a run replaces it', () => {
    const old = { ...LANES_ENV, output_kind: 'cue', lanes: undefined,
      items: [{ time_ms: 0, label: 'kick' }] } as unknown as CustomResultEnvelope;
    const { detectors, results } = expandDetectorLanes([LANES_DET], { instrument_layers: old });
    expect(detectors.map((d) => [d.name, d.output_kind, d.label])).toEqual([
      ['instrument_layers~saved', 'cue', 'Instrument layers']]);
    expect(results['instrument_layers~saved'].items).toHaveLength(1);
  });
});
