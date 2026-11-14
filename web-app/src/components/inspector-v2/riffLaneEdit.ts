/**
 * Building a riff instance on its lane — the edits behind RiffLaneEditor.
 *
 * Drag on an empty stretch of a riff lane and that stretch is the first node:
 * a new instance starts there, playing one new node as long as the drag. From
 * there the instance is built in place — nodes added, reused, reordered,
 * played several times in a row; notes drawn on a node (every play of it) or
 * on one play only, which is that play's occurrence; the whole riff repeated.
 *
 * Every edit to an instance's sequence goes through `withSequence`, because
 * an occurrence is addressed by its play's index (`rep × entries + entry`):
 * inserting, removing or moving an entry shifts every index after it, and an
 * occurrence left at its old index would describe the wrong play. Each new
 * entry says which old entry it was (or none), and the occurrences follow.
 *
 * Pure: no React, no document — a layer in, a layer out.
 */

import {
  defaultRiffEntryLength,
  newRiffNode,
  newRiffPatternItem,
  newRiffSeqEntry,
  normalizeBoundarySegments,
  pickRiffNodeColor,
  riffNodeLengthBeats,
  RIFF_NODE_SILENCE_ID,
  type AnnotationLayer,
  type AnnotationLayersDocument,
  type RiffBoundarySegment,
  type RiffNode,
  type RiffOccurrence,
  type RiffPatternItem,
  type RiffSeqEntry,
} from '../../types/annotationLayer';
import { deleteNote, placeNote, pulseFits, setNodePulse } from '../../utils/pitchedRiff';
import { riffEventOf } from './riffGrooves';
import { nodeNotes, playedNotes } from '../../utils/riffPlays';

type RiffLayer = AnnotationLayer<'riff-patterns'>;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// ── Names ───────────────────────────────────────────────────────────────────

/** The next letter no node on the lane is called: A, B, … Z, then A2, B2 … */
export function nextNodeName(nodes: readonly Pick<RiffNode, 'name'>[]): string {
  const taken = new Set(nodes.map((n) => n.name));
  for (let round = 1; ; round += 1) {
    for (let c = 65; c <= 90; c += 1) {
      const name = String.fromCharCode(c) + (round > 1 ? String(round) : '');
      if (!taken.has(name)) return name;
    }
  }
}

// ── Creating ────────────────────────────────────────────────────────────────

/** A new instance at `start` playing one new, empty node `lengthBeats` long.
 *  The instance's `end` is placed for `bpm`; the page refits it anyway. */
export function createRiffDraft(
  layer: RiffLayer,
  start: number,
  lengthBeats: number,
  bpm: number,
): { layer: RiffLayer; itemId: string; nodeId: string } {
  const nodes = layer.nodes ?? [];
  const beats = Math.max(1, Math.round(lengthBeats));
  const node = newRiffNode(nextNodeName(nodes), pickRiffNodeColor(nodes), beats);
  const item = newRiffPatternItem(start, start + beats * (60 / bpm));
  item.sequence = [newRiffSeqEntry(node.id, defaultRiffEntryLength(node.id, [node], []))];
  return {
    layer: { ...layer, nodes: [...nodes, node], items: [...(layer.items as RiffPatternItem[]), item] },
    itemId: item.id,
    nodeId: node.id,
  };
}

/** A new, empty node for the lane: the next letter, a colour of its own, as
 *  long as `lengthBeats`. */
export function newLaneNode(layer: RiffLayer, lengthBeats: number): RiffNode {
  const nodes = layer.nodes ?? [];
  return newRiffNode(nextNodeName(nodes), pickRiffNodeColor(nodes), Math.max(1, Math.round(lengthBeats)));
}

// ── Reading ─────────────────────────────────────────────────────────────────

export function riffItem(layer: RiffLayer, itemId: string): RiffPatternItem | undefined {
  return (layer.items as RiffPatternItem[]).find((it) => it.id === itemId);
}

export function riffNode(layer: RiffLayer, nodeId: string): RiffNode | undefined {
  return (layer.nodes ?? []).find((n) => n.id === nodeId);
}

/** Neighbouring entries that play the same node: A A B → A ×2, B. */
export interface RiffRun { type: string; from: number; count: number }

export function riffRuns(sequence: readonly RiffSeqEntry[]): RiffRun[] {
  const runs: RiffRun[] = [];
  sequence.forEach((e, i) => {
    const last = runs[runs.length - 1];
    if (last && last.type === e.type) last.count += 1;
    else runs.push({ type: e.type, from: i, count: 1 });
  });
  return runs;
}

/** How many times the lane plays a node: every entry of every instance that
 *  names it, times that instance's repeats. Combos are not looked inside —
 *  their leaves are shared by every placement, so they are edited there. */
export function playsOfNode(layer: RiffLayer, nodeId: string): number {
  let n = 0;
  for (const it of layer.items as RiffPatternItem[]) {
    const reps = Math.max(1, Math.floor(it.repeatCount));
    n += it.sequence.filter((e) => e.type === nodeId).length * reps;
  }
  return n;
}

export { nodeNotes, playedNotes };

export function occurrenceAt(item: RiffPatternItem, play: number): RiffOccurrence | undefined {
  return (item.occurrences ?? []).find((o) => o.index === play);
}

// ── Notes ───────────────────────────────────────────────────────────────────

/** `notes` with steps `a..b` (inclusive, on `pulse`) edited the way the lane
 *  edits them: a press on one step that starts a note removes that note, a
 *  press on any other step adds a one-step note, and a press dragged across
 *  steps writes one note held over all of them, cutting what was under it. */
export function editNotes(
  notes: readonly RiffBoundarySegment[],
  a: number,
  b: number,
  pulse: number,
  lengthBeats: number,
): RiffBoundarySegment[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const segments = normalizeBoundarySegments(notes.map((n) => ({ ...n, kind: 'tick' as const })), lengthBeats);
  const at = lo / pulse;
  let next: RiffBoundarySegment[];
  if (lo === hi) {
    const hit = segments.findIndex((s) => s.kind === 'tick' && near(s.start, at));
    next = hit >= 0
      ? deleteNote(segments, hit, lengthBeats)
      : placeNote(segments, at, at + 1 / pulse, null, lengthBeats);
  } else {
    next = placeNote(segments, at, (hi + 1) / pulse, null, lengthBeats);
  }
  return next.filter((s) => s.kind === 'tick');
}

/** The node with its notes replaced (rests filled in between). */
export function withNodeNotes(node: RiffNode, notes: readonly RiffBoundarySegment[]): RiffNode {
  return { ...node, segments: normalizeBoundarySegments([...notes], riffNodeLengthBeats(node)) };
}

/** The occurrence that makes one play strike exactly `notes`: the node's
 *  notes it does not have are missing, the ones it has that the node does
 *  not (or holds differently) are added. Null when the play is the node. */
export function occurrenceFor(
  node: RiffNode,
  play: number,
  notes: readonly RiffBoundarySegment[],
): RiffOccurrence | null {
  const own = nodeNotes(node);
  const same = (x: RiffBoundarySegment, y: RiffBoundarySegment) => near(x.start, y.start) && near(x.end, y.end);
  const missing = own.filter((s) => !notes.some((n) => same(n, s))).map((s) => ({ start: s.start }));
  const added = notes
    .filter((n) => !own.some((s) => same(n, s)))
    .map((n) => ({
      start: n.start,
      end: n.end,
      ...(n.label ? { label: n.label } : {}),
      ...(n.note != null ? { note: n.note } : {}),
      ...(n.accent != null ? { accent: n.accent } : {}),
    }));
  if (!missing.length && !added.length) return null;
  return {
    index: play,
    event: riffEventOf(notes.length, added.length, missing.length),
    ...(added.length ? { added } : {}),
    ...(missing.length ? { missing } : {}),
  };
}

/** The item with play `play`'s occurrence set to `occ` (or removed). */
export function withOccurrence(item: RiffPatternItem, play: number, occ: RiffOccurrence | null): RiffPatternItem {
  const rest = (item.occurrences ?? []).filter((o) => o.index !== play);
  const occurrences = (occ ? [...rest, occ] : rest).sort((a, b) => a.index - b.index);
  const next: RiffPatternItem = { ...item, occurrences };
  if (!occurrences.length) delete next.occurrences;
  return next;
}

/** The node on a new pulse, or null when its length has no whole number of
 *  steps on it. */
export function nodeOnPulse(node: RiffNode, pulse: number): RiffNode | null {
  if (!pulseFits(riffNodeLengthBeats(node), pulse)) return null;
  const next = setNodePulse(node, pulse);
  return next ? { ...node, ...next } : null;
}


// ── The sequence ────────────────────────────────────────────────────────────

/** One entry of a rewritten sequence: what it plays, and which entry of the
 *  old sequence it is (null for a new one, which starts with no occurrences). */
export interface SeqSlot { type: string; lengthSteps: number; from: number | null }

/** The item with a new sequence, every occurrence moved to the play its entry
 *  now is — and dropped with its entry, or when its entry now plays another
 *  node. */
export function withSequence(item: RiffPatternItem, slots: readonly SeqSlot[]): RiffPatternItem {
  const oldN = item.sequence.length;
  const newN = slots.length;
  const newIndexOf = new Map<number, number>();
  slots.forEach((s, k) => {
    if (s.from != null && item.sequence[s.from]?.type === s.type) newIndexOf.set(s.from, k);
  });
  const occurrences = (item.occurrences ?? []).flatMap((o) => {
    if (!oldN) return [];
    const rep = Math.floor(o.index / oldN);
    const k = newIndexOf.get(o.index % oldN);
    return k == null ? [] : [{ ...o, index: rep * newN + k }];
  }).sort((a, b) => a.index - b.index);
  const next: RiffPatternItem = {
    ...item,
    sequence: slots.map((s) => newRiffSeqEntry(s.type, s.lengthSteps)),
    occurrences,
  };
  if (!occurrences.length) delete next.occurrences;
  return next;
}

const slotsOf = (item: RiffPatternItem): SeqSlot[] =>
  item.sequence.map((e, i) => ({ type: e.type, lengthSteps: e.lengthSteps, from: i }));

function lengthFor(layer: RiffLayer, type: string): number {
  return defaultRiffEntryLength(type, layer.nodes ?? [], layer.combos ?? []);
}

export function insertEntry(layer: RiffLayer, item: RiffPatternItem, at: number, type: string): RiffPatternItem {
  const slots = slotsOf(item);
  slots.splice(Math.max(0, Math.min(at, slots.length)), 0, { type, lengthSteps: lengthFor(layer, type), from: null });
  return withSequence(item, slots);
}

export function removeEntry(item: RiffPatternItem, index: number): RiffPatternItem {
  return withSequence(item, slotsOf(item).filter((_, i) => i !== index));
}

/** Entry `from` moved to the gap before entry `gap` (0..length). */
export function moveEntry(item: RiffPatternItem, from: number, gap: number): RiffPatternItem {
  const slots = slotsOf(item);
  const [moved] = slots.splice(from, 1);
  if (!moved) return item;
  slots.splice(from < gap ? gap - 1 : gap, 0, moved);
  return withSequence(item, slots);
}

export function swapEntries(item: RiffPatternItem, a: number, b: number): RiffPatternItem {
  const slots = slotsOf(item);
  if (!slots[a] || !slots[b] || a === b) return item;
  [slots[a], slots[b]] = [slots[b], slots[a]];
  return withSequence(item, slots);
}

/** Entry `index` plays `type` instead — a new play, so its occurrences go. */
export function replaceEntry(layer: RiffLayer, item: RiffPatternItem, index: number, type: string): RiffPatternItem {
  return withSequence(item, slotsOf(item).map((s, i) => (
    i === index ? { type, lengthSteps: lengthFor(layer, type), from: null } : s
  )));
}

/** The run starting at `from` played `count` times in a row: copies added at
 *  its end, or its last entries removed. */
export function setRunCount(item: RiffPatternItem, from: number, count: number): RiffPatternItem {
  const run = riffRuns(item.sequence).find((r) => r.from === from);
  if (!run) return item;
  const want = Math.max(1, Math.floor(count));
  const slots = slotsOf(item);
  const end = run.from + run.count;
  if (want > run.count) {
    const len = item.sequence[run.from].lengthSteps;
    const extra = Array.from({ length: want - run.count }, () => ({ type: run.type, lengthSteps: len, from: null }));
    slots.splice(end, 0, ...extra);
  } else if (want < run.count) {
    slots.splice(run.from + want, run.count - want);
  }
  return withSequence(item, slots);
}

// ── Writing back ────────────────────────────────────────────────────────────

export function withItem(layer: RiffLayer, item: RiffPatternItem): RiffLayer {
  return { ...layer, items: (layer.items as RiffPatternItem[]).map((it) => (it.id === item.id ? item : it)) };
}

export function withNode(layer: RiffLayer, node: RiffNode): RiffLayer {
  const nodes = layer.nodes ?? [];
  return nodes.some((n) => n.id === node.id)
    ? { ...layer, nodes: nodes.map((n) => (n.id === node.id ? node : n)) }
    : { ...layer, nodes: [...nodes, node] };
}

/** Nodes nothing plays any more and that hold no notes — a fresh node swapped
 *  away or removed before a note went in — dropped, so the lane's node
 *  chips don't fill with empty letters. A node with notes is kept: it is
 *  work, even when no instance plays it right now. */
export function withoutEmptyUnusedNodes(layer: RiffLayer): RiffLayer {
  const used = new Set<string>();
  for (const it of layer.items as RiffPatternItem[]) for (const e of it.sequence) used.add(e.type);
  for (const c of layer.combos ?? []) for (const e of c.sequence) used.add(e.type);
  const nodes = layer.nodes ?? [];
  const kept = nodes.filter((n) => used.has(n.id) || nodeNotes(n).length > 0);
  return kept.length === nodes.length ? layer : { ...layer, nodes: kept };
}

/** Is this sequence entry a node of the lane (not a combo or a rest)? */
export function isNodeEntry(layer: RiffLayer, type: string): boolean {
  return type !== RIFF_NODE_SILENCE_ID && (layer.nodes ?? []).some((n) => n.id === type);
}

// ── A draft ─────────────────────────────────────────────────────────────────

/** An instance built on the lane that is not kept yet: it and the nodes made
 *  for it are nothing until Done. */
export interface RiffDraft { layerId: string; itemId: string; nodeIds: readonly string[] }

/** `doc` without the draft — its instance, and every node made for it that no
 *  other instance plays. The same document when there is nothing to remove,
 *  so untouched undo snapshots keep their identity. */
export function withoutRiffDraft<D extends AnnotationLayersDocument | null>(doc: D, draft: RiffDraft): D {
  if (!doc) return doc;
  const layer = doc.layers.find((l) => l.id === draft.layerId && l.type === 'riff-patterns') as RiffLayer | undefined;
  if (!layer) return doc;
  const items = (layer.items as RiffPatternItem[]).filter((it) => it.id !== draft.itemId);
  const used = new Set(items.flatMap((it) => it.sequence.map((e) => e.type)));
  const nodes = (layer.nodes ?? []).filter((n) => !draft.nodeIds.includes(n.id) || used.has(n.id));
  if (items.length === layer.items.length && nodes.length === (layer.nodes ?? []).length) return doc;
  return {
    ...doc,
    layers: doc.layers.map((l) => (l === layer ? ({ ...layer, items, nodes } as AnnotationLayer) : l)),
  };
}
