import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  checkAccess,
  loadDatasetConfig,
  saveDatasetConfig,
  purgePerson,
} from './datasetConfig';
import { DEFAULT_DATASET_CONFIG, type DatasetConfig } from '../types/datasetConfig';

// AnnotatorContext is a singleton with side-effects (cookie write on import);
// stub it so service tests are deterministic and don't depend on localStorage
// or document.cookie state. The mock factory must be self-contained — vi
// hoists vi.mock above other imports.
vi.mock('../context/AnnotatorContext', () => ({
  getCurrentAnnotatorId: () => 'test-admin@example.com',
  DEMO_ANNOTATOR_ID: 'demo-anonymous',
}));

// ─── fetch mock ──────────────────────────────────────────────────────────────

const originalFetch = global.fetch;
interface FetchCall { url: string; init?: RequestInit; }

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      headers: {
        get: (k: string) => response.headers?.[k.toLowerCase()] ?? null,
      },
      json: async () => response.body,
      text: async () => JSON.stringify(response.body ?? {}),
    } as unknown as Response;
  }) as typeof global.fetch;
  return calls;
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── checkAccess — sign-in gate, server-side tier resolution ────────────────

describe('checkAccess', () => {
  it('returns the resolved tier on success', async () => {
    const calls = mockFetch({ ok: true, body: { tier: 'admin' } });
    const tier = await checkAccess('admin@x.com');
    expect(tier).toBe('admin');
    expect(calls[0].url).toBe('/api/check-access?id=admin%40x.com');
  });

  it('returns null when the server says tier=null (public)', async () => {
    mockFetch({ ok: true, body: { tier: null } });
    expect(await checkAccess('public@x.com')).toBeNull();
  });

  it('returns null on HTTP failure (no leaking server errors to the sign-in screen)', async () => {
    mockFetch({ ok: false, status: 500 });
    expect(await checkAccess('x@x.com')).toBeNull();
  });

  it('returns null when fetch itself throws (offline)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); }) as typeof global.fetch;
    expect(await checkAccess('x@x.com')).toBeNull();
  });

  it('URL-encodes the id (spaces, @ signs, plus-tags)', async () => {
    const calls = mockFetch({ ok: true, body: { tier: 'team' } });
    await checkAccess('user+tag@x.com');
    expect(calls[0].url).toBe('/api/check-access?id=user%2Btag%40x.com');
  });
});

// ─── loadDatasetConfig — must always return a usable config ─────────────────

describe('loadDatasetConfig', () => {
  it('returns server payload merged into defaults', async () => {
    mockFetch({
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: { corpusName: 'EDM Studio', sharedCorpus: true },
    });
    const cfg = await loadDatasetConfig();
    expect(cfg.corpusName).toBe('EDM Studio');
    expect(cfg.sharedCorpus).toBe(true);
  });

  it('returns defaults on 404 (a fresh clone has no config yet)', async () => {
    mockFetch({ ok: false, status: 404 });
    const cfg = await loadDatasetConfig();
    expect(cfg).toEqual(DEFAULT_DATASET_CONFIG);
  });

  it('returns defaults when content-type is not JSON (vite dev-server returns HTML)', async () => {
    mockFetch({
      ok: true,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html>',
    });
    const cfg = await loadDatasetConfig();
    expect(cfg).toEqual(DEFAULT_DATASET_CONFIG);
  });

  it('returns defaults when the body is not an object', async () => {
    mockFetch({
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: 'just-a-string',
    });
    const cfg = await loadDatasetConfig();
    expect(cfg).toEqual(DEFAULT_DATASET_CONFIG);
  });

  it('returns defaults when fetch throws', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof global.fetch;
    const cfg = await loadDatasetConfig();
    expect(cfg).toEqual(DEFAULT_DATASET_CONFIG);
  });
});

// ─── saveDatasetConfig — admin-only write ────────────────────────────────────

describe('saveDatasetConfig', () => {
  it('POSTs JSON with X-Annotator-Id and a Content-Type header', async () => {
    const calls = mockFetch({ ok: true });
    const cfg: DatasetConfig = { corpusName: 'Test' };
    await saveDatasetConfig(cfg);
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Annotator-Id']).toBe('test-admin@example.com');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual(cfg);
  });

  it('translates 403 into "admin required" so the caller can render a clear message', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(saveDatasetConfig({})).rejects.toThrow(/admin required/);
  });

  it('reports HTTP status for other failures', async () => {
    mockFetch({ ok: false, status: 500 });
    await expect(saveDatasetConfig({})).rejects.toThrow(/HTTP 500/);
  });
});

// ─── purgePerson — admin-only destructive op with last-admin guard ──────────

describe('purgePerson', () => {
  it('DELETEs /api/people/<email> with the annotator header', async () => {
    const calls = mockFetch({
      ok: true,
      body: { ok: true, deletedIds: ['a@x.com'], removedDirs: 1, removedFiles: 7, removedProfiles: 1 },
    });
    const result = await purgePerson('a@x.com');
    expect(calls[0].url).toBe('/api/people/a%40x.com');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(result).toEqual({
      ok: true, deletedIds: ['a@x.com'], removedDirs: 1, removedFiles: 7, removedProfiles: 1,
    });
  });

  it('refuses the last-admin removal (server returns 409)', async () => {
    mockFetch({ ok: false, status: 409 });
    await expect(purgePerson('a@x.com')).rejects.toThrow(/cannot remove the last admin/);
  });

  it('refuses non-admin callers (server returns 403)', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(purgePerson('a@x.com')).rejects.toThrow(/admin required/);
  });

  it('reports HTTP status for other failures', async () => {
    mockFetch({ ok: false, status: 500 });
    await expect(purgePerson('a@x.com')).rejects.toThrow(/HTTP 500/);
  });
});
