import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fetchCapabilities, type Capabilities } from './capabilities';

// fetchCapabilities is the single source of truth for "is the optional
// gpu-tools service installed?" — every UI affordance that depends on
// allin1 or Demucs reads from this. These tests pin: (1) the absent-fallback
// (the network failure path must NOT poison the cache), (2) the 60s TTL,
// (3) the force-refresh contract.

const CACHE_KEY = 'timecues.capabilities.v1';
const originalFetch = global.fetch;

interface FetchCall { url: string; init?: RequestInit; }

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
    } as Response;
  }) as typeof global.fetch;
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  localStorage.clear();
});

const GPU_OK: Capabilities = {
  allin1: true,
  demucs: true,
  variant: 'cuda',
  speed: 'fast',
  source: 'docker-marker',
};

describe('fetchCapabilities — happy path', () => {
  it('returns the server payload and writes it to localStorage', async () => {
    const calls = mockFetch({ ok: true, body: GPU_OK });
    const result = await fetchCapabilities();
    expect(result).toEqual(GPU_OK);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/capabilities');
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    expect(cached?.value).toEqual(GPU_OK);
    expect(typeof cached?.at).toBe('number');
  });

  it('reuses the cache on a subsequent call inside the TTL', async () => {
    const calls = mockFetch({ ok: true, body: GPU_OK });
    await fetchCapabilities();
    const result = await fetchCapabilities();
    expect(result).toEqual(GPU_OK);
    expect(calls).toHaveLength(1);  // second call NEVER hit the network
  });
});

describe('fetchCapabilities — force refresh', () => {
  it('bypasses the cache and adds force=1 to the URL', async () => {
    const calls = mockFetch({ ok: true, body: GPU_OK });
    await fetchCapabilities();
    await fetchCapabilities({ force: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/api/capabilities?force=1');
  });
});

describe('fetchCapabilities — failure paths', () => {
  const ABSENT: Capabilities = {
    allin1: false,
    demucs: false,
    variant: 'unknown',
    speed: 'unknown',
    source: 'absent',
  };

  it('returns an absent fallback when the endpoint 500s', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'server down' } });
    const result = await fetchCapabilities();
    expect(result).toEqual(ABSENT);
  });

  it('does NOT persist the fallback to cache (a transient failure must not stick)', async () => {
    mockFetch({ ok: false, status: 500 });
    await fetchCapabilities();
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('returns absent fallback when fetch itself throws (offline)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as typeof global.fetch;
    const result = await fetchCapabilities();
    expect(result).toEqual(ABSENT);
  });
});

describe('fetchCapabilities — cache TTL', () => {
  it('refetches when the cached entry is older than 60s', async () => {
    // Plant a stale cache entry directly.
    const stale = { value: GPU_OK, at: Date.now() - 61_000 };
    localStorage.setItem(CACHE_KEY, JSON.stringify(stale));

    const fresh: Capabilities = { ...GPU_OK, variant: 'cpu', speed: 'slow' };
    const calls = mockFetch({ ok: true, body: fresh });
    const result = await fetchCapabilities();
    expect(result).toEqual(fresh);
    expect(calls).toHaveLength(1);
  });

  it('treats malformed cache JSON as a miss (no throw, refetches)', async () => {
    localStorage.setItem(CACHE_KEY, '{this-is-not-json');
    const calls = mockFetch({ ok: true, body: GPU_OK });
    const result = await fetchCapabilities();
    expect(result).toEqual(GPU_OK);
    expect(calls).toHaveLength(1);
  });
});

describe('fetchCapabilities — in-flight deduplication', () => {
  it('returns the same in-flight promise for concurrent callers', async () => {
    // Block fetch until we release it, so both callers race the same inflight.
    let release!: (v: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    let calls = 0;
    global.fetch = vi.fn(async () => { calls++; return gate; }) as typeof global.fetch;

    const a = fetchCapabilities();
    const b = fetchCapabilities();
    release({
      ok: true, status: 200,
      json: async () => GPU_OK,
    } as Response);
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toEqual(GPU_OK);
    expect(resultB).toEqual(GPU_OK);
    expect(calls).toBe(1);  // both callers shared a single network round-trip
  });
});
