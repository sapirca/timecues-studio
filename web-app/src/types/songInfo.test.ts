import { describe, it, expect } from 'vitest';
import {
  makeEmptySongInfo,
  effectiveGridMode,
  isAnchorMode,
  getActiveAnchorCount,
  getActiveBeatOverrideCount,
  normalizeAnchors,
  type SongInfo,
} from './songInfo';

// ─── Section 8.4 — Mode Switching Safety ─────────────────────────────────────
// These tests exercise the pure data helpers that the UI uses when the
// curator hits "Reset Grid" or flips the mode selector. They don't depend
// on React state — the reducer-style transforms are exercised directly.

describe('effectiveGridMode', () => {
  it('returns "static" for legacy songs with no gridMode field', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
    };
    expect(effectiveGridMode(info)).toBe('static');
  });

  it('returns the explicit value when present', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'manual',
    };
    expect(effectiveGridMode(info)).toBe('manual');
  });
});

describe('isAnchorMode', () => {
  it('is true for dynamic and manual', () => {
    expect(isAnchorMode('dynamic')).toBe(true);
    expect(isAnchorMode('manual')).toBe(true);
  });
  it('is false for static and undefined', () => {
    expect(isAnchorMode('static')).toBe(false);
    expect(isAnchorMode(undefined)).toBe(false);
  });
});

describe('getActiveAnchorCount', () => {
  it('returns 0 in static mode regardless of leftover entries', () => {
    // Simulates "Reset Grid": mode flipped to static, but anchors array
    // hasn't been cleared yet. The UI must treat this as zero anchors.
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'static',
      tempoAnchors: [{ timestamp: 1.0, bpm: 120 }],
    };
    expect(getActiveAnchorCount(info)).toBe(0);
  });

  it('counts anchors in dynamic mode', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'dynamic',
      tempoAnchors: [
        { timestamp: 0.0, bpm: 120 },
        { timestamp: 5.0, bpm: 130 },
      ],
    };
    expect(getActiveAnchorCount(info)).toBe(2);
  });

  it('counts anchors in manual mode', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'manual',
      tempoAnchors: [{ timestamp: 1.0, bpm: 120 }],
    };
    expect(getActiveAnchorCount(info)).toBe(1);
  });
});

describe('reset-grid behavior (mode-switch safety)', () => {
  it('switching to static and clearing anchors zeros the active count', () => {
    // Curator was in manual mode with anchors; clicks Reset Grid.
    const before: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'manual',
      tempoAnchors: [
        { timestamp: 1.0, bpm: 120 },
        { timestamp: 5.0, bpm: 130 },
      ],
    };
    expect(getActiveAnchorCount(before)).toBe(2);

    // The Reset Grid handler does: mode → static, anchors → [].
    const after: SongInfo = { ...before, gridMode: 'static', tempoAnchors: [] };
    expect(getActiveAnchorCount(after)).toBe(0);
    expect(effectiveGridMode(after)).toBe('static');
  });

  it('makeEmptySongInfo seeds the safe defaults', () => {
    const info = makeEmptySongInfo('x');
    expect(info.gridMode).toBe('static');
    expect(info.tempoAnchors).toEqual([]);
    expect(info.beatOverrides).toEqual({});
    expect(getActiveAnchorCount(info)).toBe(0);
    expect(getActiveBeatOverrideCount(info)).toBe(0);
  });
});

describe('getActiveBeatOverrideCount', () => {
  it('returns 0 outside Manual mode regardless of leftover entries', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'dynamic',
      beatOverrides: { '5': 2.5, '14': 7.0 },
    };
    expect(getActiveBeatOverrideCount(info)).toBe(0);
  });

  it('counts entries in Manual mode', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'manual',
      beatOverrides: { '5': 2.5, '14': 7.0, '22': 11.0 },
    };
    expect(getActiveBeatOverrideCount(info)).toBe(3);
  });

  it('returns 0 when the map is missing or empty', () => {
    const a: SongInfo = { song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '', gridMode: 'manual' };
    const b: SongInfo = { ...a, beatOverrides: {} };
    expect(getActiveBeatOverrideCount(a)).toBe(0);
    expect(getActiveBeatOverrideCount(b)).toBe(0);
  });
});

describe('normalizeAnchors', () => {
  it('sorts ascending and drops near-duplicates within 20ms', () => {
    const input = [
      { timestamp: 5.000, bpm: 120 },
      { timestamp: 1.000, bpm: 120 },
      { timestamp: 1.015, bpm: 130 },  // within 20ms of the prior → dropped
      { timestamp: 2.000, bpm: 125 },
    ];
    const out = normalizeAnchors(input);
    expect(out.map((a) => a.timestamp)).toEqual([1.000, 2.000, 5.000]);
  });

  it('drops anchors with non-finite or non-positive bpm', () => {
    const out = normalizeAnchors([
      { timestamp: 1.0, bpm: 120 },
      { timestamp: 2.0, bpm: 0 },
      { timestamp: 3.0, bpm: Number.NaN },
      { timestamp: 4.0, bpm: -50 },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].timestamp).toBe(1.0);
  });
});
