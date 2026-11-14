/**
 * What the groove lane draws (GrooveLaneRow): a riff lane read bar by bar
 * (riffGrooves.ts `riffGrooveLane` builds it), and what reads it back — the
 * card's sentences, the light-show hits, the lane's big picture.
 *
 * A lane is two things at once, and shows them apart:
 *
 *   * WHICH figure plays WHEN — one cell per bar, coloured by its node, so
 *     where the groove changes, and which sections share one, reads at any zoom.
 *   * WHAT the figure is — the node's notes, in the card a cell opens.
 *
 * A cell draws the bar AS PLAYED — the node, minus what that play left out,
 * plus what it added (its occurrence) — not the node tiled: on Alor a tiled
 * lane drew one bar 84 times when only 12 of the 84 played it.
 *
 * Pure: no React. The lane and the card render what this returns.
 */

import type { RiffEvent } from '../../types/annotationLayer';
import type { LayerMarkerCounts } from '../../utils/layerMarkerCounts';

/** Drawn top to bottom, as a drum staff is read: cymbals above, kick below,
 *  toms between kick and snare, and the bass under the kick when the detector
 *  sent one (BASS_ROW in drum_kit_pattern.py). Toms, ride and crash come only
 *  from a split kit (KIT_ROWS there), and only the pieces it heard. */
export const GROOVE_ROWS = ['crash', 'ride', 'hat', 'snare', 'toms', 'kick', 'bass', 'notes'] as const;
export type GrooveRow = (typeof GROOVE_ROWS)[number];

/** The Drum hits lane's hues (DRUM_HIT_COLORS in generators/drum_transients.py),
 *  the separated kit's for the pieces only it hears (PARTS in
 *  drum_kit_split.py) and the Bass notes lane's (BASS_NOTE_COLOR in
 *  generators/bass_notes.py), so a hit and the groove step it belongs to read
 *  as the same instrument. */
export const GROOVE_ROW_COLORS: Record<GrooveRow, string> = {
  kick: '#f87171',
  toms: '#fb923c',
  snare: '#38bdf8',
  hat: '#a3e635',
  ride: '#facc15',
  crash: '#e879f9',
  bass: '#a78bfa',
  // A riff lane's one line when it is not a drum's (riffGrooves.ts): a bass
  // line, a hand-drawn figure. Light, over its node's colour.
  notes: '#f1f5f9',
};

/** A drum's step in one bar. `played`: the groove has it and this bar hit it;
 *  `missing`: the groove has it and this bar did not; `added`: this bar hit it
 *  and the groove does not. */
export interface GrooveStep {
  step: number;
  state: 'played' | 'missing' | 'added';
  /** How hard the groove strikes this step, 1..127 — the canonical accent.
   *  Absent on an added hit, which the groove has no accent for. */
  velocity?: number;
  /** Steps the note is held, when more than one — a riff lane's bass note. */
  length?: number;
  /** The note's pitch ("E1"), when it has one. */
  label?: string;
}

/** One cell of the lane: one repeat of a groove. Usually a bar; a 2-bar
 *  loop's repeat is two (`bars`), and its `steps` run across both. */
export interface GrooveBar {
  /** Bar number in the song, from 1 — the first, when the cell is several. */
  bar: number;
  /** How many of the song's bars the cell covers: the loop's length, or fewer
   *  where the run ended inside the cycle. */
  bars: number;
  start: number;
  end: number;
  motif: string;
  event: RiffEvent;
  /** Share of the bar's steps that differ from its node: 0 = played exactly. */
  deviation: number;
  /** Bars per cycle of the cell's groove: a cell cut short covers fewer. */
  loopBars: number;
  steps: number;
  /** 16ths in one of the song's bars: the cycle's steps over its bars. */
  stepsPerBar: number;
  rows: Record<GrooveRow, GrooveStep[]>;
  /** On the first cell of a run, how many times the run plays its loop —
   *  bars, for a 1-bar loop; 0 on the rest.
   *  A run is one pattern item — the detector's own run of the loop, the same
   *  one its notes lane counts (`find_loops` in instrument_layers.py). */
  runBars: number;
  /** Which run the bar belongs to — the same number on every bar of one
   *  pattern item — so the card can lay the whole run out bar by bar. */
  run: number;
  /** Plays the run's loop again, exactly, after the bar that showed it. The
   *  same rule as `_is_repeat` in instrument_layers.py, which mutes the notes
   *  of these bars. The groove lane draws it as strong as the first: one
   *  pattern, one colour, one strength. */
  repeat: boolean;
  /** Which stacked lane the cell draws in, from 0 — a riff lane's instances
   *  may overlap in time (riffGrooves.ts). A detector's grooves never do. */
  lane?: number;
  /** How many stacked lanes share the cell's stretch of the song: an
   *  instance nothing overlaps has the whole height (1). Absent = the row's
   *  `laneCount`. */
  lanes?: number;
}

/** One figure — a node of the lane — as its card shows it. */
export interface Groove {
  motif: string;
  /** The letter it is lettered by: A for A and for "A · 8 beats" alike. */
  family: string;
  names: string[];
  steps: number;
  /** Bars per cycle: 1, or 2 / 4 for a loop longer than a bar. */
  loopBars: number;
  /** The canonical cycle: every step it plays, with its accent. */
  rows: Record<GrooveRow, GrooveStep[]>;
  /** The song's bars it plays, counted in bars, not cycles. */
  bars: number;
  events: Record<RiffEvent, number>;
}

export interface GrooveLaneModel {
  /** The rows this lane draws, top to bottom. */
  rows: GrooveRow[];
  bars: GrooveBar[];
  grooves: Groove[];
  colorOf: (motif: string) => string;
}

function emptyRows<T = GrooveStep>(): Record<GrooveRow, T[]> {
  return Object.fromEntries(GROOVE_ROWS.map((r) => [r, []])) as unknown as Record<GrooveRow, T[]>;
}

/** The lane card's counts: bars, split by the groove they play. */
export function grooveLaneCounts(model: GrooveLaneModel): LayerMarkerCounts {
  const kinds = model.grooves
    .map((g) => ({ kind: g.names.length ? `${g.motif} · ${g.names.join(', ')}` : g.motif, count: g.bars }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return { total: model.bars.length, noun: 'bars', kinds };
}

/** "Bar 13", or "Bars 13–14" for a cell of a 2-bar loop. */
export function barSpan(bar: Pick<GrooveBar, 'bar' | 'bars'>): string {
  return bar.bars > 1 ? `Bars ${bar.bar}–${bar.bar + bar.bars - 1}` : `Bar ${bar.bar}`;
}

/** "+2 snare, −1 hat" — what one bar changed, in drums rather than steps. */
export function describeBarChange(bar: GrooveBar): string {
  const parts: string[] = [];
  for (const row of GROOVE_ROWS) {
    const added = bar.rows[row].filter((s) => s.state === 'added').length;
    const missing = bar.rows[row].filter((s) => s.state === 'missing').length;
    if (added) parts.push(`+${added} ${row}`);
    if (missing) parts.push(`−${missing} ${row}`);
  }
  return parts.join(', ');
}

/** "fill", "drop", "variation" or "as the groove" — how a bar reads in words. */
export const EVENT_WORDS: Record<RiffEvent, string> = {
  exact: 'as the groove',
  variation: 'variation',
  fill: 'fill',
  drop: 'drop-out',
};

/** One struck hit on the song's clock: when, which bar, how hard, and how
 *  long its light may last before this drum's next hit. */
export interface GrooveHit {
  time: number;
  /** Index into the model's `bars`. */
  bar: number;
  step: number;
  /** 0..1. An added hit, which has no accent of its own, strikes at 0.8. */
  strength: number;
  /** Seconds to this drum's next hit (Infinity for its last). */
  gap: number;
}

/** Every hit each drum actually struck, in time order — the groove as it was
 *  played, which is what a light show blinks on. A hit the bar dropped is not
 *  struck, so it never lights. */
export function grooveHits(bars: readonly GrooveBar[]): Record<GrooveRow, GrooveHit[]> {
  const out = emptyRows<GrooveHit>();
  bars.forEach((bar, b) => {
    const stepSec = (bar.end - bar.start) / bar.steps;
    for (const row of GROOVE_ROWS) {
      for (const s of bar.rows[row]) {
        if (s.state === 'missing') continue;
        out[row].push({
          time: bar.start + s.step * stepSec,
          bar: b,
          step: s.step,
          strength: s.velocity != null ? s.velocity / 127 : 0.8,
          gap: Infinity,
        });
      }
    }
  });
  for (const row of GROOVE_ROWS) {
    const hits = out[row].sort((a, z) => a.time - z.time);
    for (let i = 0; i + 1 < hits.length; i++) hits[i].gap = hits[i + 1].time - hits[i].time;
  }
  return out;
}

/** "B's rhythm: kick 1, 9 · snare 5, 13 · hat 3, 7, 11, 15" — the groove's own
 *  bar (its letter's first version, as the detector voted it), by drum, in
 *  16ths counted from 1; a 2-bar loop bar by bar. Null when the lane has no
 *  such groove. */
export function grooveRhythm(model: GrooveLaneModel, family: string): string | null {
  const g = model.grooves.find((x) => x.motif === family)
    ?? model.grooves.find((x) => x.family === family);
  if (!g) return null;
  const per = g.steps / g.loopBars;
  const barText = (b: number) => model.rows
    .map((row) => [row, g.rows[row].filter((st) => st.step >= b * per && st.step < (b + 1) * per)
      .map((st) => st.step - b * per + 1)] as const)
    .filter(([, steps]) => steps.length)
    .map(([row, steps]) => `${row} ${stepList(steps)}`)
    .join(' · ');
  const text = g.loopBars === 1
    ? barText(0)
    : Array.from({ length: g.loopBars }, (_, b) => `bar ${b + 1}: ${barText(b) || 'nothing'}`).join(' / ');
  return text ? `${family}'s rhythm${g.loopBars > 1 ? ` (${g.loopBars}-bar loop)` : ''}: ${text}` : null;
}

/** "1–16" for a run of three or more neighbouring steps, else the steps: a
 *  hat on every 16th reads as one range, not sixteen numbers. */
function stepList(steps: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < steps.length;) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1] === steps[j] + 1) j += 1;
    if (j - i >= 2) out.push(`${steps[i]}–${steps[j]}`);
    else for (let k = i; k <= j; k += 1) out.push(String(steps[k]));
    i = j + 1;
  }
  return out.join(', ');
}

/** "13–20, 25–26, 29–44": song bars as ranges. */
function barRanges(bars: readonly number[]): string {
  const sorted = [...bars].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return out.join(', ');
}

/** A groove's share of the lane's bars at which it is one of the main loops. */
const MAIN_LOOP_SHARE = 0.15;
/** At most this many main loops: the big picture is a few loops, not a list. */
const MAX_MAIN_LOOPS = 3;

/** The lane's big picture in one line: its main loops — the letters that play
 *  the most bars, variations counted with their letter — each with how much
 *  and where it plays, what a musician would call it, and its rhythm; then
 *  the rest in one clause. What a reader needs before any single bar.
 *
 *  "2 main loops of 108 bars. A — 47 bars (21–28, 85–116), straight 16ths:
 *  hat 1–16. B — 30 bars (13–20, 25–26, 29–44), 2-bar loop: … 2 other
 *  letters (C, D) play 8 bars, each under 15% of the song." */
export function grooveSummary(model: GrooveLaneModel): string | null {
  const barsOf = new Map<string, number[]>();
  for (const cell of model.bars) {
    // A node of another length than its letter's loop ("A · 8 beats") is
    // that letter's bars.
    const family = cell.motif.split(' · ')[0];
    for (let b = 0; b < cell.bars; b += 1) {
      barsOf.set(family, [...(barsOf.get(family) ?? []), cell.bar + b]);
    }
  }
  const total = [...barsOf.values()].reduce((n, xs) => n + xs.length, 0);
  if (!total) return null;
  const ranked = [...barsOf.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const main = ranked.filter(([, xs], i) => i === 0 || xs.length / total >= MAIN_LOOP_SHARE).slice(0, MAX_MAIN_LOOPS);
  const rest = ranked.slice(main.length);
  const parts = main.map(([family, xs]) => {
    const names = model.grooves.find((g) => g.motif === family)?.names ?? [];
    const rhythm = grooveRhythm(model, family)?.replace(`${family}'s rhythm`, 'rhythm');
    return `${family} — ${xs.length} bars (${barRanges(xs)})${names.length ? `, ${names.join(', ')}` : ''}${rhythm ? `; ${rhythm}` : ''}.`;
  });
  const restBars = rest.reduce((n, [, xs]) => n + xs.length, 0);
  const tail = rest.length
    ? ` ${rest.length === 1 ? 'One other letter' : `${rest.length} other letters`} (${rest.map(([f]) => f).join(', ')}) ${rest.length === 1 ? 'plays' : 'play'} ${restBars} bar${restBars === 1 ? '' : 's'}, each under ${Math.round(MAIN_LOOP_SHARE * 100)}% of the song.`
    : '';
  return `${main.length} main loop${main.length === 1 ? '' : 's'} over ${total} bars, most played first. ${parts.join(' ')}${tail}`;
}
