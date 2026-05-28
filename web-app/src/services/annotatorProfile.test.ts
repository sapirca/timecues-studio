import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchProfileById,
  saveProfile,
  inviteAnnotator,
  fetchAllProfiles,
  deleteProfile,
  type InvitePayload,
} from './annotatorProfile';
import type { Annotator } from '../types/annotator';

vi.mock('../context/AnnotatorContext', () => ({
  getCurrentAnnotatorId: () => 'test-admin@example.com',
  DEMO_ANNOTATOR_ID: 'demo-anonymous',
}));

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
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {})),
    } as Response;
  }) as typeof global.fetch;
  return calls;
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SAMPLE: Annotator = {
  id: 'jane@x.com',
  displayName: 'Jane Doe',
  email: 'jane@x.com',
  authMethod: 'google',
  createdAt: '2026-05-26T12:00:00.000Z',
};

// ─── fetchProfileById ────────────────────────────────────────────────────────

describe('fetchProfileById', () => {
  it('returns the profile on 200', async () => {
    const calls = mockFetch({ ok: true, body: SAMPLE });
    const result = await fetchProfileById('jane@x.com');
    expect(result).toEqual(SAMPLE);
    expect(calls[0].url).toBe('/api/annotators/profile/jane%40x.com');
  });

  it('returns null on 404 without throwing (returning users we have not seen yet)', async () => {
    mockFetch({ ok: false, status: 404 });
    expect(await fetchProfileById('unknown')).toBeNull();
  });

  it('returns null on any non-OK status (other failure modes are non-fatal here)', async () => {
    mockFetch({ ok: false, status: 500 });
    expect(await fetchProfileById('x')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof global.fetch;
    expect(await fetchProfileById('x')).toBeNull();
  });
});

// ─── saveProfile — fire-and-forget ───────────────────────────────────────────

describe('saveProfile', () => {
  it('POSTs JSON to /api/annotators/profile', async () => {
    const calls = mockFetch({ ok: true });
    await saveProfile(SAMPLE);
    expect(calls[0].url).toBe('/api/annotators/profile');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual(SAMPLE);
  });

  it('swallows errors silently (the local sign-in still works without server persistence)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); }) as typeof global.fetch;
    await expect(saveProfile(SAMPLE)).resolves.toBeUndefined();
  });

  it('swallows non-OK responses (fire-and-forget contract)', async () => {
    mockFetch({ ok: false, status: 500 });
    await expect(saveProfile(SAMPLE)).resolves.toBeUndefined();
  });
});

// ─── inviteAnnotator — admin-only profile + allowlist mutation ──────────────

describe('inviteAnnotator', () => {
  const payload: InvitePayload = {
    identity: 'newhire@x.com',
    authMethod: 'google',
    displayName: 'New Hire',
    tier: 'team',
  };

  it('POSTs the payload with the admin header', async () => {
    const calls = mockFetch({ ok: true, body: SAMPLE });
    const result = await inviteAnnotator(payload);
    expect(result).toEqual(SAMPLE);
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Annotator-Id']).toBe('test-admin@example.com');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual(payload);
  });

  it('surfaces the server error body when the request fails', async () => {
    mockFetch({ ok: false, status: 400, body: 'invalid email' });
    await expect(inviteAnnotator(payload)).rejects.toThrow(/invalid email/);
  });

  it('falls back to "HTTP <code>" when the server returns no body', async () => {
    mockFetch({ ok: false, status: 500, body: '' });
    await expect(inviteAnnotator(payload)).rejects.toThrow(/HTTP 500/);
  });
});

// ─── fetchAllProfiles — admin-only roster read ───────────────────────────────

describe('fetchAllProfiles', () => {
  it('unwraps the profiles array from the envelope', async () => {
    mockFetch({ ok: true, body: { profiles: [SAMPLE, { ...SAMPLE, id: 'b@x.com' }] } });
    const profiles = await fetchAllProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[1].id).toBe('b@x.com');
  });

  it('returns [] when the server omits the profiles field', async () => {
    mockFetch({ ok: true, body: {} });
    expect(await fetchAllProfiles()).toEqual([]);
  });

  it('throws on non-OK (caller renders the error)', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(fetchAllProfiles()).rejects.toThrow(/HTTP 403/);
  });

  it('sends the admin header so the server can authorize', async () => {
    const calls = mockFetch({ ok: true, body: { profiles: [] } });
    await fetchAllProfiles();
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Annotator-Id']).toBe('test-admin@example.com');
  });
});

// ─── deleteProfile — admin-only, keeps annotation files on disk ─────────────

describe('deleteProfile', () => {
  it('DELETEs /api/annotators/profile/<id>', async () => {
    const calls = mockFetch({ ok: true });
    await deleteProfile('jane@x.com');
    expect(calls[0].url).toBe('/api/annotators/profile/jane%40x.com');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('throws on failure', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(deleteProfile('jane@x.com')).rejects.toThrow(/HTTP 403/);
  });

  it('sends the admin header', async () => {
    const calls = mockFetch({ ok: true });
    await deleteProfile('jane@x.com');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Annotator-Id']).toBe('test-admin@example.com');
  });
});
