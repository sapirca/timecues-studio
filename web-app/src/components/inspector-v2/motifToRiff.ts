/**
 * PATTERN-family (LoCoMotif) motif output → a riff-patterns layer.
 *
 * A motif detector answers "this figure recurs — here, and here, and here",
 * which is precisely what the riff model expresses: the figure is a NODE, each
 * occurrence an INSTANCE of it. Copying the overlay into spans (what every
 * other interval family does) throws that away — you get N unrelated bands and
 * nothing in the document records that they are the same motif.
 *
 * Each `motif_id` becomes one **boundary** node. LoCoMotif reports where a
 * motif sits, never how it is subdivided, and a boundary node is the kind that
 * holds arbitrary time spans rather than beat cells — so the block is honest
 * about what the model actually claimed. A grid node would invent a chip grid
 * and show it empty, which reads as "this motif accents nothing".
 *
 * A node's natural length is the MEDIAN occurrence length: LoCoMotif warps
 * occurrences against each other (DTW), so they genuinely differ in duration
 * and no single one of them is the right answer. Each instance then carries
 * its own length in its sequence entry, which is what `lengthSteps` is for.
 */

import {
  PATTERN_SUBBEATS_PER_BEAT,
  fitRiffInstanceEnd,
  newRiffBoundaryNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  normalizeBoundarySegments,
  pickRiffNodeColor,
  type AnnotationLayer,
  type RiffNode,
  type RiffPatternItem,
} from '../../types/annotationLayer';

/** The shape an AlgoOverlay section carries; `type` is the motif key
 *  (`"motif-3"`), which is what groups occurrences of the same figure. */
export interface MotifSection {
  time: number;
  endTime: number;
  label: string;
  type: string;
}

/** `"motif-3"` → `"Motif 3"`; anything else is title-cased as-is so an
 *  unexpected key still reads as a name rather than a slug. */
function nodeNameFor(type: string): string {
  const m = /^motif-(\d+)$/.exec(type);
  if (m) return `Motif ${m[1]}`;
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Motif';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Build the layer. Returns `null` when the conversion can't be made
 *  meaningfully — no BPM (a riff node is measured in beats, so without a grid
 *  there is nothing to measure it against) or no usable occurrence — so the
 *  caller can fall back to its normal span copy rather than writing a layer
 *  full of zero-length nodes. */
export function riffLayerFromMotifs(
  sections: readonly MotifSection[],
  bpm: number | undefined,
  opts: { name: string; layerColor: string; importedFrom: string },
): AnnotationLayer<'riff-patterns'> | null {
  if (!bpm || bpm <= 0) return null;
  const beatsPerSec = bpm / 60;

  // Group by motif key, keeping first-appearance order so the nodes come out
  // in the order the song introduces them.
  const groups = new Map<string, MotifSection[]>();
  for (const s of sections) {
    if (!(s.endTime > s.time)) continue;   // zero/negative width: nothing to place
    const key = s.type || 'motif';
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  if (groups.size === 0) return null;

  const nodes: RiffNode[] = [];
  const items: RiffPatternItem[] = [];

  for (const [key, occurrences] of groups) {
    const name = nodeNameFor(key);
    const lengthsBeats = occurrences.map((s) => (s.endTime - s.time) * beatsPerSec);
    const naturalBeats = Math.max(1 / PATTERN_SUBBEATS_PER_BEAT, median(lengthsBeats));

    const node = newRiffBoundaryNode(name, pickRiffNodeColor(nodes), naturalBeats);
    // One sounding block across the whole node: the model said a figure runs
    // here, and said nothing about rests inside it.
    const segments = normalizeBoundarySegments(
      [{ start: 0, end: naturalBeats, kind: 'tick', label: name }],
      naturalBeats,
    );
    nodes.push({ ...node, segments });

    for (const s of occurrences) {
      const beats = (s.endTime - s.time) * beatsPerSec;
      const lengthSteps = Math.max(1, Math.round(beats * PATTERN_SUBBEATS_PER_BEAT));
      const item: RiffPatternItem = {
        ...newRiffPatternItem(s.time, s.endTime, s.label || name),
        sequence: [newRiffSeqEntry(node.id, lengthSteps)],
      };
      // `end` is derived from the sequence, never stored independently — so
      // snap it to what the entry actually spans instead of the detector's
      // raw end, which sits between two sub-beats.
      items.push(fitRiffInstanceEnd(item, bpm));
    }
  }

  items.sort((a, b) => a.start - b.start);

  return {
    ...newRiffPatternLayer(opts.name, opts.layerColor),
    nodes,
    items,
    source: 'user',
    importedFrom: opts.importedFrom,
  };
}
