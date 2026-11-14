// What the hit karaoke draws, derived from a cue list. Two row kinds:
//
//  * a HIT row per kit piece (kick / snare / hat) — cues whose label names one.
//    Timing and velocity only; the row's shape lights on the now line.
//  * a NOTE row — cues that carry a pitch (`note`, MIDI). Drawn as a small
//    piano roll: height is pitch, length is how long the note rang.
//
// A cue that is neither (a plain "drop", "chorus") has nothing to light and is
// left out. Deciding from the data, not from which detector made it, is what
// lets a hand-tapped layer, a copy, or any future detector join the karaoke.

import { KIT_PIECES, kitPieceOf, type KitPiece } from './drumHits';

export type HitShape = 'circle' | 'square' | 'triangle';

export interface KaraokeHitRow {
  kind: 'hits';
  key: string;
  name: string;
  color: string;
  shape: HitShape;
  /** Seconds the light takes to fade — a kick booms, a hat ticks. */
  fade: number;
  /** Time-sorted. */
  hits: { time: number; velocity: number }[];
}

export interface KaraokeNote {
  time: number;
  end: number;
  midi: number;
  velocity: number;
}

export interface KaraokeNoteRow {
  kind: 'notes';
  key: string;
  name: string;
  color: string;
  /** Time-sorted. */
  notes: KaraokeNote[];
  /** Lowest and highest pitch in the row — its vertical range. */
  lo: number;
  hi: number;
}

export type KaraokeRow = KaraokeHitRow | KaraokeNoteRow;

const PIECE: Record<KitPiece, { name: string; color: string; shape: HitShape; fade: number }> = {
  kick:  { name: 'Kick',  color: '#f87171', shape: 'circle',   fade: 0.22 },
  snare: { name: 'Snare', color: '#38bdf8', shape: 'square',   fade: 0.16 },
  hat:   { name: 'Hat',   color: '#a3e635', shape: 'triangle', fade: 0.09 },
};

/** A note with no length of its own rings until the next one, but no longer
 *  than this. */
const MAX_IMPLIED_NOTE_S = 1.5;
/** A cue with no velocity lights at a medium level. */
const DEFAULT_VELOCITY = 96;

interface CueLike {
  time: number;
  label: string;
  velocity?: number;
  note?: number;
  /** Seconds the hit rings. */
  decay?: number;
  /** "#rrggbb" the source painted this cue — wins over the layer colour. */
  color?: string;
}

const vel = (v: number | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(127, v)) : DEFAULT_VELOCITY;

/** The karaoke rows one source (a layer or a lane) contributes. Row keys are
 *  prefixed with `sourceId` so rows from two sources never collide. Empty when
 *  the source has neither kit hits nor pitched notes. */
export function karaokeRowsOf(
  sourceId: string,
  sourceName: string,
  sourceColor: string,
  items: readonly CueLike[],
): KaraokeRow[] {
  const rows: KaraokeRow[] = [];
  const pieces: Record<KitPiece, { time: number; velocity: number }[]> = { kick: [], snare: [], hat: [] };
  const pitched: CueLike[] = [];
  for (const it of items) {
    if (!Number.isFinite(it.time)) continue;
    if (typeof it.note === 'number' && Number.isFinite(it.note)) { pitched.push(it); continue; }
    const piece = kitPieceOf(it.label);
    if (piece) pieces[piece].push({ time: it.time, velocity: vel(it.velocity) });
  }
  for (const p of KIT_PIECES) {
    if (!pieces[p].length) continue;
    rows.push({
      kind: 'hits', key: `${sourceId}:${p}`, ...PIECE[p],
      hits: pieces[p].sort((a, b) => a.time - b.time),
    });
  }
  if (pitched.length) {
    const sorted = [...pitched].sort((a, b) => a.time - b.time);
    const notes = sorted.map((it, i): KaraokeNote => {
      const next = sorted[i + 1]?.time ?? it.time + MAX_IMPLIED_NOTE_S;
      const end = typeof it.decay === 'number' && it.decay > 0
        ? it.time + it.decay
        : Math.min(next, it.time + MAX_IMPLIED_NOTE_S);
      return { time: it.time, end: Math.max(end, it.time + 0.02), midi: Math.round(it.note!), velocity: vel(it.velocity) };
    });
    const midis = notes.map((n) => n.midi);
    // The colour the notes themselves carry (a detector paints its own), else
    // the layer's. The name drops a trailing "(bass)" stem tag: the row label
    // is narrow, and the pitch range already says what instrument it is.
    const own = sorted.find((it) => typeof it.color === 'string' && /^#[0-9a-f]{6}$/i.test(it.color))?.color;
    rows.push({
      kind: 'notes', key: `${sourceId}:notes`,
      name: sourceName.replace(/\s*\([^)]*\)\s*$/, '') || sourceName,
      color: own ?? sourceColor,
      notes, lo: Math.min(...midis), hi: Math.max(...midis),
    });
  }
  return rows;
}
