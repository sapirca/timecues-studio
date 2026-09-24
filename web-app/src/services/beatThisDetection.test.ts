import { describe, it, expect } from 'vitest';
import { proposeGridFromDetection } from './beatThisDetection';
import type { BeatThisDetectionResult, FittedSegment } from './beatThisDetection';

function detection(segments: FittedSegment[], ok = true): BeatThisDetectionResult {
  return {
    slug: 'song',
    audio_file: 'song.mp3',
    duration: 300,
    computed_at: '2026-09-10T00:00:00+00:00',
    result: {
      source: 'beat-this',
      ok,
      bpm: segments[0]?.bpm,
      beat_times: [],
      downbeats: [],
      segments,
      summary: {
        segments: segments.length,
        tempo_changes: segments.filter((s) => s.reason === 'tempo').length,
        phase_shifts: segments.filter((s) => s.reason === 'shift').length,
        constant_tempo: segments.every((s) => s.reason !== 'tempo'),
      },
    },
  };
}

const seg = (over: Partial<FittedSegment>): FittedSegment => ({
  start: 0, end: 60, bpm: 138, time_signature: '4/4', beats: 138, reason: 'opening', ...over,
});

describe('proposeGridFromDetection', () => {
  it('returns null when there is nothing to adopt', () => {
    expect(proposeGridFromDetection(null)).toBeNull();
    expect(proposeGridFromDetection(detection([]))).toBeNull();
    expect(proposeGridFromDetection(detection([seg({})], false))).toBeNull();
  });

  it('splits the opening segment out into the song\'s own three fields', () => {
    // The grid model stores the opening implicitly as gridOffset/bpm/
    // timeSignature and only the splits after it — so three fitted segments
    // must become one triple plus TWO stored segments, not three.
    const proposal = proposeGridFromDetection(detection([
      seg({ start: 0.24, bpm: 138, time_signature: '4/4' }),
      seg({ start: 31.5, bpm: 138, reason: 'shift' }),
      seg({ start: 227.1, bpm: 145, reason: 'tempo' }),
    ]))!;

    expect(proposal.gridOffset).toBe(0.24);
    expect(proposal.bpm).toBe(138);
    expect(proposal.timeSignature).toBe('4/4');
    expect(proposal.gridSegments).toHaveLength(2);
    expect(proposal.gridSegments.map((s) => s.start)).toEqual([31.5, 227.1]);
    expect(proposal.gridSegments[1].bpm).toBe(145);
  });

  it('gives every stored segment a unique id', () => {
    const proposal = proposeGridFromDetection(detection([
      seg({}), seg({ start: 31.5, reason: 'shift' }), seg({ start: 62.0, reason: 'shift' }),
    ]))!;
    const ids = proposal.gridSegments.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the caller\'s meter when the fitter would not name one', () => {
    // The fitter returns null rather than guessing 4/4, and GridSegment has
    // no way to say "unknown" — so the caller's current value stands in.
    const proposal = proposeGridFromDetection(detection([
      seg({ time_signature: null }),
      seg({ start: 31.5, time_signature: null, reason: 'shift' }),
    ]), '3/4')!;

    expect(proposal.timeSignature).toBe('3/4');
    expect(proposal.gridSegments[0].timeSignature).toBe('3/4');
  });

  it('carries the summary through so the UI can say "restarts, but never changes tempo"', () => {
    const proposal = proposeGridFromDetection(detection([
      seg({}), seg({ start: 31.5, reason: 'shift' }),
    ]))!;
    expect(proposal.summary.constant_tempo).toBe(true);
    expect(proposal.summary.phase_shifts).toBe(1);
    expect(proposal.summary.tempo_changes).toBe(0);
  });
});
