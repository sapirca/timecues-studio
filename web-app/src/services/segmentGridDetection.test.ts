/**
 * Reading ONE grid segment's tempo and meter off its own audio.
 *
 * The whole point of the feature is that the span is respected, so the two
 * things worth pinning are the ones that would silently undo it:
 *
 *  • the request actually carries {start, end} — a body missing them gets a
 *    whole-song answer from the server, which is exactly the wrong number
 *    presented as the segment's;
 *  • BeatNet is optional. It lives behind the experimental compose profile
 *    and is absent on the demo VM, so its failure must leave the tempo
 *    intact and only cost us the meter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectSegmentGrid,
  segmentTooShortReason,
  MIN_DETECT_SECONDS,
} from './segmentGridDetection';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/** Route by URL so each test states only the servers it cares about. */
function mockFetch(routes: {
  bpm?: () => Promise<Response> | Response;
  beatnet?: () => Promise<Response> | Response;
}) {
  const spy = vi.fn(async (...args: [url: string, init?: RequestInit]) => {
    const url = String(args[0]);
    if (url.includes('/api/beatnet/')) {
      if (!routes.beatnet) throw new TypeError('Failed to fetch');
      return routes.beatnet();
    }
    if (!routes.bpm) throw new TypeError('Failed to fetch');
    return routes.bpm();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const FIVE_DETECTORS = {
  slug: 'song', audio_file: 'song.mp3', duration: 12,
  range: { start: 12, end: 24 },
  algorithms: [
    { source: 'librosa-beat-track', ok: true, bpm: 152.0 },
    { source: 'librosa-tempo-static', ok: true, bpm: 152.0 },
    { source: 'librosa-tempo-dynamic', ok: true, bpm: 152.0 },
    { source: 'madmom-rnn-beats', ok: true, bpm: 150.0 },
    { source: 'madmom-tempo', ok: false, error: 'madmom not installed' },
  ],
  computed_at: '2026-09-10T00:00:00+00:00',
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('segmentTooShortReason', () => {
  it('passes a segment long enough to read a tempo from', () => {
    expect(segmentTooShortReason(41.1, 41.1 + MIN_DETECT_SECONDS)).toBeNull();
  });

  it('explains itself when the segment is too short', () => {
    const reason = segmentTooShortReason(41.1, 42.0);
    expect(reason).toContain('0.9s');
    expect(reason).toContain(`${MIN_DETECT_SECONDS}s`);
  });

  it('rejects an empty or inverted span', () => {
    expect(segmentTooShortReason(10, 10)).not.toBeNull();
    expect(segmentTooShortReason(10, 4)).not.toBeNull();
    // The last segment runs to +Infinity until the caller clamps it.
    expect(segmentTooShortReason(10, Infinity)).not.toBeNull();
  });
});

describe('detectSegmentGrid', () => {
  it('asks about the segment span, not the song', async () => {
    const spy = mockFetch({ bpm: () => jsonResponse(FIVE_DETECTORS) });
    await detectSegmentGrid('song', 12, 24);

    const call = spy.mock.calls.find(([url]) => String(url).includes('/api/bpm/'))!;
    expect(JSON.parse(call[1]!.body as string))
      .toEqual({ slug: 'song', start: 12, end: 24 });
  });

  it('refuses a too-short segment without troubling the server', async () => {
    const spy = mockFetch({ bpm: () => jsonResponse(FIVE_DETECTORS) });
    await expect(detectSegmentGrid('song', 12, 13)).rejects.toThrow(/at least/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('folds detectors that agree into one candidate, most votes first', async () => {
    mockFetch({ bpm: () => jsonResponse(FIVE_DETECTORS) });
    const result = await detectSegmentGrid('song', 12, 24);

    expect(result.candidates).toEqual([
      { bpm: 152, sources: ['librosa-beat-track', 'librosa-tempo-static', 'librosa-tempo-dynamic'] },
      { bpm: 150, sources: ['madmom-rnn-beats'] },
    ]);
    expect(result.failures).toEqual([
      { source: 'madmom-tempo', error: 'madmom not installed' },
    ]);
  });

  it('keeps the tempo when BeatNet is not running', async () => {
    // No beatnet route → the fetch throws, as it does when the experimental
    // compose profile is down. That is the normal case on the demo VM.
    mockFetch({ bpm: () => jsonResponse(FIVE_DETECTORS) });
    const result = await detectSegmentGrid('song', 12, 24);

    expect(result.candidates[0].bpm).toBe(152);
    expect(result.meter).toBeUndefined();
  });

  it('takes the meter from BeatNet when it answers', async () => {
    mockFetch({
      bpm: () => jsonResponse(FIVE_DETECTORS),
      beatnet: () => jsonResponse({
        slug: 'song', audio_file: 'song.mp3', duration: 12,
        range: { start: 12, end: 24 },
        result: { source: 'beatnet', ok: true, bpm: 150.2, meter: '7/8' },
        computed_at: '2026-09-10T00:00:00+00:00',
      }),
    });
    const result = await detectSegmentGrid('song', 12, 24);
    expect(result.meter).toBe('7/8');
  });

  it('ignores a meter BeatNet was not confident about', async () => {
    mockFetch({
      bpm: () => jsonResponse(FIVE_DETECTORS),
      beatnet: () => jsonResponse({
        slug: 'song', audio_file: 'song.mp3', duration: 12,
        range: { start: 12, end: 24 },
        result: { source: 'beatnet', ok: true, bpm: 150.2, meter: null },
        computed_at: '2026-09-10T00:00:00+00:00',
      }),
    });
    const result = await detectSegmentGrid('song', 12, 24);
    expect(result.meter).toBeUndefined();
  });

  it('surfaces the server’s own refusal rather than a generic failure', async () => {
    mockFetch({
      bpm: () => jsonResponse({ error: 'a range needs at least 2s of audio' }, false, 400),
    });
    await expect(detectSegmentGrid('song', 12, 24)).rejects.toThrow(/at least 2s of audio/);
  });

  it('reports no candidates rather than throwing when every detector failed', async () => {
    mockFetch({
      bpm: () => jsonResponse({
        ...FIVE_DETECTORS,
        algorithms: [{ source: 'librosa-beat-track', ok: false, error: 'too few onsets' }],
      }),
    });
    const result = await detectSegmentGrid('song', 12, 24);
    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([{ source: 'librosa-beat-track', error: 'too few onsets' }]);
  });
});


// ─── Catching a server that ignored the range ───────────────────────────────
//
// A server from before per-segment detection accepts {start, end}, ignores
// them, and answers about the whole file. That answer is indistinguishable
// from a real one on screen — a plausible tempo, attributed to the segment —
// and it is exactly the wrong number this endpoint exists to avoid. Ranged
// replies echo `range`; whole-song replies never do.

describe('a server that ignored the range', () => {
  const WHOLE_SONG = { ...FIVE_DETECTORS };
  delete (WHOLE_SONG as { range?: unknown }).range;

  it('refuses a whole-song tempo rather than passing it off as the segment’s', async () => {
    mockFetch({ bpm: () => jsonResponse(WHOLE_SONG) });
    await expect(detectSegmentGrid('song', 12, 24)).rejects.toThrow(/whole song, not this segment/);
  });

  it('names the fix in the message', async () => {
    mockFetch({ bpm: () => jsonResponse(WHOLE_SONG) });
    await expect(detectSegmentGrid('song', 12, 24)).rejects.toThrow(/bpm_server\.py/);
  });

  it('refuses an answer about a different span', async () => {
    // A proxy or cache handing back a neighbouring segment's result.
    mockFetch({ bpm: () => jsonResponse({ ...FIVE_DETECTORS, range: { start: 0, end: 12 } }) });
    await expect(detectSegmentGrid('song', 12, 24)).rejects.toThrow(/whole song, not this segment/);
  });

  it('accepts a millisecond of float slack in the echo', async () => {
    mockFetch({ bpm: () => jsonResponse({ ...FIVE_DETECTORS, range: { start: 12.0004, end: 23.9996 } }) });
    const result = await detectSegmentGrid('song', 12, 24);
    expect(result.candidates[0].bpm).toBe(152);
  });

  it('drops the meter from an old BeatNet without sinking the tempo', async () => {
    // BeatNet is optional, so an old one costs the meter and nothing else.
    mockFetch({
      bpm: () => jsonResponse(FIVE_DETECTORS),
      beatnet: () => jsonResponse({
        slug: 'song', audio_file: 'song.mp3', duration: 180,
        result: { source: 'beatnet', ok: true, bpm: 150.2, meter: '3/4' },
        computed_at: '2026-09-10T00:00:00+00:00',
      }),
    });
    const result = await detectSegmentGrid('song', 12, 24);
    expect(result.candidates[0].bpm).toBe(152);
    expect(result.meter).toBeUndefined();
  });
});
