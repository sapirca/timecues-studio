import { describe, it, expect } from 'vitest';
import { gridEditCoalesceKey } from './gridUndo';
import type { SongInfo } from '../types/songInfo';

const base: SongInfo = {
  song: 'track',
  bpm: 120,
  timeSignature: '4/4',
  gridOffset: 0.25,
  updated_at: '2026-01-01T00:00:00.000Z',
};

const at = (patch: Partial<SongInfo>): SongInfo => ({
  ...base,
  ...patch,
  updated_at: '2026-01-01T00:00:01.000Z',
});

describe('gridEditCoalesceKey', () => {
  it('coalesces a run of edits to one typed field', () => {
    expect(gridEditCoalesceKey(base, at({ bpm: 121 }))).toBe('field:bpm');
    expect(gridEditCoalesceKey(at({ bpm: 121 }), at({ bpm: 128 }))).toBe('field:bpm');
    expect(gridEditCoalesceKey(base, at({ title: 'Peter the Wolf' }))).toBe('field:title');
    expect(gridEditCoalesceKey(base, at({ gridOffset: 0.5 }))).toBe('field:gridOffset');
  });

  it('gives a different key per field, so switching fields starts a new step', () => {
    expect(gridEditCoalesceKey(base, at({ bpm: 121 })))
      .not.toBe(gridEditCoalesceKey(base, at({ gridOffset: 0.5 })));
  });

  it('refuses to coalesce a structural edit', () => {
    expect(gridEditCoalesceKey(base, at({ timeSignature: '3/4' }))).toBeNull();
    expect(gridEditCoalesceKey(base, at({ gridSegments: [{ id: 'a', start: 14.4, bpm: 120, timeSignature: '4/4' }] }))).toBeNull();
    expect(gridEditCoalesceKey(base, at({ beatOverrides: { '8': 4.1 } }))).toBeNull();
  });

  it('refuses when a typed field moves alongside anything else', () => {
    expect(gridEditCoalesceKey(base, at({ bpm: 121, timeSignature: '3/4' }))).toBeNull();
    expect(gridEditCoalesceKey(base, at({ bpm: 121, gridOffset: 0.5 }))).toBeNull();
  });

  it('ignores updated_at on its own', () => {
    expect(gridEditCoalesceKey(base, at({}))).toBeNull();
  });

  it('sees a field appearing or disappearing as a change', () => {
    expect(gridEditCoalesceKey(base, at({ artist: 'Toast3d' }))).toBe('field:artist');
    const withArtist = at({ artist: 'Toast3d' });
    const { artist: _dropped, ...withoutArtist } = withArtist;
    expect(gridEditCoalesceKey(withArtist, withoutArtist as SongInfo)).toBe('field:artist');
  });

  it('has no history to coalesce into on the first edit of a song', () => {
    expect(gridEditCoalesceKey(null, base)).toBeNull();
  });
});
