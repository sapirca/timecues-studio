import { describe, it, expect } from 'vitest';
import {
  updateManualBeatOverride,
  clearBeatOverride,
  anchorsFromTempoCurve,
} from './anchorEdit';
import type { SongInfo } from '../types/songInfo';

// ─── Manual adjustment: per-beat override map ────────────────────────────────

function makeSongInfo(partial: Partial<SongInfo> = {}): SongInfo {
  return {
    song: 's',
    timeSignature: '4/4',
    gridOffset: 0,
    gridMode: 'manual',
    bpm: 120,
    tempoAnchors: [],
    beatOverrides: {},
    updated_at: '',
    ...partial,
  };
}

describe('updateManualBeatOverride', () => {
  it('writes a new entry without touching tempoAnchors', () => {
    const info = makeSongInfo();
    const next = updateManualBeatOverride(info, 7.012, 14);
    expect(next['14']).toBeCloseTo(7.012, 9);
    // Returns a new map; original is untouched.
    expect(info.beatOverrides).toEqual({});
  });

  it('preserves pre-existing overrides on other beats', () => {
    const info = makeSongInfo({ beatOverrides: { '5': 2.5 } });
    const next = updateManualBeatOverride(info, 7.012, 14);
    expect(next['5']).toBeCloseTo(2.5, 9);
    expect(next['14']).toBeCloseTo(7.012, 9);
  });

  it('clamps tNew so it cannot cross beat (n - 1) at the macro grid', () => {
    // 120 BPM, gridOffset=0 → beats at 0.0, 0.5, 1.0, 1.5, ...
    // Beat 3 is at 1.5s. The previous beat (2) is at 1.0s. A drop at 0.8s
    // (beyond the n-1 line) must clamp to ≥ 1.0 + clearance.
    const info = makeSongInfo();
    const next = updateManualBeatOverride(info, 0.8, 3);
    expect(next['3']).toBeGreaterThan(1.0);
    expect(next['3']).toBeLessThan(1.5);
  });

  it('clamps against an overridden neighbour, not the macro position', () => {
    // Beat 4 (macro 2.0s) has been pulled to 2.3s. A drop on beat 5
    // anywhere before 2.3s must clamp to ≥ 2.3 + clearance.
    const info = makeSongInfo({ beatOverrides: { '4': 2.3 } });
    const next = updateManualBeatOverride(info, 2.1, 5);
    expect(next['5']).toBeGreaterThan(2.3);
  });

  it('non-integer beat indices are rejected (returns the current map)', () => {
    const info = makeSongInfo({ beatOverrides: { '5': 2.5 } });
    const next = updateManualBeatOverride(info, 3.0, 5.5);
    expect(next).toEqual({ '5': 2.5 });
  });

  it('non-finite tNew is rejected', () => {
    const info = makeSongInfo({ beatOverrides: { '5': 2.5 } });
    const next = updateManualBeatOverride(info, Number.NaN, 6);
    expect(next).toEqual({ '5': 2.5 });
  });

  it('writes raw (clamped to ≥ 0) when no macro BPM is set', () => {
    const info = makeSongInfo({ bpm: undefined });
    const next = updateManualBeatOverride(info, 9.5, 3);
    expect(next['3']).toBeCloseTo(9.5, 9);
  });

  it('updating an already-overridden beat replaces the entry in place', () => {
    const info = makeSongInfo({ beatOverrides: { '14': 7.0 } });
    const next = updateManualBeatOverride(info, 7.05, 14);
    expect(Object.keys(next)).toEqual(['14']);
    expect(next['14']).toBeCloseTo(7.05, 9);
  });
});

describe('clearBeatOverride', () => {
  it('removes the entry for the given beat index', () => {
    const out = clearBeatOverride({ '5': 2.5, '14': 7.0 }, 14);
    expect(out).toEqual({ '5': 2.5 });
  });

  it('returns a clone (does not mutate) and is a no-op for missing keys', () => {
    const src = { '5': 2.5 };
    const out = clearBeatOverride(src, 99);
    expect(out).toEqual({ '5': 2.5 });
    expect(out).not.toBe(src);
  });

  it('handles undefined input', () => {
    expect(clearBeatOverride(undefined, 1)).toEqual({});
  });
});

// ─── Dynamic-mode derivation ─────────────────────────────────────────────────

describe('anchorsFromTempoCurve', () => {
  it('emits one anchor for a flat tempo curve', () => {
    const curve = {
      frameTimes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      bpms:       [120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120],
    };
    const out = anchorsFromTempoCurve(curve, { thresholdBpm: 5 });
    expect(out.length).toBe(1);
    expect(out[0].bpm).toBeCloseTo(120, 6);
  });

  it('emits additional anchors where tempo drifts past threshold', () => {
    // Step from 120 to 140 BPM halfway through.
    const t: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 40; i++) {
      t.push(i);                            // 1 second per frame
      b.push(i < 20 ? 120 : 140);
    }
    const out = anchorsFromTempoCurve({ frameTimes: t, bpms: b }, {
      thresholdBpm: 5,
      minSpacingSec: 4,
      windowFrames: 5,
    });
    // First anchor at the start; at least one more covering the tempo step.
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].bpm).toBeCloseTo(120, 0);
    expect(out[out.length - 1].bpm).toBeCloseTo(140, 0);
  });

  it('respects minSpacingSec', () => {
    // Alternating fast jitter — anchors should still be spaced apart.
    const t: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 50; i++) {
      t.push(i * 0.5);  // 2 fps
      b.push(120 + (i % 2 === 0 ? 0 : 20));
    }
    const out = anchorsFromTempoCurve({ frameTimes: t, bpms: b }, {
      thresholdBpm: 5,
      minSpacingSec: 4,
      windowFrames: 3,
    });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].timestamp - out[i - 1].timestamp).toBeGreaterThanOrEqual(4);
    }
  });
});
