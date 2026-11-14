/**
 * A riff-patterns layer, played out on the timeline.
 *
 * A riff layer stores figures (nodes), the orders they play in (sequences,
 * combos) and where each order starts (instances, repeated). Nothing in it
 * says "node A sounds from 12.0 s to 13.9 s" — that has to be worked out, and
 * it has to be worked out ONE way, or the lane draws A in one place and the
 * export writes it in another. This is that one way:
 *
 *   * `riffPlays` — every play of every node: each repeat of each instance,
 *     each entry of its sequence, each leaf of a combo, in its own span of
 *     time, with the occurrence that changed it when there is one.
 *   * `playedNotes` — the notes one play struck (the node's, less what the
 *     occurrence left out, plus what it added), still in beats from the node.
 *   * `riffPlayNotes` — those notes in song seconds.
 *
 * The groove lane (components/inspector-v2/riffGrooves.ts) draws from
 * `riffPlays`; the export writes from it. Pure: no React.
 */

import {
  RIFF_NODE_SILENCE_ID,
  flattenRiffEntry,
  riffCycleSteps,
  riffNodeLengthBeats,
  type AnnotationLayer,
  type RiffBoundarySegment,
  type RiffNode,
  type RiffOccurrence,
  type RiffPatternItem,
} from '../types/annotationLayer';

/** One play of one node (or a rest) on the timeline. */
export interface RiffPlay {
  item: RiffPatternItem;
  rep: number;
  entryIndex: number;
  /** `rep × entries + entryIndex` — the index an occurrence carries. */
  play: number;
  /** Seconds, song time. */
  start: number;
  end: number;
  /** The node played; null for a rest (silence, or an id no node has). */
  node: RiffNode | null;
  /** One leaf of a combo, which every placement of the combo shares. */
  inCombo: boolean;
  /** How this play differed from its node; never set inside a combo. */
  occ?: RiffOccurrence;
}

/** Every play in `layer`, instance by instance in start order. `bpm` is the
 *  song's (0 / undefined without a grid): a sequence shorter than its window
 *  on a song with no grid leaves the rest of the window empty rather than
 *  stretching to fill it. */
export function riffPlays(
  layer: Pick<AnnotationLayer<'riff-patterns'>, 'items' | 'nodes' | 'combos'>,
  bpm: number | undefined,
): RiffPlay[] {
  const nodes = layer.nodes ?? [];
  const combos = layer.combos ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const items = [...(layer.items as RiffPatternItem[])].sort((a, b) => a.start - b.start);
  const tempo = bpm && bpm > 0 ? bpm : 0;
  const plays: RiffPlay[] = [];
  for (const item of items) {
    const cycleSec = Math.max(0.01, item.end - item.start);
    const reps = Math.max(1, Math.floor(item.repeatCount));
    const seqSteps = item.sequence.reduce((s, e) => s + e.lengthSteps, 0);
    const denom = Math.max(seqSteps, tempo ? riffCycleSteps(cycleSec, tempo) : seqSteps, 1);
    const occByPlay = new Map((item.occurrences ?? []).map((o) => [o.index, o]));
    for (let rep = 0; rep < reps; rep += 1) {
      let at = item.start + rep * cycleSec;
      item.sequence.forEach((entry, entryIndex) => {
        const entrySec = cycleSec * (entry.lengthSteps / denom);
        const inCombo = entry.type !== RIFF_NODE_SILENCE_ID && !byId.has(entry.type);
        const play = rep * item.sequence.length + entryIndex;
        for (const leaf of flattenRiffEntry(entry, nodes, combos)) {
          const len = entrySec * leaf.fraction;
          const node = leaf.nodeId ? byId.get(leaf.nodeId) ?? null : null;
          const occ = node && !inCombo ? occByPlay.get(play) : undefined;
          plays.push({ item, rep, entryIndex, play, start: at, end: at + len, node, inCombo, ...(occ ? { occ } : {}) });
          at += len;
        }
      });
    }
  }
  return plays;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** A node's notes: its `tick` blocks. */
export function nodeNotes(node: Pick<RiffNode, 'segments'>): RiffBoundarySegment[] {
  return (node.segments ?? []).filter((s) => s.kind === 'tick');
}

/** The notes one play struck: the node's, less what its occurrence left out,
 *  plus what it added. */
export function playedNotes(node: RiffNode, occ: RiffOccurrence | undefined): RiffBoundarySegment[] {
  const notes = nodeNotes(node);
  if (!occ) return notes;
  const missing = occ.missing ?? [];
  const kept = notes.filter((s) => !missing.some((m) => near(m.start, s.start)));
  const added = (occ.added ?? []).map((a) => ({ ...a, kind: 'tick' as const }));
  return [...kept, ...added].sort((a, b) => a.start - b.start);
}

/** One struck note in song seconds. */
export interface RiffTimedNote {
  time: number;
  end: number;
  /** MIDI pitch, when the note has one. */
  note?: number;
  /** 1..127; absent = full strength (`ACCENT_FULL`). */
  accent?: number;
  label?: string;
}

/** The notes a play struck, placed in song time. The node is stretched over
 *  the play's span exactly as the lane draws it, so a note lands where it is
 *  drawn. */
export function riffPlayNotes(p: RiffPlay): RiffTimedNote[] {
  if (!p.node) return [];
  const beats = riffNodeLengthBeats(p.node);
  if (!(beats > 0)) return [];
  const secPerBeat = (p.end - p.start) / beats;
  return playedNotes(p.node, p.occ).map((s) => ({
    time: p.start + s.start * secPerBeat,
    end: p.start + s.end * secPerBeat,
    ...(typeof s.note === 'number' ? { note: s.note } : {}),
    ...(typeof s.accent === 'number' ? { accent: s.accent } : {}),
    ...(s.label ? { label: s.label } : {}),
  }));
}
