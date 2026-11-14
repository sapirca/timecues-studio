import { describe, it, expect } from 'vitest';
import { karaokeRowsOf, type KaraokeHitRow, type KaraokeNoteRow } from './karaokeRows';

describe('karaokeRowsOf — what a layer lights', () => {
  it('gives drum hits one hit row per kit piece, low to high, time-sorted', () => {
    const rows = karaokeRowsOf('d', 'Drum hits', '#fff', [
      { time: 2, label: 'hat', velocity: 60 },
      { time: 1, label: 'kick' },
      { time: 0.5, label: 'kick', velocity: 400 },
      { time: 3, label: 'drop' },
    ]) as KaraokeHitRow[];
    expect(rows.map((r) => [r.key, r.kind, r.shape])).toEqual([
      ['d:kick', 'hits', 'circle'],
      ['d:hat', 'hits', 'triangle'],
    ]);
    // Clamped, defaulted, sorted.
    expect(rows[0].hits).toEqual([{ time: 0.5, velocity: 127 }, { time: 1, velocity: 96 }]);
  });

  it('gives pitched cues one note row, whatever their labels say', () => {
    const [row] = karaokeRowsOf('b', 'Bass notes', '#a78bfa', [
      { time: 1, label: 'E2', note: 40, velocity: 100, decay: 0.3 },
      { time: 0, label: 'A2', note: 45 },
      // A note labelled like a drum is still a note: the pitch decides.
      { time: 2, label: 'kick', note: 36 },
    ]) as KaraokeNoteRow[];
    expect(row).toMatchObject({ kind: 'notes', key: 'b:notes', name: 'Bass notes', lo: 36, hi: 45 });
    expect(row.notes.map((n) => n.midi)).toEqual([45, 40, 36]);
  });

  it('rings a note for its decay, else until the next note, never past 1.5 s', () => {
    const [row] = karaokeRowsOf('b', 'B', '#fff', [
      { time: 0, label: 'E2', note: 40 },
      { time: 0.5, label: 'E2', note: 40, decay: 0.2 },
      { time: 4, label: 'E2', note: 40 },
    ]) as KaraokeNoteRow[];
    expect(row.notes.map((n) => +(n.end - n.time).toFixed(3))).toEqual([0.5, 0.2, 1.5]);
  });

  it('paints a note row in the colour its notes carry and drops the stem tag', () => {
    const [row] = karaokeRowsOf('b', 'Bass notes (bass)', '#f87171', [
      { time: 0, label: 'E2', note: 40, color: '#a78bfa' },
    ]) as KaraokeNoteRow[];
    expect([row.name, row.color]).toEqual(['Bass notes', '#a78bfa']);
  });

  it('is empty for a layer with nothing to light', () => {
    expect(karaokeRowsOf('x', 'Sections', '#fff', [{ time: 1, label: 'chorus' }])).toEqual([]);
  });
});
