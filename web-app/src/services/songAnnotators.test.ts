import { describe, it, expect, afterEach, vi } from 'vitest';
import { describeAnnotatorCount, fetchSongAnnotatorRoster } from './songAnnotators';

// AnnotatorContext is a singleton that writes a cookie on import; stub it so
// these stay deterministic. The factory must be self-contained — vi hoists it.
vi.mock('../context/AnnotatorContext', () => ({
  getCurrentAnnotatorId: () => 'local-curator',
  DEMO_ANNOTATOR_ID: 'demo-anonymous',
}));

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function mockFetch(ok: boolean, body?: unknown): { url: string }[] {
  const calls: { url: string }[] = [];
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    calls.push({ url: String(url) });
    return { ok, status: ok ? 200 : 403, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('describeAnnotatorCount', () => {
  it('draws nothing for a song nobody has annotated', () => {
    expect(describeAnnotatorCount(0, false).show).toBe(false);
  });

  it('draws nothing when the only annotator is you', () => {
    // The row's status dot already reports your own progress; a "1" on every
    // song you touched would be noise.
    expect(describeAnnotatorCount(1, true).show).toBe(false);
  });

  it('draws a single annotator who is not you', () => {
    const { show, title } = describeAnnotatorCount(1, false);
    expect(show).toBe(true);
    expect(title).toBe('One annotator has work on this song, and it is not you');
  });

  it('counts you in, and says how many others', () => {
    expect(describeAnnotatorCount(2, true).title)
      .toBe('2 annotators have work on this song: you and 1 other');
    expect(describeAnnotatorCount(4, true).title)
      .toBe('4 annotators have work on this song: you and 3 others');
  });

  it('says plainly when none of them is you', () => {
    expect(describeAnnotatorCount(3, false).title)
      .toBe('3 annotators have work on this song, none of them you');
  });
});

describe('fetchSongAnnotatorRoster', () => {
  it('asks about one song, encoding the slug', async () => {
    const calls = mockFetch(true, { slug: 'a b', sharedCorpus: false, annotators: [] });
    await fetchSongAnnotatorRoster('a b');
    expect(calls[0].url).toBe('/api/song-annotators?slug=a%20b');
  });

  it('returns the names the server resolved, caller first', async () => {
    mockFetch(true, {
      slug: 's',
      sharedCorpus: false,
      annotators: [
        { name: 'curator', mine: true, items: 3 },
        { name: 'Dana Levi', mine: false, items: 247 },
      ],
    });
    const res = await fetchSongAnnotatorRoster('s');
    expect(res.annotators.map((a) => a.name)).toEqual(['curator', 'Dana Levi']);
    expect(res.annotators[0].mine).toBe(true);
  });

  it('throws when the request is refused, rather than reporting nobody', async () => {
    // A popover that silently says "no one" on a 403 is worse than one that
    // admits it could not find out.
    mockFetch(false);
    await expect(fetchSongAnnotatorRoster('s')).rejects.toThrow('HTTP 403');
  });
});
