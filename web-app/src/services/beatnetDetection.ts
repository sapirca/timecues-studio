// BeatNet CUE-family detector — talks to the Python BeatNet server
// (proxied at /api/beatnet). Sibling to bpmDetection.ts.
//
// Experimental: gated by `experimentalCueExtras` user setting and the
// `experimental-models` docker compose profile being up. Returns null in
// the unreachable case instead of throwing.

import type { BpmAlgorithmResult } from './bpmDetection';

/** BeatNet adds two fields the existing librosa/madmom detectors don't have:
 *  per-bar downbeats and a song-level meter (e.g. "4/4"). Shape extends
 *  `BpmAlgorithmResult` so the existing chip UI can render it the same way. */
export interface BeatnetAlgorithmResult extends BpmAlgorithmResult {
  source: 'beatnet';
  /** Subset of beat_times that BeatNet labelled as downbeats. */
  downbeats?: number[];
  /** Song-level meter inferred from the per-beat position labels (e.g. "4/4",
   *  "3/4"). Null when too few bars to be confident. */
  meter?: string | null;
}

export interface BeatnetDetectionResult {
  slug: string;
  audio_file: string;
  duration: number;
  result: BeatnetAlgorithmResult;
  computed_at: string;
}

/** Read a cached BeatNet detection. Returns null when no cache exists or the
 *  server isn't reachable. */
export async function loadCachedBeatnet(slug: string): Promise<BeatnetDetectionResult | null> {
  try {
    const res = await fetch(`/api/beatnet/detect/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'result' in data) ? data as BeatnetDetectionResult : null;
  } catch {
    return null;
  }
}

export interface BeatnetHealth {
  ok: boolean;
  beatnetOk: boolean;
  numpyOk: boolean;
}

/** Probe the BeatNet server for dependency availability. Returns null when
 *  the server isn't reachable at all (experimental profile not running). */
export async function beatnetHealth(): Promise<BeatnetHealth | null> {
  try {
    const res = await fetch('/api/beatnet/health');
    if (!res.ok) return null;
    return await res.json() as BeatnetHealth;
  } catch {
    return null;
  }
}

/** Warm the BeatNet estimator without running detection. Same shape as
 *  `initializeSpanAlgorithm` so the "Initialize models" panel can poll both
 *  families uniformly. */
export async function initializeBeatnet(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/beatnet/initialize', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: !!data?.ok, error: data?.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Run BeatNet on the song. `force=true` skips the cache. */
export async function runBeatnetDetection(slug: string, force = false): Promise<BeatnetDetectionResult | null> {
  try {
    const res = await fetch('/api/beatnet/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, force }),
    });
    if (!res.ok) return null;
    return await res.json() as BeatnetDetectionResult;
  } catch {
    return null;
  }
}
