// Drum-hit presentation for the `drum-transients` detector: which colour each
// drum draws in, and how a raw cue becomes an algo-lane section.
//
// Shared by both roads a cue-extras result takes into the viz — the cache read
// in InspectorPageV2 and the run path in runTool — because each used to project
// a cue to `{time, endTime, type, label}` on its own, and each silently dropped
// `velocity` on the way. One mapper means the two can't disagree again.

export type DrumLabel = 'kick' | 'snare' | 'hat';

/** One hue per drum, far apart on the wheel so a dense lane still reads at a
 *  glance: warm for the low end, cool for the backbeat, bright for the top. */
export const DRUM_HIT_COLORS: Record<DrumLabel, string> = {
  kick:  '#f87171',
  snare: '#38bdf8',
  hat:   '#a3e635',
};

export function isDrumLabel(label: string): label is DrumLabel {
  return label === 'kick' || label === 'snare' || label === 'hat';
}

export interface CueSection {
  time: number;
  endTime: number;
  type: string;
  label: string;
  /** Per-drum loudness, 1-127. Present only on drum-transients cues. */
  velocity?: number;
  /** Level against the loudest hit in the track, dB (<= 0). Drum cues only. */
  levelDb?: number;
  color?: string;
}

interface RawCue {
  time: number;
  label: string;
  velocity?: number;
  levelDb?: number;
}

/** Project a cue-extras cue to a zero-width lane section, keeping the drum
 *  fields and colouring drum hits by drum. Non-drum cues (key changes, chords,
 *  plain onsets) come out exactly as before. */
export function cueToSection(c: RawCue): CueSection {
  const section: CueSection = { time: c.time, endTime: c.time, type: 'cue', label: c.label };
  if (typeof c.velocity === 'number') section.velocity = c.velocity;
  if (typeof c.levelDb === 'number') section.levelDb = c.levelDb;
  if (isDrumLabel(c.label)) section.color = DRUM_HIT_COLORS[c.label];
  return section;
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
