/**
 * Multi-row drum grooves (`drum_kit_pattern.py`) → a riff-patterns layer.
 *
 * A groove is three lines played at once — kick, snare, hat — and a RiffNode
 * holds one line of steps. Rather than widen the node, each drum becomes its
 * OWN node and its own instance, all three placed over the same bars. The lane
 * stacks overlapping instances into separate rows by itself (`assignLanes` in
 * RiffPatternLaneRow), so three instances at one time range already draw as the
 * three-line drum staff the groove actually is — with no schema change, so
 * every existing node, migration, editor and export keeps working, and the
 * three rows stay individually editable.
 *
 * Grooves are keyed by their LETTER, not by their run. The generator gives a
 * groove that returns later in the song the letter it had before, and that is
 * exactly the riff model's node/instance split: one node per (letter, drum),
 * one instance per run. Copying each run into fresh nodes would throw that away
 * and leave nothing in the document saying the drop plays the verse's groove.
 *
 * Velocity rides along as `RiffNode.accents` (step -> 1..127), which the chip
 * grid draws as brightness: a ghost note faint, a backbeat full. It is advisory
 * — a step with no entry draws at full strength — so hand-drawn nodes and every
 * existing edit path are unaffected. Deviation detail is preserved differently:
 * see `describeVariants`.
 */

import {
  fitRiffInstanceEnd,
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  nodeEntryLengthSteps,
  normalizePatternAccents,
  normalizeStepAccents,
  pickRiffNodeColor,
  resizeRiffNodeLength,
  type AnnotationLayer,
  type RiffNode,
  type RiffPatternItem,
} from '../../types/annotationLayer';

/** One repeat of a groove and how far it strayed from the canonical bar. */
export interface GrooveOccurrence {
  index: number;
  start_ms: number;
  /** Jaccard distance from the canonical bar: 0 = played exactly. */
  deviation: number;
  added: { row: string; step: number }[];
  missing: { row: string; step: number }[];
  relabelled: { step: number; from: string; to: string }[];
}

export interface GrooveRow {
  row: string;
  highlighted_beats: number[];
  accents?: number[];
}

/** One groove as `drum_kit_pattern.py` emits it. */
export interface GrooveItem {
  start_ms: number;
  duration_ms: number;
  label?: string | null;
  repeat_count: number;
  steps_per_cycle?: number | null;
  rows?: GrooveRow[];
  /** Single-row fallback: what the older `drum_pattern.py` emits instead of
   *  `rows`. The union of all rows when both are present. */
  highlighted_beats?: number[] | null;
  occurrences?: GrooveOccurrence[];
  /** The figure's identity — the groove LETTER, shared by every run of the
   *  same groove. `label` describes one run ("Drum groove A (10 hits/bar)");
   *  this is the "A". */
  motif?: string | null;
  groove?: string;
  exact_repeats?: number;
  variant_repeats?: number;
}

/** Drum → node colour. Matches the cue-lane hues in utils/drumHits.ts so a hit
 *  and the groove step it belongs to read as the same instrument across the
 *  two surfaces. */
const ROW_COLORS: Record<string, string> = {
  kick: '#f87171',
  snare: '#38bdf8',
  hat: '#a3e635',
};

const ROW_ORDER = ['kick', 'snare', 'hat'];

/** "kick" → "Kick"; the unnamed single-row case stays unnamed. */
function titled(row: string): string {
  return row ? row.charAt(0).toUpperCase() + row.slice(1) : '';
}

/**
 * What the lane writes on the block: "Groove A · Kick".
 *
 * Built from the MOTIF, not the label. A label describes one run and carries
 * its hit count ("Drum groove A (10 hits/bar)"); prefixing that with "Groove "
 * produced "Groove Drum groove A (10 hits/bar) · Kick", which says the word
 * groove twice and is then truncated to "Gro…" in any block narrower than a
 * few bars — so the one thing a person needs off the block, WHICH DRUM, was
 * the part that got cut.
 */
function nodeName(motif: string, row: string): string {
  const drum = titled(row);
  return drum ? `${motif} · ${drum}` : motif;
}

/**
 * One line per repeat that differs, naming the drum and step that moved.
 *
 * This is where the deviation detail lands. An instance is one groove repeated
 * `repeatCount` times and the riff model has no per-repeat content — the whole
 * point of an instance is that the repeats are the same — so the variants are
 * written into the instance's description, which the annotation card shows.
 * Putting each repeat in its own instance instead would say the opposite of
 * what the generator found: that these bars are NOT a repeating groove.
 */
export function describeVariants(item: GrooveItem, row: string): string {
  const occ = item.occurrences ?? [];
  const exact = occ.filter((o) => o.deviation === 0).length;
  const mine = occ
    .map((o, i) => {
      const added = (o.added ?? []).filter((a) => a.row === row);
      const missing = (o.missing ?? []).filter((m) => m.row === row);
      if (!added.length && !missing.length) return null;
      const parts = [
        ...missing.map((m) => `-${m.step}`),
        ...added.map((a) => `+${a.step}`),
      ];
      return `repeat ${i + 1}: ${parts.join(' ')}`;
    })
    .filter((x): x is string => x !== null);
  const head = `${occ.length} repeats · ${exact} exact, ${occ.length - exact} with variations`;
  if (mine.length === 0) {
    return `${head}. ${titled(row) || 'This pattern'} is identical in every repeat.`;
  }
  // Step numbers are 0-based 16th steps within the bar, as the chip grid counts.
  return `${head}. ${titled(row) || 'It'} differs — ${mine.join('; ')} (step index, − dropped, + added).`;
}

/**
 * Build the layer. Returns `null` when there is nothing to place — no grooves,
 * or no bpm (a riff node's length is measured in beats, so without a grid there
 * is nothing to measure it against), so the caller can fall back rather than
 * writing a layer of zero-length nodes.
 */
export function riffLayerFromDrumGrooves(
  grooves: readonly GrooveItem[],
  bpm: number | undefined,
  opts: { name: string; layerColor: string; importedFrom: string },
): AnnotationLayer<'riff-patterns'> | null {
  if (!bpm || bpm <= 0) return null;
  const beatsPerSec = bpm / 60;

  const nodes: RiffNode[] = [];
  const items: RiffPatternItem[] = [];
  // (canonical bar, drum) → node, so a groove that comes back reuses its nodes.
  const nodeByKey = new Map<string, RiffNode>();
  // Display name → the identity that claimed it. Two runs of groove A whose
  // canonical bars differ are different nodes but want the same name, and a
  // palette with two entries called "Groove A · Kick" cannot be told apart.
  const nameOwner = new Map<string, string>();

  const uniqueName = (base: string, identity: string): string => {
    let name = base;
    for (let n = 2; (nameOwner.get(name) ?? identity) !== identity; n += 1) {
      name = `${base} (${n})`;
    }
    nameOwner.set(name, identity);
    return name;
  };

  for (const groove of grooves) {
    const cycleSec = groove.duration_ms / 1000;
    if (!(cycleSec > 0)) continue;
    const lengthBeats = Math.max(1 / 4, cycleSec * beatsPerSec);
    // The MOTIF names the figure and is shared by every run of it — that is
    // what the node reuse is for, and what says the drop plays the verse's
    // groove rather than a lookalike.
    const motif = groove.motif || groove.groove || '';
    const display = motif ? `Groove ${motif}` : (groove.label || 'Pattern');

    // A pattern from the older single-row generator (`drum_pattern.py`, and
    // every curated_*_pattern layer already on disk) has no `rows` — it is one
    // undifferentiated line of hits. Treat it as a single unnamed row rather
    // than skipping it, so those layers render here too.
    const declared = groove.rows ?? [];
    const rows = (declared.length > 0
      ? declared
      : [{ row: '', highlighted_beats: groove.highlighted_beats ?? [] }])
      .filter((r) => (r.highlighted_beats ?? []).length > 0)
      .sort((a, b) => ROW_ORDER.indexOf(a.row) - ROW_ORDER.indexOf(b.row));

    for (const row of rows) {
      // Keyed on the BAR, not on the motif alone. The generator groups runs by
      // similarity rather than equality, so groove A can return playing a
      // different bar — on one house track two runs labelled "A (10 hits/bar)"
      // had different snares. Sharing a node there would draw the first run's
      // steps over the second and the lane would be quietly lying about what
      // is played, which is the one thing it exists to say.
      const key = `${motif}::${row.row}::${(row.highlighted_beats ?? []).join(',')}`;
      let node = nodeByKey.get(key);
      if (!node) {
        const name = uniqueName(nodeName(display, row.row), key);
        const base = newRiffNode(name, ROW_COLORS[row.row] ?? pickRiffNodeColor(nodes));
        // Length and content go through the resizer + normaliser rather than
        // being written onto the node: that is what keeps a step from being
        // both a lone tick and inside a span, and keeps ticks inside the grid.
        const sized = resizeRiffNodeLength(base, lengthBeats);
        const content = normalizePatternAccents(
          row.highlighted_beats,
          [],
          sized.stepsPerCycle,
        );
        // `accents` is positional against `highlighted_beats`, as the generator
        // writes it; pair them up before the ticks are normalised out of order.
        const measured: Record<number, number> = {};
        (row.accents ?? []).forEach((velocity, idx) => {
          const step = row.highlighted_beats[idx];
          if (step != null && Number.isFinite(velocity)) measured[step] = velocity;
        });
        const accents = normalizeStepAccents(measured, sized.stepsPerCycle);
        node = { ...base, ...sized, ...content, ...(accents ? { accents } : {}) };
        nodes.push(node);
        nodeByKey.set(key, node);
      }

      const startSec = groove.start_ms / 1000;
      const repeats = Math.max(1, Math.floor(groove.repeat_count || 1));
      const item: RiffPatternItem = {
        ...newRiffPatternItem(startSec, startSec + cycleSec, node.name),
        sequence: [newRiffSeqEntry(node.id, nodeEntryLengthSteps(node))],
        repeatCount: repeats,
        description: describeVariants(groove, row.row),
      };
      // `end` is derived from the sequence, never stored on its own — snap it
      // to what the entry actually spans rather than the generator's raw ms.
      items.push(fitRiffInstanceEnd(item, bpm));
    }
  }

  if (items.length === 0) return null;
  items.sort((a, b) => a.start - b.start);

  return {
    ...newRiffPatternLayer(opts.name, opts.layerColor),
    nodes,
    items,
    source: 'user',
    importedFrom: opts.importedFrom,
  };
}

export { ROW_COLORS as DRUM_ROW_COLORS };
