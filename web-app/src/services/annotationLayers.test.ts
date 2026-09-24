import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadLayers,
  saveLayers,
  addLayer,
  removeLayer,
  updateLayer,
  reorderLayers,
} from './annotationLayers';
import {
  emptyDocument,
  newCueLayer,
  newSpanLayer,
  newCueItem,
  newSpanItem,
  type AnnotationLayer,
  type AnnotationLayersDocument,
  type CueItem,
} from '../types/annotationLayer';
import {
  normalizePatternAccents, resizeRiffNodeLength, resizeRiffNodeSubdivision,
  normalizeStepAccents, accentOpacity,
  flattenRiffEntry, findFirstRiffNodeOccurrence, RIFF_NODE_SILENCE_ID,
  nodeEntryLengthSteps, defaultRiffEntryLength,
  type RiffNode, type RiffCombo, type RiffPatternItem,
} from '../types/annotationLayer';

// ─── Fixtures: a document with one of every supported layer type ────────────

function buildDocWithEveryLayerType(): AnnotationLayersDocument {
  const cueLayer = newCueLayer('Kick hits', '#34d399');
  cueLayer.items = [
    newCueItem(1.5, 'kick', 'first downbeat'),
    newCueItem(2.0, 'snare'),
  ];

  const spanLayer = newSpanLayer('Vocal regions', '#60a5fa');
  spanLayer.items = [newSpanItem(10.0, 25.5, 'verse 1')];

  return {
    song: 'test-song',
    annotated_at: '2026-05-26T12:00:00.000Z',
    layers: [cueLayer, spanLayer],
    statusByType: { cues: 'in_progress', spans: 'reviewed' },
  };
}

// ─── fetch mock helpers ─────────────────────────────────────────────────────

const originalFetch = global.fetch;

function mockFetchOnce(
  response: { ok: boolean; status?: number; body?: unknown },
): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as typeof global.fetch;
  return { calls };
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Pure-function helpers: no fetch, just doc mutation ─────────────────────

describe('annotation-layers immutable helpers', () => {
  it('addLayer appends without mutating the original', () => {
    const doc = emptyDocument('s');
    const layer = newCueLayer('L', '#000');
    const next = addLayer(doc, layer);
    expect(next).not.toBe(doc);
    expect(next.layers).toHaveLength(1);
    expect(doc.layers).toHaveLength(0);
  });

  it('removeLayer drops by id', () => {
    const a = newCueLayer('A', '#111');
    const b = newCueLayer('B', '#222');
    const doc = { ...emptyDocument('s'), layers: [a, b] };
    const next = removeLayer(doc, a.id);
    expect(next.layers).toEqual([b]);
  });

  it('updateLayer patches a single layer by id', () => {
    const a = newCueLayer('A', '#111');
    const doc = { ...emptyDocument('s'), layers: [a] };
    const next = updateLayer(doc, a.id, { name: 'A-renamed', visible: false });
    expect(next.layers[0].name).toBe('A-renamed');
    expect(next.layers[0].visible).toBe(false);
    // Original untouched.
    expect(a.name).toBe('A');
  });

  it('reorderLayers moves a layer to a new index', () => {
    const a = newCueLayer('A', '#111');
    const b = newCueLayer('B', '#222');
    const c = newCueLayer('C', '#333');
    const doc = { ...emptyDocument('s'), layers: [a, b, c] };
    const next = reorderLayers(doc, c.id, 0);
    expect(next.layers.map((l) => l.id)).toEqual([c.id, a.id, b.id]);
  });

  it('reorderLayers is a no-op for out-of-range index', () => {
    const a = newCueLayer('A', '#111');
    const doc = { ...emptyDocument('s'), layers: [a] };
    expect(reorderLayers(doc, a.id, 5)).toBe(doc);
    expect(reorderLayers(doc, 'unknown-id', 0)).toBe(doc);
  });
});

// ─── Roundtrip: build doc → JSON.stringify → JSON.parse → field-equal ────────
//
// This is the corruption guard: if a CueItem field is renamed (or a new
// required field is added without a migrator), the roundtrip fails.

describe('annotation-layers JSON roundtrip', () => {
  it('preserves all fields on every layer kind', () => {
    const doc = buildDocWithEveryLayerType();
    const json = JSON.stringify(doc);
    const back = JSON.parse(json) as AnnotationLayersDocument;
    expect(back).toEqual(doc);
  });

  it('preserves item id, time, label, description, importance on cues', () => {
    const layer = newCueLayer('L', '#000');
    const cue: CueItem = {
      ...newCueItem(3.14, 'pi', 'tau/2'),
      importance: 'optional',
      candidates: [3.10, 3.18],
    };
    layer.items = [cue];
    const doc = { ...emptyDocument('s'), layers: [layer] };
    const back = JSON.parse(JSON.stringify(doc)) as AnnotationLayersDocument;
    const restored = back.layers[0].items[0] as CueItem;
    expect(restored).toEqual(cue);
    expect(restored.candidates).toEqual([3.10, 3.18]);
    expect(restored.importance).toBe('optional');
  });

  it('preserves statusByType (partial keys preserved verbatim)', () => {
    const doc: AnnotationLayersDocument = {
      ...emptyDocument('s'),
      statusByType: { cues: 'reviewed', loops: 'in_progress' },
    };
    const back = JSON.parse(JSON.stringify(doc)) as AnnotationLayersDocument;
    expect(back.statusByType).toEqual({ cues: 'reviewed', loops: 'in_progress' });
  });
});

// ─── Migration: legacy riff-pattern sequences upgrade on load ───────────────
//
// Documents created before 2026-08-22 stored `combo.sequence` / `item.sequence`
// as bare RiffNode.id | RiffCombo.id strings with no notion of how long each
// occurrence lasts. loadLayers() must wrap each one in { type, lengthSteps },
// defaulting legacy entries to one bar (RIFF_DEFAULT_ENTRY_STEPS).

describe('annotation-layers legacy riff-sequence migration', () => {
  it('wraps legacy bare-id sequences in { type, lengthSteps } on load', async () => {
    const legacyDoc = {
      song: 'old-riff-song',
      annotated_at: '2026-08-01T00:00:00.000Z',
      layers: [
        {
          id: 'layer-1',
          name: 'riff layer',
          type: 'riff-patterns',
          visible: true,
          color: '#818cf8',
          snap: 'bar',
          nodes: [{ id: 'node-1', name: 'Node 1', color: '#f97316', highlightedBeats: [], spans: [], stepsPerCycle: 16 }],
          combos: [{ id: 'combo-1', name: 'Combo 1', color: '#818cf8', sequence: ['node-1', 'node-1'] }],
          items: [
            {
              id: 'item-1', start: 0, end: 2, label: 'verse riff',
              repeatCount: 1, sequence: ['node-1', 'combo-1'], // legacy bare ids
            },
          ],
        },
      ],
    };
    mockFetchOnce({ ok: true, body: legacyDoc });
    const doc = await loadLayers('old-riff-song');
    const layer = doc.layers[0] as AnnotationLayer<'riff-patterns'>;
    expect(layer.combos?.[0].sequence).toEqual([
      { type: 'node-1', lengthSteps: 16 },
      { type: 'node-1', lengthSteps: 16 },
    ]);
    expect(layer.items[0].sequence).toEqual([
      { type: 'node-1', lengthSteps: 16 },
      { type: 'combo-1', lengthSteps: 16 },
    ]);
    // Legacy node has no `subbeatsPerBeat` — migrated to the default (4).
    expect(layer.nodes?.[0].subbeatsPerBeat).toBe(4);
  });

  it('leaves already-migrated riff sequences and node subdivisions untouched', async () => {
    const modernDoc = {
      song: 's',
      annotated_at: 'now',
      layers: [
        {
          id: 'layer-1',
          name: 'riff layer',
          type: 'riff-patterns',
          visible: true,
          color: '#818cf8',
          snap: 'bar',
          nodes: [{ id: 'node-1', name: 'Node 1', color: '#f97316', highlightedBeats: [], spans: [], stepsPerCycle: 12, subbeatsPerBeat: 3 }],
          combos: [],
          items: [
            {
              id: 'item-1', start: 0, end: 2, label: 'verse riff',
              repeatCount: 1, sequence: [{ type: 'node-1', lengthSteps: 8 }],
            },
          ],
        },
      ],
    };
    mockFetchOnce({ ok: true, body: modernDoc });
    const doc = await loadLayers('s');
    const layer = doc.layers[0] as AnnotationLayer<'riff-patterns'>;
    expect(layer.items[0].sequence).toEqual([{ type: 'node-1', lengthSteps: 8 }]);
    // Already has a (non-default) subbeatsPerBeat — migration leaves it as-is.
    expect(layer.nodes?.[0].subbeatsPerBeat).toBe(3);
  });
});

// ─── HTTP error paths return a safe empty document, never throw ─────────────

describe('annotation-layers HTTP error handling', () => {
  it('returns an empty document on 404', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    const doc = await loadLayers('missing-slug');
    expect(doc.song).toBe('missing-slug');
    expect(doc.layers).toEqual([]);
  });

  it('returns an empty document when fetch throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof global.fetch;
    const doc = await loadLayers('any-slug');
    expect(doc.song).toBe('any-slug');
    expect(doc.layers).toEqual([]);
  });

  it('returns empty doc when response body is not an array of layers', async () => {
    mockFetchOnce({ ok: true, body: { layers: 'not-an-array' } });
    const doc = await loadLayers('weird-slug');
    expect(doc.layers).toEqual([]);
  });
});

// ─── saveLayers stamps a fresh timestamp and POSTs the full doc ─────────────

describe('annotation-layers saveLayers contract', () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it('replaces annotated_at with current time before sending', async () => {
    const { calls } = mockFetchOnce({ ok: true, body: {} });
    const doc: AnnotationLayersDocument = {
      ...buildDocWithEveryLayerType(),
      annotated_at: '2020-01-01T00:00:00.000Z',  // stale
    };
    const ok = await saveLayers('test-song', doc);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].init!.body as string) as AnnotationLayersDocument;
    expect(sent.annotated_at).not.toBe('2020-01-01T00:00:00.000Z');
    // Sanity: ISO format
    expect(sent.annotated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Original doc must NOT be mutated.
    expect(doc.annotated_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns false on HTTP failure', async () => {
    mockFetchOnce({ ok: false, status: 500 });
    const ok = await saveLayers('test-song', emptyDocument('test-song'));
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as typeof global.fetch;
    const ok = await saveLayers('test-song', emptyDocument('test-song'));
    expect(ok).toBe(false);
  });
});

describe('normalizePatternAccents', () => {
  it('keeps ticks and spans disjoint — spans win over overlapping ticks', () => {
    const r = normalizePatternAccents([2, 3, 8], [[2, 3]], 16);
    expect(r.spans).toEqual([[2, 3]]);
    expect(r.highlightedBeats).toEqual([8]); // 2 & 3 dropped (inside the span)
  });

  it('drops spans of length < 2 and out-of-range steps', () => {
    const r = normalizePatternAccents([20, -1, 4], [[5, 1]], 16);
    expect(r.spans).toEqual([]);
    expect(r.highlightedBeats).toEqual([4]); // 20 (≥steps) and -1 removed
  });

  it('drops later spans that overlap earlier ones', () => {
    const r = normalizePatternAccents([], [[2, 3], [3, 2]], 16);
    expect(r.spans).toEqual([[2, 3]]);
  });

});

describe('resizeRiffNodeLength', () => {
  it('divides a node into quarter-of-a-beat parts scaled to its own length', () => {
    expect(resizeRiffNodeLength({ highlightedBeats: [], spans: [], subbeatsPerBeat: 4 }, 1).stepsPerCycle).toBe(4); // 1 beat
    expect(resizeRiffNodeLength({ highlightedBeats: [], spans: [], subbeatsPerBeat: 4 }, 4).stepsPerCycle).toBe(16); // 1 bar (4 beats)
    expect(resizeRiffNodeLength({ highlightedBeats: [], spans: [], subbeatsPerBeat: 4 }, 0.5).stepsPerCycle).toBe(2); // half a beat
  });

  it('uses the node\'s own subbeatsPerBeat resolution, not the fixed default', () => {
    // A triplet-feel node (3 steps/beat) at 1 beat long → 3 steps, not 4.
    expect(resizeRiffNodeLength({ highlightedBeats: [], spans: [], subbeatsPerBeat: 3 }, 1).stepsPerCycle).toBe(3);
    expect(resizeRiffNodeLength({ highlightedBeats: [], spans: [], subbeatsPerBeat: 1 }, 4).stepsPerCycle).toBe(4);
  });

  it('clamps existing ticks/spans that fall outside a shrunk grid', () => {
    // 1 bar (16 steps) shrunk to 1 beat (4 steps) — tick at 8 and the span
    // starting at 10 no longer fit and must be dropped, not just left dangling.
    const r = resizeRiffNodeLength({ highlightedBeats: [1, 8], spans: [[10, 2]], subbeatsPerBeat: 4 }, 1);
    expect(r.stepsPerCycle).toBe(4);
    expect(r.highlightedBeats).toEqual([1]);
    expect(r.spans).toEqual([]);
  });
});

describe('resizeRiffNodeSubdivision', () => {
  it('rescales stepsPerCycle to preserve the node\'s length in beats', () => {
    // 1 bar at 4 steps/beat = 16 steps; switching to 3 steps/beat (triplet
    // feel) keeps the same 4-beat length but recomputes to 12 steps.
    const r = resizeRiffNodeSubdivision(
      { stepsPerCycle: 16, highlightedBeats: [], spans: [], subbeatsPerBeat: 4 }, 3,
    );
    expect(r.stepsPerCycle).toBe(12);
    expect(r.subbeatsPerBeat).toBe(3);
  });

  it('remaps existing ticks proportionally rather than discarding them', () => {
    // Halving resolution (4 -> 2 steps/beat) on a 1-bar (16-step) node halves
    // the grid to 8 steps; a tick at step 8 (beat 3) should land at step 4.
    const r = resizeRiffNodeSubdivision(
      { stepsPerCycle: 16, highlightedBeats: [8], spans: [], subbeatsPerBeat: 4 }, 2,
    );
    expect(r.stepsPerCycle).toBe(8);
    expect(r.highlightedBeats).toEqual([4]);
  });

  it('is a no-op when the requested resolution matches the current one', () => {
    const node = { stepsPerCycle: 16, highlightedBeats: [2, 9], spans: [[4, 2]] as [number, number][], subbeatsPerBeat: 4 };
    const r = resizeRiffNodeSubdivision(node, 4);
    expect(r).toEqual(node);
  });
});

describe('nodeEntryLengthSteps / defaultRiffEntryLength', () => {
  it('converts a node\'s own-resolution stepsPerCycle into the fixed sequence-grid unit', () => {
    // 16-beat triplet node (6 steps/beat) = 96 of its own steps, but only
    // 64 sequence-grid steps (16 beats * the fixed 4/beat) — NOT 96, which
    // is what a naive pass-through of stepsPerCycle would give and which
    // desyncs the rendered chip grid from real playback time.
    const tripletNode: RiffNode = {
      id: 'nT', name: 'Triplet', color: '#fff',
      highlightedBeats: [], spans: [], stepsPerCycle: 96, subbeatsPerBeat: 6,
    };
    expect(nodeEntryLengthSteps(tripletNode)).toBe(64);
    expect(defaultRiffEntryLength('nT', [tripletNode], [])).toBe(64);
  });

  it('is a no-op at the default 4-steps/beat resolution', () => {
    const node: RiffNode = {
      id: 'nQ', name: 'Quarters', color: '#fff',
      highlightedBeats: [], spans: [], stepsPerCycle: 16, subbeatsPerBeat: 4,
    };
    expect(nodeEntryLengthSteps(node)).toBe(16);
    expect(defaultRiffEntryLength('nQ', [node], [])).toBe(16);
  });

  it('sums already-converted child lengths for a combo, unaffected by its children\'s own resolutions', () => {
    const combo: RiffCombo = {
      id: 'cX', name: 'X', color: '#abc',
      sequence: [{ type: 'a', lengthSteps: 64 }, { type: 'b', lengthSteps: 32 }],
    };
    expect(defaultRiffEntryLength('cX', [], [combo])).toBe(96);
  });
});

describe('flattenRiffEntry', () => {
  const nodeA: RiffNode = { id: 'nA', name: 'A', color: '#fff', highlightedBeats: [], spans: [], stepsPerCycle: 4, subbeatsPerBeat: 4 };
  const nodeB: RiffNode = { id: 'nB', name: 'B', color: '#000', highlightedBeats: [], spans: [], stepsPerCycle: 8, subbeatsPerBeat: 4 };
  const comboC: RiffCombo = {
    id: 'cC', name: 'C', color: '#abc',
    sequence: [
      { type: 'nA', lengthSteps: 4 },
      { type: RIFF_NODE_SILENCE_ID, lengthSteps: 4 },
      { type: 'nB', lengthSteps: 8 },
    ],
  };

  it('resolves a plain node entry to a single full-fraction leaf', () => {
    expect(flattenRiffEntry({ type: 'nA', lengthSteps: 4 }, [nodeA], [])).toEqual([{ nodeId: 'nA', fraction: 1 }]);
  });

  it('resolves a silence entry to a single null-id leaf', () => {
    expect(flattenRiffEntry({ type: RIFF_NODE_SILENCE_ID, lengthSteps: 4 }, [], [])).toEqual([{ nodeId: null, fraction: 1 }]);
  });

  it('expands a combo entry into its constituent leaves, proportioned by their share of the combo total', () => {
    const leaves = flattenRiffEntry({ type: 'cC', lengthSteps: 8 }, [nodeA, nodeB], [comboC]);
    // combo total = 4 + 4 + 8 = 16 steps, regardless of the entry's own lengthSteps.
    expect(leaves).toEqual([
      { nodeId: 'nA', fraction: 0.25 },
      { nodeId: null, fraction: 0.25 },
      { nodeId: 'nB', fraction: 0.5 },
    ]);
  });
});

describe('findFirstRiffNodeOccurrence', () => {
  const nodeA: RiffNode = { id: 'nA', name: 'A', color: '#fff', highlightedBeats: [], spans: [], stepsPerCycle: 4, subbeatsPerBeat: 4 };
  const nodeB: RiffNode = { id: 'nB', name: 'B', color: '#000', highlightedBeats: [], spans: [], stepsPerCycle: 8, subbeatsPerBeat: 4 };
  const comboC: RiffCombo = {
    id: 'cC', name: 'C', color: '#abc',
    sequence: [
      { type: 'nA', lengthSteps: 4 },
      { type: RIFF_NODE_SILENCE_ID, lengthSteps: 4 },
      { type: 'nB', lengthSteps: 8 },
    ],
  };

  it('locates a node placed directly in a top-level sequence', () => {
    const item: RiffPatternItem = {
      id: 'i1', start: 10, end: 14, label: '', repeatCount: 1,
      sequence: [
        { type: 'nA', lengthSteps: 4 },
        { type: RIFF_NODE_SILENCE_ID, lengthSteps: 4 },
        { type: 'nB', lengthSteps: 8 },
      ],
    };
    const layer = { items: [item], nodes: [nodeA, nodeB], combos: [] };
    // bpm 120 → 0.125s/step (global 4 subbeats/beat); nB starts after nA(4) + silence(4) = 8 steps in.
    expect(findFirstRiffNodeOccurrence(layer, 'nB', 120)).toEqual({ start: 11, end: 12 });
    expect(findFirstRiffNodeOccurrence(layer, 'nA', 120)).toEqual({ start: 10, end: 10.5 });
  });

  it('locates a node nested inside a combo entry', () => {
    const item: RiffPatternItem = {
      id: 'i1', start: 0, end: 4, label: '', repeatCount: 1,
      sequence: [{ type: 'cC', lengthSteps: 16 }],
    };
    const layer = { items: [item], nodes: [nodeA, nodeB], combos: [comboC] };
    expect(findFirstRiffNodeOccurrence(layer, 'nB', 120)).toEqual({ start: 1, end: 2 });
  });

  it('returns null when the node is not placed anywhere in the layer', () => {
    const layer = { items: [], nodes: [nodeA, nodeB], combos: [] };
    expect(findFirstRiffNodeOccurrence(layer, 'nA', 120)).toBeNull();
  });
});

describe('step accents (per-step velocity)', () => {
  it('drops accents outside the grid and clamps the rest into 1..127', () => {
    const out = normalizeStepAccents({ 0: 120, 3: 200, 5: -4, 99: 60 }, 16);
    expect(out).toEqual({ 0: 120, 3: 127, 5: 1 });
  });

  it('returns undefined rather than an empty map', () => {
    expect(normalizeStepAccents(undefined, 16)).toBeUndefined();
    expect(normalizeStepAccents({}, 16)).toBeUndefined();
    expect(normalizeStepAccents({ 99: 100 }, 16)).toBeUndefined();
  });

  it('a step with no accent draws at full strength', () => {
    expect(accentOpacity(undefined)).toBe(1);
    expect(accentOpacity(127)).toBe(1);
  });

  it('keeps a ghost note clearly louder-looking than an empty chip', () => {
    // An empty chip draws at 0.2; the quietest struck step must beat that.
    expect(accentOpacity(1)).toBeGreaterThan(0.3);
    expect(accentOpacity(1)).toBeLessThan(accentOpacity(64));
    expect(accentOpacity(64)).toBeLessThan(accentOpacity(127));
  });

  it('trimming a node drops the accents of steps that are gone', () => {
    const node = {
      highlightedBeats: [0, 4, 8, 12], spans: [] as [number, number][],
      subbeatsPerBeat: 4, accents: { 0: 120, 4: 60, 8: 110, 12: 55 },
    };
    const out = resizeRiffNodeLength(node, 2);   // 2 beats -> 8 steps
    expect(out.stepsPerCycle).toBe(8);
    expect(out.accents).toEqual({ 0: 120, 4: 60 });
  });

  it('changing subdivision carries each accent to the step it moved to', () => {
    const node = {
      stepsPerCycle: 16, subbeatsPerBeat: 4,
      highlightedBeats: [0, 4, 8, 12], spans: [] as [number, number][],
      accents: { 0: 120, 4: 60, 8: 110, 12: 55 },
    };
    const out = resizeRiffNodeSubdivision(node, 2);  // 4 beats at 2/beat -> 8 steps
    expect(out.stepsPerCycle).toBe(8);
    expect(out.accents).toEqual({ 0: 120, 2: 60, 4: 110, 6: 55 });
  });

  it('when two steps collapse onto one, the louder survives', () => {
    const node = {
      stepsPerCycle: 16, subbeatsPerBeat: 4,
      highlightedBeats: [0, 1], spans: [] as [number, number][],
      accents: { 0: 40, 1: 119 },
    };
    const out = resizeRiffNodeSubdivision(node, 1);  // 4 beats at 1/beat -> 4 steps
    expect(out.accents?.[0]).toBe(119);
  });

  it('a node without accents stays without them', () => {
    const node = { highlightedBeats: [0], spans: [] as [number, number][], subbeatsPerBeat: 4 };
    expect(resizeRiffNodeLength(node, 4).accents).toBeUndefined();
  });
});
