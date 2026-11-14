import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadLayers,
  loadLayersForEdit,
  saveLayers,
  addLayer,
  removeLayer,
  updateLayer,
  reorderLayers,
  duplicateLayer,
} from './annotationLayers';
import {
  emptyDocument,
  newCueLayer,
  newSpanLayer,
  newCueItem,
  newSpanItem,
  type AnnotationLayersDocument,
  type CueItem,
} from '../types/annotationLayer';
import {
  accentOpacity,
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

  it('duplicateLayer inserts an independent copy right below the source', () => {
    const a = newCueLayer('Kicks', '#111');
    a.items = [newCueItem(1, 'kick')];
    a.groupId = 'g1';
    const b = newCueLayer('B', '#222');
    const doc = { ...emptyDocument('s'), layers: [a, b] };
    const next = duplicateLayer(doc, a.id, 'copy-id');
    expect(next.layers.map((l) => l.id)).toEqual([a.id, 'copy-id', b.id]);
    const copy = next.layers[1];
    expect(copy.name).toBe('Kicks copy');
    expect(copy.groupId).toBe('g1');
    expect(copy.items).toEqual(a.items);
    expect(copy.items).not.toBe(a.items);
    expect(copy.items[0]).not.toBe(a.items[0]);
  });

  it('duplicateLayer leaves read-only and unknown layers alone', () => {
    const a = { ...newCueLayer('Det', '#111'), readOnly: true };
    const doc = { ...emptyDocument('s'), layers: [a] };
    expect(duplicateLayer(doc, a.id)).toBe(doc);
    expect(duplicateLayer(doc, 'nope')).toBe(doc);
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
    const result = await saveLayers('test-song', doc);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].init!.body as string) as AnnotationLayersDocument;
    expect(sent.annotated_at).not.toBe('2020-01-01T00:00:00.000Z');
    // Sanity: ISO format
    expect(sent.annotated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Original doc must NOT be mutated.
    expect(doc.annotated_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('fails without a conflict on HTTP failure', async () => {
    mockFetchOnce({ ok: false, status: 500 });
    const result = await saveLayers('test-song', emptyDocument('test-song'));
    expect(result).toEqual({ ok: false, conflict: false });
  });

  it('fails without a conflict when fetch throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as typeof global.fetch;
    const result = await saveLayers('test-song', emptyDocument('test-song'));
    expect(result).toEqual({ ok: false, conflict: false });
  });
});

// ─── Every save names the revision it was edited from ──────────────────────
//
// 2026-10-19: a song's file went from a dozen layers to two in one save — a
// page holding an older copy wrote it whole over the newer one. The server
// already refused a save from a stale revision; the client never said which
// revision it had.

describe('annotation-layers saveLayers revision check', () => {
  const ifMatch = (init?: RequestInit) => (init?.headers as Record<string, string>)['If-Match'];

  it('sends the loaded document\'s rev as If-Match and returns the new rev', async () => {
    const { calls } = mockFetchOnce({ ok: true, body: { ok: true, rev: 8 } });
    const result = await saveLayers('s', { ...emptyDocument('s'), rev: 7 });
    expect(ifMatch(calls[0].init)).toBe('7');
    expect(result).toEqual({ ok: true, rev: 8 });
  });

  it('prefers an explicit baseRev over the document\'s own rev', async () => {
    const { calls } = mockFetchOnce({ ok: true, body: { ok: true, rev: 13 } });
    await saveLayers('s', { ...emptyDocument('s'), rev: 3 }, { baseRev: 12 });
    expect(ifMatch(calls[0].init)).toBe('12');
  });

  it('names revision 0 for a document that never had a file', async () => {
    const { calls } = mockFetchOnce({ ok: true, body: { ok: true, rev: 1 } });
    await saveLayers('s', emptyDocument('s'));
    expect(ifMatch(calls[0].init)).toBe('0');
  });

  it('reports a stale-revision refusal as a conflict', async () => {
    mockFetchOnce({ ok: false, status: 409, body: { error: 'stale revision', rev: 46 } });
    const result = await saveLayers('s', { ...emptyDocument('s'), rev: 40 });
    expect(result).toEqual({ ok: false, conflict: true });
  });

  it('does not call a shared-song lock refusal a conflict', async () => {
    mockFetchOnce({ ok: false, status: 409, body: { reason: 'locked' } });
    const result = await saveLayers('s', emptyDocument('s'));
    expect(result).toEqual({ ok: false, conflict: false });
  });
});

describe('loadLayersForEdit', () => {
  it('returns an empty document only when the song has no file', async () => {
    mockFetchOnce({ ok: true, body: null });
    const doc = await loadLayersForEdit('new-song');
    expect(doc.layers).toEqual([]);
    expect(doc.rev).toBeUndefined();
  });

  it('keeps the file\'s rev', async () => {
    mockFetchOnce({ ok: true, body: { ...emptyDocument('s'), rev: 46 } });
    expect((await loadLayersForEdit('s')).rev).toBe(46);
  });

  it('throws on an HTTP error instead of showing the song empty', async () => {
    mockFetchOnce({ ok: false, status: 500 });
    await expect(loadLayersForEdit('s')).rejects.toThrow();
  });

  it('throws when the response is not a layers document', async () => {
    mockFetchOnce({ ok: true, body: { layers: 'not-an-array' } });
    await expect(loadLayersForEdit('s')).rejects.toThrow();
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
      segments: [], stepsPerCycle: 96, subbeatsPerBeat: 6,
    };
    expect(nodeEntryLengthSteps(tripletNode)).toBe(64);
    expect(defaultRiffEntryLength('nT', [tripletNode], [])).toBe(64);
  });

  it('is a no-op at the default 4-steps/beat resolution', () => {
    const node: RiffNode = {
      id: 'nQ', name: 'Quarters', color: '#fff',
      segments: [], stepsPerCycle: 16, subbeatsPerBeat: 4,
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
  const nodeA: RiffNode = { id: 'nA', name: 'A', color: '#fff', segments: [], stepsPerCycle: 4, subbeatsPerBeat: 4 };
  const nodeB: RiffNode = { id: 'nB', name: 'B', color: '#000', segments: [], stepsPerCycle: 8, subbeatsPerBeat: 4 };
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
  const nodeA: RiffNode = { id: 'nA', name: 'A', color: '#fff', segments: [], stepsPerCycle: 4, subbeatsPerBeat: 4 };
  const nodeB: RiffNode = { id: 'nB', name: 'B', color: '#000', segments: [], stepsPerCycle: 8, subbeatsPerBeat: 4 };
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

describe('accent drawing (per-note velocity)', () => {
  it('a note with no accent draws at full strength', () => {
    expect(accentOpacity(undefined)).toBe(1);
    expect(accentOpacity(127)).toBe(1);
  });

  it('keeps a ghost note clearly louder-looking than an empty chip', () => {
    // An empty chip draws at 0.2; the quietest struck step must beat that.
    expect(accentOpacity(1)).toBeGreaterThan(0.3);
    expect(accentOpacity(1)).toBeLessThan(accentOpacity(64));
    expect(accentOpacity(64)).toBeLessThan(accentOpacity(127));
  });
});
