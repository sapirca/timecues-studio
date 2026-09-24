import { describe, it, expect } from 'vitest';
import {
  makeEmptySongInfo,
  effectiveGridMode,
  getActiveBeatOverrideCount,
  isMapMode,
  sanitizeSongInfo,
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

describe('reset-grid behavior (mode-switch safety)', () => {
  it('switching to static and clearing pinned beats zeros the active count', () => {
    // Curator was in Hand-placed mode with pinned beats; clicks Reset Grid.
    const before: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'manual',
      beatOverrides: { '4': 2.0, '8': 4.1 },
    };
    expect(getActiveBeatOverrideCount(before)).toBe(2);

    // The Reset Grid handler does: mode → static, overrides → {}.
    const after: SongInfo = { ...before, gridMode: 'static', beatOverrides: {} };
    expect(getActiveBeatOverrideCount(after)).toBe(0);
    expect(effectiveGridMode(after)).toBe('static');
  });

  it('makeEmptySongInfo seeds the safe defaults', () => {
    const info = makeEmptySongInfo('x');
    expect(info.gridMode).toBe('static');
    expect(info.beatOverrides).toEqual({});
    expect(getActiveBeatOverrideCount(info)).toBe(0);
  });
});

describe('getActiveBeatOverrideCount', () => {
  it('returns 0 outside Manual mode regardless of leftover entries', () => {
    const info: SongInfo = {
      song: 's', timeSignature: '4/4', gridOffset: 0, updated_at: '',
      gridMode: 'mapped',
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

// ─── isMapMode — who owns tempo and meter ────────────────────────────────────
//
// This predicate decides whether the Song-setup panel shows a song-level BPM
// field at all. In a tempo map the number belongs to each segment, so leaving
// the song-level field up would give the opening segment's tempo two controls
// that disagree the moment one of them is used.

describe('isMapMode', () => {
  const info = (patch: Partial<SongInfo>): SongInfo => ({ ...makeEmptySongInfo('s'), ...patch });

  it('is true in Mapped', () => {
    expect(isMapMode(info({ gridMode: 'mapped' }))).toBe(true);
  });

  it('is true for Hand-placed riding a Mapped base', () => {
    expect(isMapMode(info({ gridMode: 'manual', manualBaseGridMode: 'mapped' }))).toBe(true);
  });

  it('is false for Hand-placed on any other base', () => {
    expect(isMapMode(info({ gridMode: 'manual', manualBaseGridMode: 'static' }))).toBe(false);
    // Base not yet chosen — nothing is riding a map.
    expect(isMapMode(info({ gridMode: 'manual' }))).toBe(false);
  });

  it('is false in Steady, even with splits on disk', () => {
    const splits = [{ id: 'gs_a', start: 40, bpm: 90, timeSignature: '4/4' }];
    expect(isMapMode(info({ gridMode: 'static', gridSegments: splits }))).toBe(false);
  });

  it('is false for a missing song', () => {
    expect(isMapMode(null)).toBe(false);
    expect(isMapMode(undefined)).toBe(false);
  });
});

// ─── Reading a corpus an older build wrote ───────────────────────────────────
// Drifting is gone, but the files it wrote are still on disk — in the team
// corpus, in a user's localStorage, and inside every dataset exported before
// the removal. What matters is that such a document loads as a grid this
// build actually has, and that saving it back writes the leftovers out.

describe('sanitizeSongInfo', () => {
  const stale = (extra: Record<string, unknown> = {}): SongInfo => ({
    song: 's',
    bpm: 120,
    timeSignature: '4/4',
    gridOffset: 0,
    updated_at: '',
    ...extra,
  } as SongInfo);

  it('drops tempoAnchors', () => {
    const out = sanitizeSongInfo(stale({
      tempoAnchors: [{ timestamp: 10, bpm: 121 }, { timestamp: 30, bpm: 119 }],
    }));
    expect('tempoAnchors' in out).toBe(false);
  });

  it('renames the retired Drifting mode to the grid it actually draws', () => {
    const out = sanitizeSongInfo(stale({ gridMode: 'dynamic' }));
    expect(out.gridMode).toBe('static');
    expect(effectiveGridMode(out)).toBe('static');
  });

  it('renames a Hand-placed base that pointed at Drifting', () => {
    const out = sanitizeSongInfo(stale({
      gridMode: 'manual', manualBaseGridMode: 'dynamic',
    }));
    // The mode itself is untouched — only the base it rode on was retired.
    expect(out.gridMode).toBe('manual');
    expect(out.manualBaseGridMode).toBe('static');
  });

  it('keeps every field the current build still reads', () => {
    const splits = [{ id: 'gs_a', start: 40, bpm: 90, timeSignature: '4/4' }];
    const out = sanitizeSongInfo(stale({
      gridMode: 'dynamic',
      tempoAnchors: [{ timestamp: 10, bpm: 121 }],
      gridSegments: splits,
      beatOverrides: { '8': 4.125 },
      title: 'Old Song',
      artist: 'Someone',
      annotatorGridMode: true,
    }));
    expect(out.gridSegments).toEqual(splits);
    expect(out.beatOverrides).toEqual({ '8': 4.125 });
    expect(out.title).toBe('Old Song');
    expect(out.artist).toBe('Someone');
    expect(out.annotatorGridMode).toBe(true);
    expect(out.bpm).toBe(120);
    expect(out.gridOffset).toBe(0);
  });

  it('returns the SAME object when there is nothing to clean', () => {
    // Identity is the signal callers use to skip a re-render, so a clean
    // corpus must not churn one on every load.
    const clean = stale({ gridMode: 'mapped' });
    expect(sanitizeSongInfo(clean)).toBe(clean);
    expect(sanitizeSongInfo(makeEmptySongInfo('s'))).toBeTruthy();
  });

  it('does not mutate the document it was handed', () => {
    const input = stale({ gridMode: 'dynamic', tempoAnchors: [{ timestamp: 10, bpm: 121 }] });
    sanitizeSongInfo(input);
    expect((input as unknown as Record<string, unknown>).tempoAnchors).toHaveLength(1);
    expect(input.gridMode).toBe('dynamic');
  });

  it('is idempotent', () => {
    const once = sanitizeSongInfo(stale({ gridMode: 'dynamic', tempoAnchors: [] }));
    expect(sanitizeSongInfo(once)).toBe(once);
  });
});
