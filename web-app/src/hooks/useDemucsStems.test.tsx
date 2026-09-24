import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDemucsStems, type StemRunTarget } from './useDemucsStems';

// The background queue is what a song upload feeds: it must run one job at a
// time, skip songs that are already separated, keep going after a failure, and
// carry the caller's chosen model (6 vs 4 stems) all the way to the POST body.

const song = (id: string): StemRunTarget => ({ id, name: id, url: `/audio/${id}.mp3` });

/** Install a fetch stub. `withStems` are slugs that already have a manifest on
 *  disk; `failing` are slugs whose job reports status=error. */
function stubFetch(opts: { withStems?: string[]; failing?: string[] } = {}) {
  const withStems = new Set(opts.withStems ?? []);
  const failing = new Set(opts.failing ?? []);
  const started: { slug: string; body: { force?: boolean; model?: string } }[] = [];

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const manifest = url.match(/^\/stems\/([^/]+)\/manifest\.json$/);
    if (manifest) {
      const slug = decodeURIComponent(manifest[1]);
      return withStems.has(slug)
        ? new Response(JSON.stringify({ stems: { vocals: `/stems/${slug}/vocals.wav` } }), { status: 200 })
        : new Response('not found', { status: 404 });
    }
    const start = url.match(/^\/api\/run-demucs\/([^/]+)$/);
    if (start) {
      const slug = decodeURIComponent(start[1]);
      started.push({ slug, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ jobId: `job-${slug}` }), { status: 200 });
    }
    const status = url.match(/^\/api\/run-demucs\/status\/job-(.+)$/);
    if (status) {
      const slug = decodeURIComponent(status[1]);
      return new Response(JSON.stringify({
        status: failing.has(slug) ? 'error' : 'done',
        logs: failing.has(slug) ? 'boom\n' : '100%|##| done\n',
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { started };
}

/** Let the drain loop work: each job waits 2 s between status polls. */
async function settle(ms = 20_000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useDemucsStems — background queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs queued songs one at a time and skips ones already stemmed', async () => {
    const { started } = stubFetch({ withStems: ['b'] });
    const { result } = renderHook(() => useDemucsStems());

    act(() => { result.current.enqueueStems([song('a'), song('b'), song('c')], { model: '4s' }); });
    await settle();

    expect(started.map((s) => s.slug)).toEqual(['a', 'c']);
    expect(started.every((s) => s.body.model === '4s')).toBe(true);
    expect(result.current.queued).toEqual([]);
  });

  it('keeps going after a job fails', async () => {
    const { started } = stubFetch({ failing: ['a'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useDemucsStems());

    act(() => { result.current.enqueueStems([song('a'), song('b')]); });
    await settle();

    expect(started.map((s) => s.slug)).toEqual(['a', 'b']);
    expect(result.current.job?.status).toBe('done');
  });

  it('defaults to the 6-stem model and reports it on the job', async () => {
    const { started } = stubFetch();
    const { result } = renderHook(() => useDemucsStems());

    act(() => { result.current.enqueueStems([song('a')]); });
    await settle();

    expect(started[0].body.model).toBe('6s');
    expect(result.current.job?.model).toBe('6s');
    expect(result.current.job?.auto).toBe(true);
  });

  it('reports what is still waiting and can drop it', async () => {
    stubFetch();
    const { result } = renderHook(() => useDemucsStems());

    act(() => { result.current.enqueueStems([song('a'), song('b'), song('c')]); });
    // One job is in flight; the other two are still queued.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(result.current.queued.map((q) => q.id)).toEqual(['b', 'c']);

    act(() => { result.current.clearQueue(); });
    expect(result.current.queued).toEqual([]);
  });

  it('does not queue the same song twice', async () => {
    const { started } = stubFetch();
    const { result } = renderHook(() => useDemucsStems());

    act(() => { result.current.enqueueStems([song('a'), song('b')]); });
    act(() => { result.current.enqueueStems([song('b')]); });
    await settle();

    expect(started.map((s) => s.slug)).toEqual(['a', 'b']);
  });
});

describe('useDemucsStems — interactive run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the picked model and forces an overwrite once confirmed', async () => {
    const { started } = stubFetch({ withStems: ['a'] });
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { result } = renderHook(() => useDemucsStems());

    act(() => { void result.current.runStems(song('a'), { model: '4s' }); });
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0].body).toMatchObject({ force: true, model: '4s' });
    expect(result.current.job?.auto).toBe(false);
  });

  it('leaves existing stems alone when the overwrite is declined', async () => {
    const { started } = stubFetch({ withStems: ['a'] });
    vi.stubGlobal('confirm', vi.fn(() => false));
    const { result } = renderHook(() => useDemucsStems());

    act(() => { void result.current.runStems(song('a')); });
    await settle();

    expect(started).toEqual([]);
  });
});
