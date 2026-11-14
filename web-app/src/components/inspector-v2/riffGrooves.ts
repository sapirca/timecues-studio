/**
 * A riff-patterns layer → what the groove lane draws (GrooveLaneRow).
 *
 * One renderer for every repeated figure: a detector's drum groove and a riff
 * lane of your own are both drawn bar by bar, each cell the figure as played,
 * a play that differed from its node drawn over it in grey (what it dropped
 * hollow, what it added ringed), the runs lettered. This
 * reads a riff layer into that shape.
 *
 *   * Every node occurrence is a CELL: each repeat of each instance, each
 *     entry of its sequence, each leaf of a combo, in its own span of time.
 *   * A cell plays its node, changed by the instance's occurrence for that
 *     play when it has one (`RiffPatternItem.occurrences`).
 *   * A RUN is neighbouring cells of one node — A ×3 then A ×7 read as one
 *     run of A, as the detector's lane reads it.
 *
 * `refs` says, for each cell, which instance, repeat, entry and node it came
 * from, so a click on it can open or edit the right thing. Pure: no React.
 */

import {
  riffNodeLengthBeats,
  type AnnotationLayer,
  type RiffEvent,
  type RiffNode,
  type RiffOccurrence,
  type RiffPatternItem,
} from '../../types/annotationLayer';
import { barIndexAt } from '../../utils/beatGrid';
import { riffPlays } from '../../utils/riffPlays';
import { midiNoteName } from '../../utils/drumHits';
import { deleteNote, placeNote, pulseOf, toNotesNode } from '../../utils/pitchedRiff';
import type { LaneGridProps } from './BeatGridOverlay';
import {
  GROOVE_ROWS,
  type Groove,
  type GrooveBar,
  type GrooveLaneModel,
  type GrooveRow,
  type GrooveStep,
} from './drumGrooves';

/** Where a cell came from in the layer. */
export interface RiffCellRef {
  itemId: string;
  rep: number;
  entryIndex: number;
  /** The node the cell draws; null for a rest. */
  nodeId: string | null;
  /** The cell is one leaf of a combo, which every placement of the combo
   *  shares — so it cannot be changed for this bar alone. */
  inCombo: boolean;
  /** Which play of the instance the cell is: `rep × entries + entryIndex`,
   *  the index its occurrence carries (`RiffOccurrence.index`). */
  play: number;
}

export interface RiffGrooveLane {
  model: GrooveLaneModel;
  refs: RiffCellRef[];
  /** Stacked lanes: instances that overlap in time draw one under another. */
  laneCount: number;
}

/** What a rest's cell is called: the riff lane's silence glyph. */
export const REST_MOTIF = '◌';
const REST_COLOR = '#475569';

/** How much two instances may overlap and still count as touching, in
 *  seconds: a run stored as `start + cycle × repeats` drifts by rounding
 *  against the next run's own start, and a 1 ms overlap must not open a lane.
 *  A 16th note is 75 ms even at 200 BPM. */
const TOUCH_S = 0.02;

function emptyRows(): Record<GrooveRow, GrooveStep[]> {
  return Object.fromEntries(GROOVE_ROWS.map((r) => [r, []])) as unknown as Record<GrooveRow, GrooveStep[]>;
}

/** The row a layer's figures are drawn on: its drum, or one plain line. */
export function riffRow(layer: Pick<AnnotationLayer, 'drum'>): GrooveRow {
  const d = layer.drum;
  return d && (GROOVE_ROWS as readonly string[]).includes(d) ? d as GrooveRow : 'notes';
}

/** A node's notes as steps of its own pulse: where each starts, how long it
 *  is held, how hard it is struck, and its pitch when it has one. */
export function nodeSteps(node: RiffNode): { steps: number; hits: GrooveStep[] } {
  const pulse = pulseOf(node);
  const hits: GrooveStep[] = [];
  for (const seg of node.segments ?? []) {
    if (seg.kind !== 'tick') continue;
    const step = Math.round(seg.start * pulse);
    const length = Math.max(1, Math.round((seg.end - seg.start) * pulse));
    hits.push({
      step,
      state: 'played',
      ...(length > 1 ? { length } : {}),
      ...(seg.accent != null ? { velocity: seg.accent } : {}),
      ...(seg.note != null ? { label: midiNoteName(seg.note) } : seg.label ? { label: seg.label } : {}),
    });
  }
  return { steps: Math.max(1, node.stepsPerCycle), hits };
}

/** The node's hits as one play struck them: every hit the occurrence left
 *  out marked missing, every hit it added ringed in. */
function asPlayed(node: RiffNode, hits: GrooveStep[], occ: RiffOccurrence | undefined): GrooveStep[] {
  if (!occ) return hits;
  const pulse = pulseOf(node);
  const stepOf = (beat: number) => Math.round(beat * pulse);
  const missing = new Set((occ.missing ?? []).map((m) => stepOf(m.start)));
  const added: GrooveStep[] = (occ.added ?? []).map((a) => {
    const length = Math.max(1, Math.round((a.end - a.start) * pulse));
    return {
      step: stepOf(a.start),
      state: 'added',
      ...(length > 1 ? { length } : {}),
      ...(a.accent != null ? { velocity: a.accent } : {}),
      ...(a.note != null ? { label: midiNoteName(a.note) } : a.label ? { label: a.label } : {}),
    };
  });
  return [
    ...hits.map((h) => (missing.has(h.step) ? { ...h, state: 'missing' as const } : h)),
    ...added,
  ].sort((a, b) => a.step - b.step);
}

/** Stacked lanes for instances that overlap in time — decided stretch by
 *  stretch. Instances that overlap, directly or through a chain, share a
 *  stretch and split it into as many lanes as it needs; an instance nothing
 *  overlaps keeps the whole height. (It used to be one count for the whole
 *  song, so a single overlap anywhere halved every riff on the lane.)
 *  `laneCount` is the most any stretch needs — the row's height. */
function assignLanes(items: readonly RiffPatternItem[]): {
  laneById: Map<string, number>;
  lanesById: Map<string, number>;
  laneCount: number;
} {
  const spans = items
    .map((it) => ({
      id: it.id,
      start: it.start,
      end: it.start + Math.max(0.01, it.end - it.start) * Math.max(1, Math.floor(it.repeatCount)),
    }))
    .sort((a, b) => a.start - b.start);
  const laneById = new Map<string, number>();
  const lanesById = new Map<string, number>();
  let laneCount = 1;
  let i = 0;
  while (i < spans.length) {
    // One stretch: every span that starts before the stretch so far ends.
    const group = [spans[i]];
    let groupEnd = spans[i].end;
    let j = i + 1;
    while (j < spans.length && spans[j].start < groupEnd - TOUCH_S) {
      group.push(spans[j]);
      groupEnd = Math.max(groupEnd, spans[j].end);
      j += 1;
    }
    const laneEnds: number[] = [];
    for (const s of group) {
      let lane = laneEnds.findIndex((end) => end <= s.start + TOUCH_S);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(s.end); } else laneEnds[lane] = s.end;
      laneById.set(s.id, lane);
    }
    for (const s of group) lanesById.set(s.id, laneEnds.length);
    laneCount = Math.max(laneCount, laneEnds.length);
    i = j;
  }
  return { laneById, lanesById, laneCount };
}

/** A name per node that no other node has, so a card can find its groove by
 *  name: two hand-drawn nodes both called "Kick" become "Kick" and "Kick (2)". */
function uniqueNames(nodes: readonly RiffNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const n of nodes) {
    const base = n.name || 'Node';
    let name = base;
    for (let k = 2; used.has(name); k += 1) name = `${base} (${k})`;
    used.add(name);
    out.set(n.id, name);
  }
  return out;
}

export function riffGrooveLane(layer: AnnotationLayer<'riff-patterns'>, grid?: LaneGridProps): RiffGrooveLane {
  const nodes = layer.nodes ?? [];
  const items = [...(layer.items as RiffPatternItem[])].sort((a, b) => a.start - b.start);
  const row = riffRow(layer);
  const nameOf = uniqueNames(nodes);
  const stepsOf = new Map(nodes.map((n) => [n.id, nodeSteps(n)]));
  const bpm = grid?.bpm && grid.bpm > 0 ? grid.bpm : 0;
  const beatsPerBar = grid?.beatsPerBar ?? 4;
  const barSec = bpm ? (60 / bpm) * beatsPerBar : 0;
  const { laneById, lanesById, laneCount } = assignLanes(items);

  interface Cell { start: number; end: number; lane: number; lanes: number; node: RiffNode | null; occ?: RiffOccurrence; ref: RiffCellRef }
  const cells: Cell[] = riffPlays(layer, bpm).map((p) => ({
    start: p.start, end: p.end,
    lane: laneById.get(p.item.id) ?? 0,
    lanes: lanesById.get(p.item.id) ?? 1,
    node: p.node, occ: p.occ,
    ref: { itemId: p.item.id, rep: p.rep, entryIndex: p.entryIndex, nodeId: p.node?.id ?? null, inCombo: p.inCombo, play: p.play },
  }));
  cells.sort((a, b) => a.start - b.start || a.lane - b.lane);

  const grooves = new Map<string, Groove>();
  const grooveFor = (node: RiffNode, bars: number): Groove => {
    const name = nameOf.get(node.id)!;
    let g = grooves.get(name);
    if (!g) {
      const { steps, hits } = stepsOf.get(node.id)!;
      const rows = emptyRows();
      rows[row] = hits;
      g = {
        motif: name,
        family: name,
        names: node.names ?? [],
        steps,
        loopBars: bars,
        rows,
        bars: 0,
        events: { exact: 0, variation: 0, fill: 0, drop: 0 },
      };
      grooves.set(name, g);
    }
    return g;
  };

  const bars: GrooveBar[] = [];
  // The last cell of each lane, for joining runs: a run is one lane's.
  const lastInLane = new Map<number, { bar: GrooveBar; node: string | null; changed: boolean; first: GrooveBar }>();
  let run = -1;
  cells.forEach((c, i) => {
    const cellBars = barSec ? Math.max(1, Math.round((c.end - c.start) / barSec)) : 1;
    const name = c.node ? nameOf.get(c.node.id)! : REST_MOTIF;
    const own = c.node ? stepsOf.get(c.node.id)! : { steps: 16, hits: [] };
    const played = c.node ? asPlayed(c.node, own.hits, c.occ) : own.hits;
    const event: RiffEvent = !c.node ? 'drop' : c.occ?.event ?? 'exact';
    const changed = played.filter((s) => s.state !== 'played').length;
    const rows = emptyRows();
    rows[row] = played;

    const prev = lastInLane.get(c.lane);
    const nodeId = c.node?.id ?? null;
    const joins = !!prev && prev.node === nodeId && Math.abs(prev.bar.end - c.start) < TOUCH_S;
    if (!joins) run += 1;
    const bar: GrooveBar = {
      bar: bpm ? barIndexAt(c.start + 1e-3, bpm, grid?.gridOffset ?? 0, beatsPerBar, grid?.segments) + 1 : i + 1,
      bars: cellBars,
      start: c.start,
      end: c.end,
      motif: name,
      event,
      deviation: changed ? Math.round((changed / Math.max(1, played.length)) * 1e4) / 1e4 : 0,
      loopBars: cellBars,
      steps: own.steps,
      stepsPerBar: own.steps / cellBars,
      rows,
      runBars: 0,
      run,
      // An exact repeat of the cell before it, inside one run. A play that
      // differed is news every time, and so is the first bar back to the node
      // after it.
      repeat: joins && !c.occ && !prev!.changed,
      lane: c.lane,
      lanes: c.lanes,
    };
    const first = joins ? prev!.first : bar;
    first.runBars += 1;
    lastInLane.set(c.lane, { bar, node: nodeId, changed: !!c.occ, first });
    bars.push(bar);

    if (c.node) {
      const g = grooveFor(c.node, cellBars);
      g.bars += cellBars;
      g.events[event] += 1;
    }
  });

  const colorByName = new Map<string, string>();
  for (const n of nodes) colorByName.set(nameOf.get(n.id)!, n.color);

  return {
    model: {
      rows: [row],
      bars,
      grooves: [...grooves.values()],
      colorOf: (motif) => (motif === REST_MOTIF ? REST_COLOR : colorByName.get(motif) ?? layer.color),
    },
    refs: cells.map((c) => c.ref),
    laneCount,
  };
}

// ── Editing a bar from the card ─────────────────────────────────────────────

/** Does a note `[start, end)` sound at `at`? A held note covers every step
 *  it rings through, not only the one it starts on — so a click anywhere on
 *  it is a click on that note, and takes it away, instead of dropping a new
 *  hit inside it (which split the hold in two). */
function covers(s: { start: number; end?: number }, at: number): boolean {
  return at > s.start - 1e-6 && at < (s.end ?? s.start) - 1e-6;
}

/** A node with one step toggled: the note sounding there removed (the whole
 *  note, however long it is held), or a one-step hit added (with no pitch — a
 *  tap). On the node's own pulse. */
function withStepToggled(node: RiffNode, step: number): RiffNode {
  const n = toNotesNode(node);
  const pulse = pulseOf(n);
  const len = riffNodeLengthBeats(n);
  const at = step / pulse;
  const segments = n.segments ?? [];
  const hit = segments.findIndex((s) => s.kind === 'tick' && covers(s, at));
  return {
    ...n,
    segments: hit >= 0 ? deleteNote(segments, hit, len) : placeNote(segments, at, at + 1 / pulse, null, len),
  };
}

/** The layer with `step` of a node toggled — every bar that plays the node
 *  changes, which is what a node means: these bars are the same. */
export function toggleNodeStep(
  layer: AnnotationLayer<'riff-patterns'>,
  nodeId: string,
  step: number,
): AnnotationLayer<'riff-patterns'> {
  return {
    ...layer,
    nodes: (layer.nodes ?? []).map((n) => (n.id === nodeId ? withStepToggled(n, step) : n)),
  };
}

/** The event a play's difference makes: nothing struck is a drop-out, only
 *  hits added a fill, anything else a variation. */
export function riffEventOf(struck: number, added: number, missing: number): RiffEvent {
  if (struck === 0) return 'drop';
  return added && !missing ? 'fill' : 'variation';
}

/** Only this bar: `step` toggled on one play of the instance — a hit of the
 *  node there is left out, an empty step gets a hit added — written as that
 *  play's occurrence. The node, and every other bar that plays it, stays as
 *  it was. A toggle that brings the play back to its node removes the
 *  occurrence. Null when the bar is a rest or one leaf of a combo, which
 *  every placement of the combo shares. */
export function toggleBarStep(
  layer: AnnotationLayer<'riff-patterns'>,
  ref: RiffCellRef,
  step: number,
): AnnotationLayer<'riff-patterns'> | null {
  const node = (layer.nodes ?? []).find((n) => n.id === ref.nodeId);
  const items = layer.items as RiffPatternItem[];
  const item = items.find((it) => it.id === ref.itemId);
  if (!node || !item || ref.inCombo) return null;
  const pulse = pulseOf(node);
  const at = step / pulse;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const prev = (item.occurrences ?? []).find((o) => o.index === ref.play);
  let added = [...(prev?.added ?? [])];
  let missing = [...(prev?.missing ?? [])];
  // An added note is checked first: it is what this play shows on top of the
  // node, so a click on it takes back that addition. Either kind is matched by
  // the span it holds, not only its first step.
  const ownAdded = added.find((a) => covers(a, at));
  const inNode = ownAdded ? undefined : node.segments.find((s) => s.kind === 'tick' && covers(s, at));
  if (ownAdded) {
    added = added.filter((a) => a !== ownAdded);
  } else if (inNode) {
    missing = missing.some((m) => near(m.start, inNode.start))
      ? missing.filter((m) => !near(m.start, inNode.start))
      : [...missing, { start: inNode.start }].sort((a, b) => a.start - b.start);
  } else {
    added = [...added, { start: at, end: at + 1 / pulse }].sort((a, b) => a.start - b.start);
  }
  const struck = node.segments.filter((s) => s.kind === 'tick').length - missing.length + added.length;
  const occ: RiffOccurrence | null = added.length || missing.length
    ? {
      index: ref.play,
      event: riffEventOf(struck, added.length, missing.length),
      ...(added.length ? { added } : {}),
      ...(missing.length ? { missing } : {}),
    }
    : null;
  const rest = (item.occurrences ?? []).filter((o) => o.index !== ref.play);
  const occurrences = (occ ? [...rest, occ] : rest).sort((a, b) => a.index - b.index);
  const next: RiffPatternItem = { ...item, occurrences };
  if (!occurrences.length) delete next.occurrences;
  return { ...layer, items: items.map((it) => (it.id === item.id ? next : it)) };
}
