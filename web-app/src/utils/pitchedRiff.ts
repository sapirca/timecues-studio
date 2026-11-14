/**
 * A riff node, read the way Butler writes a line down (Unlocking the Groove,
 * Appendix A and p. 82): attacks placed on a common pulse — sixteenths,
 * numbered 1–16 in the bar, or triplets where the figure swings that way —
 * each note lasting until the next attack, and rests only where the line
 * actually stops. A note may say its pitch (a bass line, a riff) or not (a
 * drum figure, or a line whose notes nobody has named yet): a pitchless note
 * is a HIT, and is as much a part of the line as a named one.
 *
 * Stored as the node's blocks — a `tick` block is a note, `note` (MIDI) its
 * pitch when it has one, `accent` how hard it is struck, `subbeatsPerBeat` the
 * node's pulse. Pure, no React.
 */

import {
  normalizeBoundarySegments,
  riffNodeLengthBeats,
  type RiffBoundarySegment,
  type RiffNode,
} from '../types/annotationLayer';
import { midiNoteName } from './drumHits';

/** Butler's common pulse: four sixteenths to the beat — every node's
 *  default. */
export const PITCHED_STEPS_PER_BEAT = 4;

/** The finest pulse a node can be written on, in steps per beat: 1/64 notes. */
export const MAX_PULSE = 16;

/** One step of `pulse` as the note a musician would name, with the beat a
 *  quarter: 8 → "1/32 note", 6 → "1/16 triplet", 5 → "5 per beat". */
export function pulseNoteName(pulse: number): string {
  const pow2 = (n: number) => n >= 1 && (n & (n - 1)) === 0;
  if (pow2(pulse)) return pulse === 1 ? '1/4 note' : `1/${4 * pulse} note`;
  if (pulse % 3 === 0 && pow2(pulse / 3)) return `1/${(8 * pulse) / 3} triplet`;
  return `${pulse} per beat`;
}

/** The pulses a node can be written on, as steps per beat — any whole
 *  number from 1 to `MAX_PULSE`, named as the fraction of a beat one step is
 *  and the note it makes. Riffs are written in beats and their fractions
 *  only, never in free time. */
export const PULSE_OPTIONS: readonly { value: number; label: string }[] = Array.from(
  { length: MAX_PULSE },
  (_, i) => i + 1,
).map((v) => ({ value: v, label: `${v === 1 ? '1' : `1/${v}`} beat · ${pulseNoteName(v)}` }));

/** What step `i` of a beat on `pulse` is called on the node's ruler: the beat
 *  number on the beat, then its fractions — ¼ ½ ¾, or ⅓ ⅔ for triplets. */
export function stepFractionLabel(i: number, pulse: number): string {
  const k = ((i % pulse) + pulse) % pulse;
  if (k === 0) return String(Math.floor(i / pulse) + 1);
  const names: Record<number, readonly string[]> = {
    2: ['', '½'],
    3: ['', '⅓', '⅔'],
    4: ['', '¼', '½', '¾'],
    6: ['', '⅙', '⅓', '½', '⅔', '⅚'],
    8: ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'],
  };
  return names[pulse]?.[k] ?? `${k}/${pulse}`;
}

/** A node's pulse, in steps per beat — a whole number from 1 to `MAX_PULSE`,
 *  falling back to sixteenths for any other value a node carries. */
export function pulseOf(node: Pick<RiffNode, 'subbeatsPerBeat'>): number {
  const p = Math.round(node.subbeatsPerBeat);
  return p >= 1 && p <= MAX_PULSE ? p : PITCHED_STEPS_PER_BEAT;
}

/** Can a node this long be written on `pulse`? Only when it holds a whole
 *  number of steps — a 1¼-beat node has no room for an eighth-triplet grid. */
export function pulseFits(lengthBeats: number, pulse: number): boolean {
  const steps = lengthBeats * pulse;
  return steps >= 1 && Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** Nearest step of `pulse`, in beats. */
export function snapToPulse(beat: number, pulse: number = PITCHED_STEPS_PER_BEAT): number {
  return Math.round(beat * pulse) / pulse;
}

/** A node whose notes say which pitch they play — a detector's bass or riff
 *  loop, or one drawn by hand in the notes view. */
export function isPitchedNode(node: Pick<RiffNode, 'segments'> | null | undefined): boolean {
  return (node?.segments ?? []).some((s) => s.kind === 'tick' && s.note != null);
}

/** One note block, the pitch's name written on it so the export and the block
 *  list read it without the number. */
function noteBlock(start: number, end: number, note: number | null): RiffBoundarySegment {
  return note == null
    ? { start, end, kind: 'tick' }
    : { start, end, kind: 'tick', note, label: midiNoteName(note) };
}

/** Writes a note over `[from, to)` — whatever was under it is cut back, as a
 *  monophonic line does: a new attack ends the note before it. `note` null is
 *  a hit with no pitch yet (a tapped rhythm waiting to be given one). */
export function placeNote(
  segments: readonly RiffBoundarySegment[],
  from: number,
  to: number,
  note: number | null,
  lengthBeats: number,
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  const a = Math.max(0, Math.min(len, Math.min(from, to)));
  const b = Math.max(0, Math.min(len, Math.max(from, to)));
  if (b - a <= 0) return [...segments];
  const out: RiffBoundarySegment[] = [];
  for (const seg of segments) {
    if (seg.end <= a || seg.start >= b) { out.push(seg); continue; }
    if (seg.start < a) out.push({ ...seg, end: a });
    if (seg.end > b) out.push({ ...seg, start: b });
  }
  out.push(noteBlock(a, b, note));
  return normalizeBoundarySegments(out, len);
}

/** The note at `index` becomes a rest. */
export function deleteNote(
  segments: readonly RiffBoundarySegment[],
  index: number,
  lengthBeats: number,
): RiffBoundarySegment[] {
  const seg = segments[index];
  if (!seg || seg.kind !== 'tick') return [...segments];
  return normalizeBoundarySegments(
    segments.map((s, i) => (i === index ? { start: s.start, end: s.end, kind: 'empty' as const } : s)),
    lengthBeats,
  );
}

/** Moves the note at `index` to start at `start` and play `note`, keeping its
 *  length (trimmed at the node's end). */
export function moveNote(
  segments: readonly RiffBoundarySegment[],
  index: number,
  start: number,
  note: number | null,
  lengthBeats: number,
  pulse: number = PITCHED_STEPS_PER_BEAT,
): RiffBoundarySegment[] {
  const seg = segments[index];
  if (!seg || seg.kind !== 'tick') return [...segments];
  const width = seg.end - seg.start;
  const from = Math.max(0, Math.min(lengthBeats - 1 / pulse, start));
  const placed = placeNote(deleteNote(segments, index, lengthBeats), from, Math.min(lengthBeats, from + width), note, lengthBeats);
  return seg.accent == null ? placed : withAccentAt(placed, from, seg.accent);
}

/** The note starting at `start` struck at `accent` — a moved or resized note
 *  keeps how hard it is played. */
function withAccentAt(segments: RiffBoundarySegment[], start: number, accent: number): RiffBoundarySegment[] {
  return segments.map((s) => (s.kind === 'tick' && Math.abs(s.start - start) < 1e-6 ? { ...s, accent } : s));
}

/** Sets where the note at `index` ends — never before one step past its
 *  start. Lengthening runs over (and cuts) what follows. */
export function resizeNote(
  segments: readonly RiffBoundarySegment[],
  index: number,
  end: number,
  lengthBeats: number,
  pulse: number = PITCHED_STEPS_PER_BEAT,
): RiffBoundarySegment[] {
  const seg = segments[index];
  if (!seg || seg.kind !== 'tick') return [...segments];
  const to = Math.max(seg.start + 1 / pulse, Math.min(lengthBeats, end));
  const cleared = deleteNote(segments, index, lengthBeats);
  const placed = placeNote(cleared, seg.start, to, seg.note ?? null, lengthBeats);
  return seg.accent == null ? placed : withAccentAt(placed, seg.start, seg.accent);
}

/** Butler's reading of a line: every note lasts until the next attack. The
 *  last one runs to the end of the cycle, where the loop comes round to its
 *  first attack again. */
export function holdToNextAttack(
  segments: readonly RiffBoundarySegment[],
  lengthBeats: number,
): RiffBoundarySegment[] {
  const ticks = segments.filter((s) => s.kind === 'tick');
  const held = ticks.map((s, i) => ({ ...s, end: i + 1 < ticks.length ? ticks[i + 1].start : lengthBeats }));
  return normalizeBoundarySegments(held, lengthBeats);
}

/** One attack in Butler's numbering: its position on the node's pulse,
 *  counted from 1 in its own bar, and the pitch it plays. */
export interface AttackPosition {
  /** 1-based position in the bar (1, 5, 9, 13 are the beats in 4/4). */
  pos: number;
  /** "C1", or "" for a hit with no pitch. */
  name: string;
  /** True when the attack is not on a step of the pulse — it is shown at the
   *  nearest one, and the reader is told so. */
  offGrid: boolean;
}

/** The node's attacks, bar by bar, numbered on its pulse — on sixteenths,
 *  the "1/5/9/13" column of Butler's Table 2.1. */
export function attackPositionsByBar(
  segments: readonly RiffBoundarySegment[],
  beatsPerBar: number,
  pulse: number = PITCHED_STEPS_PER_BEAT,
): AttackPosition[][] {
  const stepsPerBar = Math.max(1, Math.round(beatsPerBar * pulse));
  const bars: AttackPosition[][] = [];
  for (const s of segments) {
    if (s.kind !== 'tick') continue;
    const exact = s.start * pulse;
    const step = Math.round(exact);
    const bar = Math.floor(step / stepsPerBar);
    while (bars.length <= bar) bars.push([]);
    bars[bar].push({
      pos: (step % stepsPerBar) + 1,
      name: s.note != null ? midiNoteName(s.note) : '',
      offGrid: Math.abs(exact - step) > 0.02,
    });
  }
  return bars;
}

/** The pitch rows to draw, high to low: every note the line plays, with
 *  `pad` semitones either side, and never fewer than `minRows` (centred on the
 *  line, or on `fallbackCenter` when it plays nothing yet). */
export function pitchRows(
  segments: readonly RiffBoundarySegment[],
  { pad = 1, minRows = 8, fallbackCenter = 36, extraAbove = 0, extraBelow = 0 } = {},
): number[] {
  const notes = segments.filter((s) => s.kind === 'tick' && s.note != null).map((s) => s.note as number);
  let lo = notes.length ? Math.min(...notes) - pad : fallbackCenter - Math.floor(minRows / 2);
  let hi = notes.length ? Math.max(...notes) + pad : lo + minRows - 1;
  while (hi - lo + 1 < minRows) {
    if ((hi - lo) % 2 === 0) hi += 1; else lo -= 1;
  }
  lo = Math.max(0, lo - extraBelow);
  hi = Math.min(127, hi + extraAbove);
  const rows: number[] = [];
  for (let n = hi; n >= lo; n -= 1) rows.push(n);
  return rows;
}

/** Black keys — the rows a piano roll shades darker. */
export function isBlackKey(note: number): boolean {
  return [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
}

/** Puts every note on a step of `pulse`: its attack at the nearest step, its
 *  end at the nearest step but at least one past the attack (a 10 ms marker
 *  becomes one step long), and never past the next attack. Two attacks that
 *  land on the same step are one — the earlier wins. */
export function snapSegmentsToPulse(
  segments: readonly RiffBoundarySegment[],
  lengthBeats: number,
  pulse: number,
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  const step = 1 / pulse;
  const ticks = segments.filter((s) => s.kind === 'tick').sort((a, b) => a.start - b.start);
  const out: RiffBoundarySegment[] = [];
  for (const t of ticks) {
    let a = snapToPulse(t.start, pulse);
    if (a > len - step) a = Math.max(0, len - step);
    const prev = out[out.length - 1];
    if (prev && a <= prev.start + 1e-9) continue;
    if (prev && prev.end > a) out[out.length - 1] = { ...prev, end: a };
    const b = Math.min(len, Math.max(a + step, snapToPulse(t.end, pulse)));
    out.push({ ...t, start: a, end: b });
  }
  return normalizeBoundarySegments(out, len);
}

/** The node with every note on a step of its pulse (`snapSegmentsToPulse`)
 *  and its pulse a whole number from 1 to `MAX_PULSE` — what an edit is passed through
 *  before it is stored. Returns the node itself when it already is, so a
 *  clean node is never copied. */
export function toNotesNode(node: RiffNode): RiffNode {
  const pulse = pulseOf(node);
  const len = riffNodeLengthBeats(node);
  const segments = snapSegmentsToPulse(node.segments ?? [], len, pulse);
  const same = JSON.stringify(segments) === JSON.stringify(normalizeBoundarySegments(node.segments ?? [], len));
  return same && pulse === node.subbeatsPerBeat
    ? node
    : { ...node, subbeatsPerBeat: pulse, stepsPerCycle: Math.max(1, Math.round(len * pulse)), segments };
}

/** Rewrites a node onto a new pulse — same length, every note moved to the
 *  nearest step of it. Null when the length doesn't fit that pulse. */
export function setNodePulse(
  node: Pick<RiffNode, 'stepsPerCycle' | 'subbeatsPerBeat' | 'segments'>,
  pulse: number,
): Pick<RiffNode, 'subbeatsPerBeat' | 'stepsPerCycle' | 'segments'> | null {
  const len = riffNodeLengthBeats(node);
  if (!pulseFits(len, pulse)) return null;
  return {
    subbeatsPerBeat: pulse,
    stepsPerCycle: Math.round(len * pulse),
    segments: snapSegmentsToPulse(node.segments ?? [], len, pulse),
  };
}

/** Hits taken off a list of onset positions (in beats from the node's start):
 *  each lands on its nearest step as a one-step hit with no pitch. `replace`
 *  starts from an empty line; `add` keeps every note already there and adds
 *  only the onsets that no note covers yet. */
export function hitsFromOnsets(
  segments: readonly RiffBoundarySegment[],
  onsetBeats: readonly number[],
  lengthBeats: number,
  pulse: number,
  mode: 'replace' | 'add',
): RiffBoundarySegment[] {
  const step = 1 / pulse;
  let out: RiffBoundarySegment[] = mode === 'replace' ? normalizeBoundarySegments([], lengthBeats) : [...segments];
  const covered = (b: number) => out.some((s) => s.kind === 'tick' && b >= s.start - 1e-9 && b < s.end - 1e-9);
  for (const raw of [...onsetBeats].sort((a, b) => a - b)) {
    const a = snapToPulse(raw, pulse);
    if (!Number.isFinite(a) || a < 0 || a > lengthBeats - step + 1e-9 || covered(a)) continue;
    out = placeNote(out, a, a + step, null, lengthBeats);
  }
  return out;
}

/** How many of `onsetBeats` `hitsFromOnsets(..., 'add')` would add. */
export function unmarkedOnsetCount(
  segments: readonly RiffBoundarySegment[],
  onsetBeats: readonly number[],
  lengthBeats: number,
  pulse: number,
): number {
  const before = segments.filter((s) => s.kind === 'tick').length;
  return hitsFromOnsets(segments, onsetBeats, lengthBeats, pulse, 'add').filter((s) => s.kind === 'tick').length - before;
}

/** An onset that may know its pitch — a mark from a detector's notes lane
 *  (Bass notes, Riff notes) carries the MIDI note it heard. */
export interface PitchedOnset {
  beat: number;
  note?: number;
}

/** Gives every hit with no pitch yet the pitch of the onset it sits on — the
 *  nearest pitched onset within half a step of its attack. Notes that already
 *  have a pitch are left alone: a name the user gave is never overwritten. */
export function nameHits(
  segments: readonly RiffBoundarySegment[],
  onsets: readonly PitchedOnset[],
  pulse: number,
): RiffBoundarySegment[] {
  const reach = 1 / (2 * pulse) + 1e-6;
  const pitched = onsets.filter((o) => o.note != null && Number.isFinite(o.beat));
  if (pitched.length === 0) return [...segments];
  return segments.map((s) => {
    if (s.kind !== 'tick' || s.note != null) return s;
    let best: PitchedOnset | null = null;
    for (const o of pitched) {
      const d = Math.abs(o.beat - s.start);
      if (d <= reach && (!best || d < Math.abs(best.beat - s.start))) best = o;
    }
    return best ? { ...s, note: best.note, label: midiNoteName(best.note!) } : s;
  });
}

/** How many hits `nameHits` would give a pitch to. */
export function nameableHitCount(
  segments: readonly RiffBoundarySegment[],
  onsets: readonly PitchedOnset[],
  pulse: number,
): number {
  const named = nameHits(segments, onsets, pulse);
  return named.filter((s, i) => s.note != null && segments[i].note == null).length;
}

/** `hitsFromOnsets`, then every hit named from the onsets that know their
 *  pitch — so hits taken off a notes lane arrive as notes, not bare ticks. */
export function notesFromOnsets(
  segments: readonly RiffBoundarySegment[],
  onsets: readonly PitchedOnset[],
  lengthBeats: number,
  pulse: number,
  mode: 'replace' | 'add',
): RiffBoundarySegment[] {
  const hits = hitsFromOnsets(segments, onsets.map((o) => o.beat), lengthBeats, pulse, mode);
  return nameHits(hits, onsets.map((o) => ({ ...o, beat: snapToPulse(o.beat, pulse) })), pulse);
}
