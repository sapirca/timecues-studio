/**
 * The sound palette — Butler's key to a track (*Unlocking the Groove*,
 * p. 179): every repeating sound written once, as the shortest pattern that
 * repeats, with how long one turn of it lasts and where in the song it plays.
 *
 * One model, two sources, and a palette never mixes them:
 *   - the Annotator Tool lists the user's own Riff Patterns layers, a figure
 *     per node, exactly as drawn — nothing is grouped or renamed;
 *   - Algorithm Inspect lists what the detectors found — their riff lanes —
 *     with a letter's figures of other lengths ("A · 8 beats") folded under
 *     it, as Butler letters his "Bass Drum 1a, 1b".
 *
 * Pure data: SoundPalette.tsx draws it.
 */

import {
  flattenRiffEntry,
  riffCycleSteps,
  riffNodeLengthBeats,
  type AnnotationLayer,
  type RiffBoundarySegment,
  type RiffNode,
} from '../../types/annotationLayer';
import { midiNoteName } from '../../utils/drumHits';

/** One run of a figure: the stretch [start, end) it plays in, `reps` times,
 *  and where it first sounds — the turn ▶ plays. A figure played on its own
 *  fills its run turn after turn; one inside a longer sequence sounds once
 *  per turn of that sequence, at its place in it. */
export interface PaletteRun {
  start: number;
  end: number;
  reps: number;
  firstTurn: { start: number; end: number };
  /** Set on a run that one of the figure's folded figures plays ("8 beats"),
   *  when it is shown on the figure's own row. */
  variant?: string;
}

/** One turn of a figure, in the shape its source draws it. */
export type PaletteStrip = { kind: 'blocks'; segments: readonly RiffBoundarySegment[]; lengthBeats: number };

export interface PaletteFigure {
  id: string;
  name: string;
  color: string;
  /** One turn, in beats. */
  lengthBeats: number;
  strip: PaletteStrip;
  /** Where it plays, in time order. Empty: drawn but never placed. */
  runs: PaletteRun[];
  /** The notes it plays, low to high ("C1–E♭2 · 6 notes"), when its blocks
   *  carry pitches. */
  pitch?: string;
  /** The same letter at other lengths (detector side only). */
  variants: PaletteFigure[];
}

/** Every run of a figure's family: its own, and each variant's, marked with
 *  the variant's name — the whole of where this figure plays in the song. A
 *  figure whose returns are all a little different still plays there. */
export function familyRuns(figure: PaletteFigure): PaletteRun[] {
  return [
    ...figure.runs,
    ...figure.variants.flatMap((v) => v.runs.map((r) => ({ ...r, variant: variantMark(v.name) }))),
  ].sort((a, b) => a.start - b.start);
}

/** "A · 8 beats" → "8 beats": what sets a figure folded under its letter
 *  apart from it. */
function variantMark(name: string): string {
  return name.split(' · ').slice(1).join(' · ') || name;
}

export interface PaletteGroup {
  id: string;
  name: string;
  color: string;
  figures: PaletteFigure[];
  /** Detector side: which of the palette's sections the lane belongs to. */
  section?: PaletteSection;
}

/** The detector palette's sections, in the order they are listed: the whole
 *  drum kit read together, each drum read on its own, then the pitched parts.
 *  Two readings of the same drums are kept apart so neither looks like a
 *  duplicate of the other. */
export type PaletteSection = 'kit' | 'drum' | 'pitched';
export const SECTION_ORDER: readonly PaletteSection[] = ['kit', 'drum', 'pitched'];

const SINGLE_DRUMS = /^(kick|snare|hat|toms|ride|crash)\d*(_|$)/;

/** Which section a detector lane goes in, by its lane id: the kit read
 *  together ("drum_transients~grooves_kick"), one drum read on its own
 *  ("instrument_layers~kick_pattern"), or pitched
 *  ("pitched_layers~bass_pattern"). */
export function laneSection(groupId: string): PaletteSection {
  const lane = groupId.split('~').pop() ?? '';
  if (lane.startsWith('grooves_')) return 'kit';
  return SINGLE_DRUMS.test(lane) ? 'drum' : 'pitched';
}

const byFirstRun = (a: PaletteFigure, b: PaletteFigure) =>
  (a.runs[0]?.start ?? Infinity) - (b.runs[0]?.start ?? Infinity);

/** Butler's order: shortest loop first (p. 180), then by where it enters. */
export function sortFigures(figures: PaletteFigure[]): PaletteFigure[] {
  return [...figures].sort((a, b) => a.lengthBeats - b.lengthBeats || byFirstRun(a, b));
}

/** "C1–E♭2 · 6 notes", read off the blocks' MIDI numbers; null when the
 *  figure carries no pitch. */
export function pitchSummary(segments: readonly RiffBoundarySegment[]): string | null {
  const notes = segments.flatMap((s) => (s.kind === 'tick' && typeof s.note === 'number' ? [s.note] : []));
  if (notes.length === 0) return null;
  const lo = Math.min(...notes), hi = Math.max(...notes);
  const distinct = new Set(notes).size;
  const range = lo === hi ? `${midiNoteName(lo)} only` : `${midiNoteName(lo)}–${midiNoteName(hi)}`;
  return distinct > 1 ? `${range} · ${distinct} notes` : range;
}

function nodeStrip(node: RiffNode): PaletteStrip {
  return { kind: 'blocks', segments: node.segments, lengthBeats: riffNodeLengthBeats(node) };
}

/** Where `nodeId` first sounds inside one turn of `item`, in seconds — the
 *  same step arithmetic as `findFirstRiffNodeOccurrence`, through combos and
 *  sequences alike. Null when the instance never plays it. */
function firstSlot(
  layer: AnnotationLayer<'riff-patterns'>,
  item: AnnotationLayer<'riff-patterns'>['items'][number],
  nodeId: string,
  bpm: number,
): { start: number; end: number } | null {
  const cycleSec = Math.max(0.01, item.end - item.start);
  const stepDur = cycleSec / riffCycleSteps(cycleSec, bpm);
  let offset = 0;
  for (const entry of item.sequence) {
    let inner = 0;
    for (const leaf of flattenRiffEntry(entry, layer.nodes ?? [], layer.combos ?? [])) {
      const steps = leaf.fraction * entry.lengthSteps;
      if (leaf.nodeId === nodeId) {
        const start = item.start + (offset + inner) * stepDur;
        return { start, end: start + steps * stepDur };
      }
      inner += steps;
    }
    offset += entry.lengthSteps;
  }
  return null;
}

/** A layer's figures: one per node, at every instance that plays it — on
 *  its own, or as one part of a longer sequence. */
function riffFigures(layer: AnnotationLayer<'riff-patterns'>, bpm: number): PaletteFigure[] {
  const nodes = layer.nodes ?? [];
  return nodes.map((node) => {
    const runs: PaletteRun[] = [];
    for (const it of layer.items) {
      const slot = firstSlot(layer, it, node.id, bpm);
      if (!slot) continue;
      const cycleSec = Math.max(0, it.end - it.start);
      const reps = Math.max(1, Math.floor(it.repeatCount || 1));
      runs.push({ start: it.start, end: it.start + cycleSec * reps, reps, firstTurn: slot });
    }
    runs.sort((a, b) => a.start - b.start);
    const pitch = pitchSummary(node.segments);
    return {
      id: `${layer.id}:${node.id}`,
      name: node.name,
      color: node.color,
      lengthBeats: riffNodeLengthBeats(node),
      strip: nodeStrip(node),
      runs,
      ...(pitch ? { pitch } : {}),
      variants: [],
    };
  });
}

/** Folds figures named "Riff A", "Riff A²", "Riff A³" into A with two
 *  variants. The first of a family in letter order is the figure; a variant
 *  whose figure is missing stands on its own. */
export function foldVariants(figures: PaletteFigure[]): PaletteFigure[] {
  const families = new Map<string, PaletteFigure[]>();
  for (const f of [...figures].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = f.name.split(' · ')[0];
    families.set(key, [...(families.get(key) ?? []), f]);
  }
  return [...families.values()].map(([head, ...rest]) => ({ ...head, variants: rest }));
}

/** The palette of the user's own Riff Patterns layers: a group per layer, a
 *  figure per node, as drawn. */
export function handPalette(layers: readonly AnnotationLayer<'riff-patterns'>[], bpm: number): PaletteGroup[] {
  return layers
    .map((layer) => ({ id: layer.id, name: layer.name, color: layer.color, figures: sortFigures(riffFigures(layer, bpm)) }))
    .filter((g) => g.figures.length > 0);
}

/** The palette of what the detectors found: a group per riff lane, a
 *  letter's other lengths folded under it. */
export function detectorPalette(
  riffLayers: readonly AnnotationLayer<'riff-patterns'>[],
  bpm: number,
): PaletteGroup[] {
  const riffs = riffLayers.map((layer): PaletteGroup => ({
    id: layer.id, name: layer.name, color: layer.color, figures: sortFigures(foldVariants(riffFigures(layer, bpm))),
    section: laneSection(layer.id),
  }));
  const rank = (g: PaletteGroup) => SECTION_ORDER.indexOf(g.section ?? 'pitched');
  return riffs
    .filter((g) => g.figures.length > 0)
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
    .map(({ g }) => g);
}
