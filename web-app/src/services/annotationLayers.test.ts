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
  newPatternLayer,
  newCueItem,
  newSpanItem,
  newPatternItem,
  PATTERN_SUBBEATS_PER_BEAT,
  type AnnotationLayersDocument,
  type CueItem,
  type PatternItem,
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

  const patternLayer = newPatternLayer('Kick pattern', '#fbbf24');
  const pattern = newPatternItem(0, 2.0, 'four-on-the-floor', '', 4);
  pattern.highlightedBeats = [0, 4, 8, 12];
  patternLayer.items = [pattern];

  return {
    song: 'test-song',
    annotated_at: '2026-05-26T12:00:00.000Z',
    layers: [cueLayer, spanLayer, patternLayer],
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
      statusByType: { cues: 'reviewed', patterns: 'in_progress' },
    };
    const back = JSON.parse(JSON.stringify(doc)) as AnnotationLayersDocument;
    expect(back.statusByType).toEqual({ cues: 'reviewed', patterns: 'in_progress' });
  });
});

// ─── Migration: legacy beat-grid pattern items upgrade on load ──────────────
//
// Documents created before 2026-05-20 stored `highlightedBeats` as beat
// indices 0..3 (PATTERN_BEATS_PER_CYCLE=4). loadLayers() must multiply them
// by PATTERN_SUBBEATS_PER_BEAT and stamp subbeatGrid=true so the sub-beat UI
// renders them correctly.

describe('annotation-layers legacy pattern migration', () => {
  it('upgrades legacy highlightedBeats on load', async () => {
    const legacyDoc = {
      song: 'old-song',
      annotated_at: '2026-05-01T00:00:00.000Z',
      layers: [
        {
          id: 'layer-1',
          name: 'old pattern',
          type: 'patterns',
          visible: true,
          color: '#fbbf24',
          snap: 'bar',
          items: [
            {
              id: 'item-1',
              start: 0,
              end: 2,
              label: 'kick',
              repeatCount: 4,
              highlightedBeats: [0, 1, 2, 3], // legacy 0..3
              // subbeatGrid is intentionally absent — that's what marks it legacy
            },
          ],
        },
      ],
    };
    mockFetchOnce({ ok: true, body: legacyDoc });
    const doc = await loadLayers('old-song');
    const upgraded = doc.layers[0].items[0] as PatternItem;
    // Each legacy beat index multiplied by PATTERN_SUBBEATS_PER_BEAT (=4).
    expect(upgraded.highlightedBeats).toEqual([0, 4, 8, 12]);
    expect(upgraded.subbeatGrid).toBe(true);
  });

  it('leaves already-migrated patterns untouched', async () => {
    const modernDoc = {
      song: 's',
      annotated_at: 'now',
      layers: [
        {
          id: 'l1',
          name: 'p',
          type: 'patterns',
          visible: true,
          color: '#000',
          snap: 'bar',
          items: [
            {
              id: 'i1',
              start: 0,
              end: 2,
              label: 'kick',
              repeatCount: 1,
              highlightedBeats: [0, 4, 8, 12],
              subbeatGrid: true,
            },
          ],
        },
      ],
    };
    mockFetchOnce({ ok: true, body: modernDoc });
    const doc = await loadLayers('s');
    const item = doc.layers[0].items[0] as PatternItem;
    expect(item.highlightedBeats).toEqual([0, 4, 8, 12]);
  });

  // PATTERN_SUBBEATS_PER_BEAT is the migration multiplier; pin it so a
  // change to the constant forces an update to the migration tests too.
  it('PATTERN_SUBBEATS_PER_BEAT pins the legacy migration multiplier', () => {
    expect(PATTERN_SUBBEATS_PER_BEAT).toBe(4);
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
