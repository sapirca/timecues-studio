// Beat This! CUE-family detector — talks to the Python Beat This! server
// (proxied at /api/beat-this). Sibling to beatnetDetection.ts.
//
// What makes this one different from every other detector we call: it comes
// back with grid SEGMENTS, not just beats. Fitting a flat beat list into
// "three segments at 138 BPM whose count restarts at 0:31 and 3:47" happens
// server-side in tools/python/beat_segments.py, so the answer arrives in the
// same shape the grid model already speaks (`GridSegment`) and nothing here
// has to redo the arithmetic.
//
// Experimental: gated by `experimentalCueExtras` and the
// `experimental-models` docker compose profile being up. Returns null in the
// unreachable case instead of throwing.

import type { BpmAlgorithmResult } from './bpmDetection';
import type { GridSegment } from '../types/songInfo';
import { makeGridSegmentId } from '../types/songInfo';

/** Why the fitter cut a segment here.
 *  - `opening` — the song's own first segment, not a cut at all.
 *  - `tempo`   — the tempo settled at a new value and stayed there.
 *  - `shift`   — the tempo is unchanged but the downbeat moved. This is the
 *                common one in sequenced music: the clock never varies, the
 *                arrangement was cut and reassembled after rendering. */
export type SegmentReason = 'opening' | 'tempo' | 'shift';

/** One fitted segment, as the server sends it. `start` is bar 1 beat 1 —
 *  the same contract as `GridSegment` — and is snapped to the tracker's own
 *  downbeat where it found one. */
export interface FittedSegment {
  start: number;
  end: number;
  bpm: number;
  /** '4/4' | '3/4' | … or null when there weren't two full bars to read it
   *  from. Null is an honest unknown, NOT a reason to assume 4/4. */
  time_signature: string | null;
  beats: number;
  reason: SegmentReason;
}

export interface FitSummary {
  segments: number;
  tempo_changes: number;
  phase_shifts: number;
  /** True when the grid restarts but the tempo never actually moves — the
   *  normal shape of a trance / techno track, and worth saying out loud
   *  because it means the BPM chip was right all along. */
  constant_tempo: boolean;
}

export interface BeatThisAlgorithmResult extends BpmAlgorithmResult {
  source: 'beat-this';
  downbeats?: number[];
  meter?: string | null;
  segments?: FittedSegment[];
  summary?: FitSummary;
}

export interface BeatThisDetectionResult {
  slug: string;
  audio_file: string;
  duration: number;
  result: BeatThisAlgorithmResult;
  computed_at: string;
  /** Echoed back only on a ranged detection (one grid segment) — see
   *  segmentGridDetection.ts for why its absence has to be checked. */
  range?: { start: number; end: number };
}

/** Read a cached Beat This! detection. Null when no cache exists or the
 *  server isn't reachable. */
export async function loadCachedBeatThis(slug: string): Promise<BeatThisDetectionResult | null> {
  try {
    const res = await fetch(`/api/beat-this/detect/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'result' in data) ? data as BeatThisDetectionResult : null;
  } catch {
    return null;
  }
}

export interface BeatThisHealth {
  ok: boolean;
  beatThisOk: boolean;
  numpyOk: boolean;
  checkpoint?: string;
  device?: string;
}

/** Probe the Beat This! server for dependency availability. Null when the
 *  server isn't reachable at all (experimental profile not running). */
export async function beatThisHealth(): Promise<BeatThisHealth | null> {
  try {
    const res = await fetch('/api/beat-this/health');
    if (!res.ok) return null;
    return await res.json() as BeatThisHealth;
  } catch {
    return null;
  }
}

/** Warm the model without running detection. Same shape as
 *  `initializeBeatnet` so the "Initialize models" panel polls both the same
 *  way. */
export async function initializeBeatThis(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/beat-this/initialize', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: !!data?.ok, error: data?.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Run Beat This! on the song. `force=true` skips the cache. */
export async function runBeatThisDetection(slug: string, force = false): Promise<BeatThisDetectionResult | null> {
  try {
    const res = await fetch('/api/beat-this/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, force }),
    });
    if (!res.ok) return null;
    return await res.json() as BeatThisDetectionResult;
  } catch {
    return null;
  }
}

/** What a song's stored grid would become if the fit were adopted.
 *
 *  The grid model stores the opening segment implicitly, as the song's own
 *  `gridOffset` / `bpm` / `timeSignature`, and only the splits AFTER it in
 *  `gridSegments` — so a fit of N segments becomes one opening triple plus
 *  N-1 stored segments. Keeping that split here means the caller can write
 *  the result straight onto a SongInfo without knowing the rule. */
export interface ProposedGrid {
  /** The song's own three fields, from the opening segment. */
  gridOffset: number;
  bpm: number;
  timeSignature: string;
  /** Everything after the opening, ready for `SongInfo.gridSegments`. */
  gridSegments: GridSegment[];
  summary: FitSummary;
}

/** Turn a detection into a grid proposal, or null if it has no segments.
 *
 *  `fallbackTimeSignature` fills in for a segment the fitter refused to name
 *  a meter for — it returns null rather than guessing 4/4, and a GridSegment
 *  has no way to express "unknown", so the decision surfaces here where the
 *  caller can pass the song's current value instead of a constant. */
export function proposeGridFromDetection(
  detection: BeatThisDetectionResult | null,
  fallbackTimeSignature = '4/4',
): ProposedGrid | null {
  const segments = detection?.result?.segments;
  if (!detection?.result?.ok || !segments?.length) return null;

  const [opening, ...rest] = segments;
  return {
    gridOffset:    opening.start,
    bpm:           opening.bpm,
    timeSignature: opening.time_signature ?? fallbackTimeSignature,
    gridSegments: rest.map((seg) => ({
      id:            makeGridSegmentId(),
      start:         seg.start,
      bpm:           seg.bpm,
      timeSignature: seg.time_signature ?? fallbackTimeSignature,
    })),
    summary: detection.result.summary ?? {
      segments:       segments.length,
      tempo_changes:  rest.filter((s) => s.reason === 'tempo').length,
      phase_shifts:   rest.filter((s) => s.reason === 'shift').length,
      constant_tempo: rest.every((s) => s.reason !== 'tempo'),
    },
  };
}
