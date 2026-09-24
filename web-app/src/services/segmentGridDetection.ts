// Detecting the grid of ONE segment, rather than of the whole song.
//
// A grid segment exists precisely because the count restarts there: its
// tempo and meter are its own. Running the detectors over the whole file
// answers about neither half of a song that changes — a track that runs 100
// BPM and then 150 comes back as one blended ~150, which is wrong for the
// first half and only accidentally right for the second.
//
// So both detect endpoints take an optional `{start, end}` and analyse just
// that span: librosa loads with an offset, and the file-based detectors
// (madmom, BeatNet) are handed a temp WAV holding only the span. Timestamps
// come back in SONG time — the server shifts them before replying — so
// nothing here has to know about the trim.
//
// Two servers, because two different questions:
//   /api/bpm/detect      → tempo. Always available (core-mir image).
//   /api/beatnet/detect  → meter. Experimental profile only; absent is normal
//                          and simply means the meter chip doesn't appear.

import type { BpmDetectionResult } from './bpmDetection';
import type { BeatnetDetectionResult } from './beatnetDetection';

/** Seconds of audio a detector needs before a tempo estimate means anything —
 *  librosa's onset autocorrelation and madmom's RNN both want several beats
 *  to lock on. Mirrors `MIN_RANGE_SECONDS` in tools/python/server_common.py,
 *  which is the enforcer; this copy exists so the button can grey out with a
 *  reason instead of making the round trip to be told no. */
export const MIN_DETECT_SECONDS = 2;

/** One detector's answer, folded with everyone else who said the same thing.
 *  Five detectors reporting 99.4, 99.4, 99.4, 100.0, 100.0 is two candidates
 *  with vote counts, not five chips in a 300px popover. */
export interface SegmentBpmCandidate {
  bpm: number;
  /** Detectors that landed on this BPM (within a hundredth). */
  sources: string[];
}

export interface SegmentGridDetection {
  start: number;
  end: number;
  /** Distinct tempo candidates, most-agreed-upon first. */
  candidates: SegmentBpmCandidate[];
  /** The meter BeatNet heard inside the span. Undefined when the
   *  experimental server isn't running, or when it wasn't confident. */
  meter?: string;
  /** Detectors that ran but failed, for the "nothing came back" case. */
  failures: { source: string; error: string }[];
}

/** Why a span can't be analysed, or null when it can. Same wording the button
 *  title uses, so the disabled state always explains itself. */
export function segmentTooShortReason(start: number, end: number): string | null {
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return 'This segment has no audio to read.';
  if (span < MIN_DETECT_SECONDS) {
    return `Needs at least ${MIN_DETECT_SECONDS}s of audio to read a tempo — this segment is ${span.toFixed(1)}s.`;
  }
  return null;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'error' in data)
      ? String((data as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

/** Did the server actually answer about the span we asked for?
 *
 *  A server that predates ranged detection ignores `start`/`end` and replies
 *  about the whole file — and a whole-song tempo presented as one segment's is
 *  precisely the wrong number this endpoint exists to avoid. It looks entirely
 *  plausible on screen, so it has to be caught here rather than trusted.
 *  Ranged replies carry `range` back; whole-song replies never do.
 */
function answeredAboutRange(
  result: { range?: { start: number; end: number } } | null | undefined,
  start: number,
  end: number,
): boolean {
  const echoed = result?.range;
  if (!echoed) return false;
  // A millisecond of slack: the request is rounded to ms before it is sent.
  return Math.abs(echoed.start - start) < 0.002 && Math.abs(echoed.end - end) < 0.002;
}

/** Fold every detector's BPM into distinct candidates, most votes first. Ties
 *  keep server order, which is priority order. */
function foldCandidates(result: BpmDetectionResult | null): {
  candidates: SegmentBpmCandidate[];
  failures: { source: string; error: string }[];
} {
  const candidates: SegmentBpmCandidate[] = [];
  const failures: { source: string; error: string }[] = [];

  for (const algorithm of result?.algorithms ?? []) {
    if (!algorithm.ok || !Number.isFinite(algorithm.bpm) || !algorithm.bpm) {
      failures.push({ source: algorithm.source, error: algorithm.error ?? 'no tempo' });
      continue;
    }
    const bpm = Math.round(algorithm.bpm * 100) / 100;
    const existing = candidates.find((c) => Math.abs(c.bpm - bpm) < 0.005);
    if (existing) existing.sources.push(algorithm.source);
    else candidates.push({ bpm, sources: [algorithm.source] });
  }

  // Stable sort: Array.prototype.sort is stable in every engine we target, so
  // equal vote counts keep the detectors' own priority order.
  candidates.sort((a, b) => b.sources.length - a.sources.length);
  return { candidates, failures };
}

/**
 * Read one segment's tempo and meter off its own audio.
 *
 * Throws with the server's own explanation when the span is unusable (too
 * short, past the end of the file) or the BPM server is down — the caller
 * shows that text rather than a generic failure. A missing BeatNet server is
 * NOT an error: the meter is simply absent.
 */
export async function detectSegmentGrid(
  slug: string,
  start: number,
  end: number,
): Promise<SegmentGridDetection> {
  const tooShort = segmentTooShortReason(start, end);
  if (tooShort) throw new Error(tooShort);

  const range = { slug, start, end };

  const [bpm, beatnet] = await Promise.all([
    postJson('/api/bpm/detect', range) as Promise<BpmDetectionResult | null>,
    // Experimental and often absent. Its failure must not sink the tempo.
    (postJson('/api/beatnet/detect', range) as Promise<BeatnetDetectionResult | null>)
      .catch(() => null),
  ]);

  if (!answeredAboutRange(bpm, start, end)) {
    throw new Error(
      'The tempo server answered about the whole song, not this segment — it is '
      + 'running a build from before per-segment detection. Restart it: '
      + 'python tools/python/bpm_server.py',
    );
  }

  const { candidates, failures } = foldCandidates(bpm);
  // Same rule for the meter, but silently: BeatNet is optional, so an old one
  // costs us the meter rather than the whole detection. Taking its song-wide
  // meter would be the same lie in a smaller field.
  const ranged = answeredAboutRange(beatnet, start, end);
  const meter = ranged && beatnet?.result?.ok ? beatnet.result.meter ?? undefined : undefined;

  return { start, end, candidates, meter: meter || undefined, failures };
}
