// Whisper-base vocal transcription — talks to the Python lyrics_server
// (proxied at /api/lyrics). LYRICS family. Experimental: gated by
// `experimentalLyricsFamily`.

import { createDetectionClient } from './detectionClient';

export interface LyricsWordEntry {
  time: number;
  end: number;
  text: string;
  kind: 'word' | 'line';
}

export interface LyricsDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  language: string | null;
  words: LyricsWordEntry[];
  lines: LyricsWordEntry[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface LyricsAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

const client = createDetectionClient<LyricsAlgorithmInfo, LyricsDetectionResult>('lyrics', 'words');

export const listLyricsAlgorithms = client.listAlgorithms;
export const loadCachedLyrics = client.loadCached;
export const initializeLyricsAlgorithm = client.initializeAlgorithm;

// Not delegated to the generic client: lyrics detection takes extra opts
// (language override, user-supplied text) that the shared runDetection
// signature doesn't carry.
export async function runLyricsDetection(
  slug: string, algo: string,
  opts: { force?: boolean; language?: string; text?: string } = {},
): Promise<LyricsDetectionResult | null> {
  try {
    const res = await fetch('/api/lyrics/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, ...opts }),
    });
    if (!res.ok) return null;
    return await res.json() as LyricsDetectionResult;
  } catch { return null; }
}

/** A window re-run carries the window it answered for; a whole-song run
 *  doesn't. Word times are already in song time either way. */
export interface LyricsRangeResult extends LyricsDetectionResult {
  range?: { start: number; end: number; pad: number };
}

export interface LyricsRangeOptions {
  /** Demucs stem to read, or 'mix'. */
  stem?: string;
  /** Whisper language hint ('fr', 'he', …). Absent ⇒ auto-detect, which on a
   *  short clip of an isolated stem guesses wrong more often than on the
   *  whole song — there is less evidence to guess from. */
  language?: string;
  /** ctc-forced-aligner only: the words actually sung in this window. The
   *  whole-song reference is deliberately NOT used for a window. */
  text?: string;
  /** Seconds of surrounding audio the model hears but we discard. */
  pad?: number;
}

/** Transcribe ONE window of a song and return the words in song time.
 *  Writes nothing: the detector cache only changes if `mergeLyricsWindow`
 *  is called with the result. Throws with the server's message so the caller
 *  can show why (missing stem, sidecar down, no reference text). */
export async function runLyricsRangeDetection(
  slug: string, algo: string, start: number, end: number,
  opts: LyricsRangeOptions = {},
): Promise<LyricsRangeResult> {
  const res = await fetch('/api/lyrics/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, algo, start, end, ...opts }),
  });
  const body = await res.json().catch(() => null) as (LyricsRangeResult & { error?: string }) | null;
  if (!res.ok) {
    throw new Error(
      body?.error
      ?? (res.status === 503
        ? 'Lyrics sidecar is not running (docker compose --profile experimental-models up lyrics).'
        : `Lyrics detect failed (${res.status})`),
    );
  }
  if (!body) throw new Error('Lyrics detect returned nothing.');
  if (body.ok === false) throw new Error(body.error || 'detector reported ok=false');
  return body;
}

/** Replace what the cached `<algo>[__<stem>]` result says about [start, end)
 *  with `words`. An empty `words` clears the window. Returns the merged
 *  payload. */
export async function mergeLyricsWindow(
  slug: string, algo: string, start: number, end: number,
  words: { time: number; end: number; text: string }[],
  opts: { stem?: string; source?: string } = {},
): Promise<LyricsDetectionResult & { added: number; removed: number }> {
  const res = await fetch('/api/lyrics/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, algo, start, end, words, ...opts }),
  });
  const body = await res.json().catch(() => null) as
    (LyricsDetectionResult & { added: number; removed: number; error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `Lyrics merge failed (${res.status})`);
  return body;
}
