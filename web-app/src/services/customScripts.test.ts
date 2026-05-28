import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  listDetectors,
  runDetector,
  getDetectorResult,
  uploadDetector,
  deleteDetector,
} from './customScripts';
import type {
  CustomBoundaryItem,
  CustomCueItem,
  CustomSpanItem,
  CustomResultEnvelope,
} from '../types/customScript';

// Counterpart to tools/python/tests/test_custom_roundtrip.py — pins the
// client-side parsing of the same envelope the Python validator emits. Drift
// on either side should make at least one of these test files fail.

// ─── fetch mock ─────────────────────────────────────────────────────────────

const originalFetch = global.fetch;

interface MockFetchOptions {
  ok: boolean;
  status?: number;
  body?: unknown;
  textBody?: string;
}

function mockFetch(response: MockFetchOptions): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
      text: async () => response.textBody ?? JSON.stringify(response.body),
    } as Response;
  }) as typeof global.fetch;
  return { calls };
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Envelope-parsing: each item kind survives the JSON trip ────────────────

describe('customScripts envelope parsing', () => {
  it('parses a boundary-kind envelope with all server fields preserved', async () => {
    const envelope: CustomResultEnvelope = {
      name: 'my_detector',
      slug: 'demo-song',
      output_kind: 'boundary',
      ran_at: '2026-05-26T12:00:00+00:00',
      duration_ms: 60_000,
      items: [
        { time_ms: 1000, label: 'drop', importance: 'critical',
          candidates: [990, 1010] } satisfies CustomBoundaryItem,
        { time_ms: 30_000, label: null, importance: null,
          candidates: null } satisfies CustomBoundaryItem,
      ],
      errors: [],
      stats: { accepted: 2, rejected: 0 },
      fatal: null,
    };
    mockFetch({ ok: true, body: envelope });

    const result = await runDetector('my_detector', 'demo-song');

    expect(result.output_kind).toBe('boundary');
    expect(result.items).toHaveLength(2);
    const first = result.items[0] as CustomBoundaryItem;
    expect(first.time_ms).toBe(1000);
    expect(first.importance).toBe('critical');
    expect(first.candidates).toEqual([990, 1010]);
    expect(result.stats).toEqual({ accepted: 2, rejected: 0 });
    expect(result.fatal).toBeNull();
  });

  it('parses a cue-kind envelope with description + intensity', async () => {
    const envelope: CustomResultEnvelope = {
      name: 'cue_det',
      slug: 's',
      output_kind: 'cue',
      ran_at: '2026-05-26T12:00:00Z',
      duration_ms: 10_000,
      items: [
        { time_ms: 500, label: 'kick', description: 'first downbeat',
          intensity: 0.7, candidates: null } satisfies CustomCueItem,
      ],
      errors: [],
      stats: { accepted: 1, rejected: 0 },
      fatal: null,
    };
    mockFetch({ ok: true, body: envelope });

    const result = await getDetectorResult('cue_det', 's');
    expect(result).not.toBeNull();
    const cue = result!.items[0] as CustomCueItem;
    expect(cue.description).toBe('first downbeat');
    expect(cue.intensity).toBe(0.7);
  });

  it('parses a span-kind envelope with duration_ms intact', async () => {
    const envelope: CustomResultEnvelope = {
      name: 'span_det',
      slug: 's',
      output_kind: 'span',
      ran_at: '2026-05-26T12:00:00Z',
      duration_ms: 60_000,
      items: [
        { start_ms: 1000, duration_ms: 5000, label: 'verse',
          intensity: 0.5 } satisfies CustomSpanItem,
      ],
      errors: [],
      stats: { accepted: 1, rejected: 0 },
      fatal: null,
    };
    mockFetch({ ok: true, body: envelope });

    const result = await runDetector('span_det', 's');
    const span = result.items[0] as CustomSpanItem;
    expect(span.start_ms).toBe(1000);
    expect(span.duration_ms).toBe(5000);
    expect(span.intensity).toBe(0.5);
  });

  it('preserves validation errors and stats.rejected', async () => {
    const envelope: CustomResultEnvelope = {
      name: 'noisy',
      slug: 's',
      output_kind: 'boundary',
      ran_at: '2026-05-26T12:00:00Z',
      duration_ms: 60_000,
      items: [],
      errors: [
        { index: 0, field: 'time_ms', value: -5,
          message: 'time_ms (-5) must be in [0, 60000].' },
        { index: 1, field: 'importance', value: 'must-have',
          message: "importance must be 'critical', 'optional', or None." },
      ],
      stats: { accepted: 0, rejected: 2 },
      fatal: null,
    };
    mockFetch({ ok: true, body: envelope });

    const result = await runDetector('noisy', 's');
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].field).toBe('time_ms');
    expect(result.errors[1].message).toContain("must be 'critical'");
    expect(result.stats.rejected).toBe(2);
  });

  it('parses a fatal envelope with install-hint fields', async () => {
    const envelope: CustomResultEnvelope = {
      name: 'broken',
      slug: 's',
      output_kind: 'boundary',
      ran_at: '2026-05-26T12:00:00Z',
      duration_ms: 0,
      items: [],
      errors: [],
      stats: { accepted: 0, rejected: 0 },
      fatal: {
        type: 'ModuleNotFoundError',
        message: "No module named 'torch'",
        traceback: 'Traceback (most recent call last):\n  ...',
        missing_module: 'torch',
        suggested_package: 'torch',
        suggested_install: 'pip install torch',
      },
    };
    mockFetch({ ok: true, body: envelope });

    const result = await runDetector('broken', 's');
    expect(result.fatal).not.toBeNull();
    expect(result.fatal!.missing_module).toBe('torch');
    expect(result.fatal!.suggested_install).toBe('pip install torch');
  });
});

// ─── HTTP failure paths ─────────────────────────────────────────────────────

describe('customScripts HTTP failure handling', () => {
  it('runDetector throws on non-2xx', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'detector crashed' } });
    await expect(runDetector('x', 's')).rejects.toThrow(/detector crashed/);
  });

  it('runDetector throws with a generic message when server body has no error field', async () => {
    mockFetch({ ok: false, status: 503, body: {} });
    await expect(runDetector('x', 's')).rejects.toThrow(/run failed: 503/);
  });

  it('getDetectorResult returns null on 404 (not yet cached)', async () => {
    mockFetch({ ok: false, status: 404 });
    const result = await getDetectorResult('x', 's');
    expect(result).toBeNull();
  });

  it('listDetectors throws on failure (caller renders error state)', async () => {
    mockFetch({ ok: false, status: 500 });
    await expect(listDetectors()).rejects.toThrow(/listDetectors failed/);
  });

  it('listDetectors returns [] when server omits the detectors field', async () => {
    mockFetch({ ok: true, body: {} });
    const detectors = await listDetectors();
    expect(detectors).toEqual([]);
  });
});

// ─── URL / method contract: hits the right server endpoint ──────────────────

describe('customScripts URL contract', () => {
  it('runDetector POSTs to /api/custom-scripts/run/<name>?slug=<slug>', async () => {
    const { calls } = mockFetch({
      ok: true,
      body: {
        name: 'x', slug: 's', output_kind: 'boundary',
        ran_at: '2026-05-26T12:00:00Z', duration_ms: 0,
        items: [], errors: [], stats: { accepted: 0, rejected: 0 },
        fatal: null,
      } satisfies CustomResultEnvelope,
    });
    await runDetector('my detector', 's');
    expect(calls).toHaveLength(1);
    // URL-encoded name (spaces → %20) and slug param
    expect(calls[0].url).toBe('/api/custom-scripts/run/my%20detector?slug=s');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('runDetector adds force=1 when opts.force is true', async () => {
    const { calls } = mockFetch({
      ok: true,
      body: {
        name: 'x', slug: 's', output_kind: 'boundary',
        ran_at: 't', duration_ms: 0, items: [], errors: [],
        stats: { accepted: 0, rejected: 0 }, fatal: null,
      } satisfies CustomResultEnvelope,
    });
    await runDetector('x', 's', { force: true });
    expect(calls[0].url).toContain('force=1');
  });

  it('uploadDetector POSTs name+code as JSON', async () => {
    const { calls } = mockFetch({
      ok: true,
      body: {
        detector: {
          name: 'x', file: '/abs/x.py', status: 'ok', label: 'X',
          output_kind: 'boundary', is_algorithm: true, is_annotation: false,
          description: '', version: '0.1', errors: [],
        },
      },
    });
    const entry = await uploadDetector('x', 'class X: pass');
    expect(entry.name).toBe('x');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      name: 'x',
      code: 'class X: pass',
    });
  });

  it('deleteDetector returns false on failure without throwing', async () => {
    mockFetch({ ok: false, status: 500 });
    const ok = await deleteDetector('x');
    expect(ok).toBe(false);
  });
});
