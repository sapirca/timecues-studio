// Struck-hit presentation shared by every cue in the app: the optional hit
// fields (velocity, level, colour, note, decay, importance), how a raw cue
// becomes an algo-lane section, and the hover text for a hit.
//
// Nothing here knows about drums any more. The drum hits themselves come from
// the `drum_transients` custom detector, which sets its colours per drum; the
// app just draws whatever optional fields a cue carries, from any source.

export interface CueSection {
  time: number;
  endTime: number;
  type: string;
  label: string;
  /** How hard the hit was struck, 1-127 — the tick draws this tall. */
  velocity?: number;
  /** Level against the loudest hit in the track, dB (<= 0). */
  levelDb?: number;
  color?: string;
  /** MIDI note number, 0-127 — the lane can be read as a piano roll. */
  note?: number;
  /** Seconds the note rings. */
  decay?: number;
}

/** Project an algorithm's point cue to a zero-width lane section, keeping any
 *  optional hit fields it carries (through the same mapper every other cue
 *  road uses). A cue without them comes out as a plain tick. */
export function cueToSection(c: {
  time: number; label: string; velocity?: number | null; levelDb?: number | null;
  color?: string | null; note?: number | null; decay_ms?: number | null;
}): CueSection {
  const { velocity, levelDb, color, note, decay } = struckHitFields(c);
  return {
    time: c.time, endTime: c.time, type: 'cue', label: c.label,
    ...(velocity !== undefined ? { velocity } : {}),
    ...(levelDb !== undefined ? { levelDb } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(decay !== undefined ? { decay } : {}),
  };
}

/** One transcribed note (basic-pitch's `{time, end, pitch, midi}`) as a lane
 *  section: a tick at its onset named by its pitch, carrying the MIDI number
 *  and how long it rang, so the lane gets the piano roll and the MIDI export
 *  like any other pitched cue. Its amplitude is not a velocity — it is the
 *  model's activation, not how hard the note was played — so none is set. */
export function pitchNoteToSection(n: { time: number; end: number; pitch: string; midi?: number | null }): CueSection {
  const { note, decay } = struckHitFields({ note: n.midi, decay: n.end - n.time });
  return {
    time: n.time, endTime: n.end, type: n.pitch, label: n.pitch,
    ...(note !== undefined ? { note } : {}),
    ...(decay !== undefined ? { decay } : {}),
  };
}

/** Hover text for a drum hit: "kick · velocity 112 · -3.2 dB · C2 · rings 180 ms". */
export function drumHitTitle(s: { label: string; velocity?: number; levelDb?: number; note?: number; decay?: number }): string {
  const parts = [s.label];
  if (typeof s.velocity === 'number') parts.push(`velocity ${s.velocity}`);
  if (typeof s.levelDb === 'number') parts.push(`${s.levelDb.toFixed(1)} dB`);
  if (typeof s.note === 'number') parts.push(midiNoteName(s.note));
  if (typeof s.decay === 'number') parts.push(`rings ${Math.round(s.decay * 1000)} ms`);
  return parts.join(' · ');
}

/** A struck hit's three optional fields, in the one shape every cue carries
 *  (CueItem). Every road a cue takes into a layer — a custom detector's lane,
 *  "Copy to manual layer" from a detector or from a built-in algo row — goes
 *  through here, so none of them can quietly drop one again. Accepts the
 *  detector envelope's snake_case `level_db` as well as `levelDb`, and omits
 *  a field entirely rather than writing it as undefined/null. */
export interface StruckHit {
  velocity?: number;
  levelDb?: number;
  color?: string;
  note?: number;
  /** Seconds. */
  decay?: number;
  importance?: 'critical' | 'optional';
}

export function struckHitFields(src: {
  velocity?: number | null;
  levelDb?: number | null;
  level_db?: number | null;
  color?: string | null;
  note?: number | null;
  /** Seconds (layer shape). */
  decay?: number | null;
  /** Milliseconds (detector envelope). */
  decay_ms?: number | null;
  importance?: string | null;
}): StruckHit {
  const out: StruckHit = {};
  if (typeof src.velocity === 'number' && Number.isFinite(src.velocity)) out.velocity = src.velocity;
  const level = src.levelDb ?? src.level_db;
  if (typeof level === 'number' && Number.isFinite(level)) out.levelDb = level;
  if (typeof src.color === 'string' && src.color) out.color = src.color;
  if (typeof src.note === 'number' && Number.isFinite(src.note)) out.note = src.note;
  const decay = src.decay ?? (typeof src.decay_ms === 'number' ? src.decay_ms / 1000 : undefined);
  if (typeof decay === 'number' && Number.isFinite(decay) && decay > 0) out.decay = decay;
  if (src.importance === 'critical' || src.importance === 'optional') out.importance = src.importance;
  return out;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number → name, middle C (60) = "C4". */
export function midiNoteName(n: number): string {
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** The three kit pieces the drum karaoke lights, low to high. */
export type KitPiece = 'kick' | 'snare' | 'hat';
export const KIT_PIECES: readonly KitPiece[] = ['kick', 'snare', 'hat'];

/** Which kit piece a cue label names, or null. Reads the `drum_transients`
 *  labels (kick / snare / hat) and the common hand-typed spellings of them,
 *  so a layer someone labelled "BD", "Hi-hat" or "clap" lights too. */
export function kitPieceOf(label: string | undefined | null): KitPiece | null {
  const l = (label ?? '').trim().toLowerCase();
  if (!l) return null;
  if (/\b(kick|bd|bass ?drum)\b/.test(l)) return 'kick';
  if (/\b(snare|sd|clap|rim(shot)?)\b/.test(l)) return 'snare';
  if (/(hi-?hats?|\bhats?\b|\bhh\b|\bcymbal|\bride\b|\bcrash\b)/.test(l)) return 'hat';
  return null;
}
