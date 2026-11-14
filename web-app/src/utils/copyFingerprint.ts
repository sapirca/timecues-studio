/**
 * Is a copy already there? A lane's ⬇ clicked twice, with nothing changed in
 * between, used to make two identical layers. Each copy now asks first whether
 * a layer of yours already holds exactly what it would make — and if one
 * does, makes nothing.
 *
 * "Exactly" is what the layer says, not how it is stored: every copy gets new
 * ids, beat stamps are derived from the seconds, and a riff's sequence points
 * at its nodes by id. So the fingerprint drops those and reads a riff entry as
 * the node it plays (its name and notes). Once you edit your copy, it no
 * longer matches, and a fresh copy is made beside it. Cheap: one pass over the
 * items.
 */

import {
  RIFF_NODE_SILENCE_ID,
  type AnnotationLayer,
  type RiffCombo,
  type RiffNode,
  type RiffPatternItem,
} from '../types/annotationLayer';

/** Fields that differ between two copies of the same thing. */
const BOOKKEEPING = new Set(['id', 'startBeat', 'endBeat', 'duplicateOfId']);

/** Seconds to the millisecond: a copy and its re-copy agree to that. */
const ms = (t: unknown) => (typeof t === 'number' ? Math.round(t * 1000) : t);

function plain(item: object): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) {
    if (BOOKKEEPING.has(k)) continue;
    out[k] = k === 'start' || k === 'end' || k === 'time' ? ms(v) : v;
  }
  return JSON.stringify(out);
}

function riffEntryKey(
  id: string,
  nodes: readonly RiffNode[],
  combos: readonly RiffCombo[],
  depth = 0,
): string {
  if (id === RIFF_NODE_SILENCE_ID) return 'rest';
  const node = nodes.find((n) => n.id === id);
  if (node) {
    const notes = (node.segments ?? []).filter((s) => s.kind === 'tick')
      .map((s) => `${s.start}-${s.end}${s.note != null ? `@${s.note}` : ''}${s.accent != null ? `!${s.accent}` : ''}`).join(',');
    return `${node.name}[${node.stepsPerCycle}/${node.subbeatsPerBeat}:${notes}]`;
  }
  const combo = combos.find((c) => c.id === id);
  if (!combo || depth > 8) return '?';
  return `{${combo.name}:${combo.sequence.map((e) => `${riffEntryKey(e.type, nodes, combos, depth + 1)}*${e.lengthSteps}`).join(' ')}}`;
}

/** The parts of a layer a copy writes: what it holds, and where from. */
type CopiedLayer = Pick<AnnotationLayer, 'type' | 'items' | 'importedFrom'>
  & Partial<Pick<AnnotationLayer, 'nodes' | 'combos' | 'drum' | 'summary'>>;

/** What a layer says, with every id and derived field left out. */
export function copyFingerprint(layer: CopiedLayer): string {
  if (layer.type === 'riff-patterns') {
    const nodes = layer.nodes ?? [];
    const combos = layer.combos ?? [];
    const items = (layer.items as RiffPatternItem[])
      .map((it) => `${ms(it.start)}x${it.repeatCount}:${it.label}:${it.sequence
        .map((e) => `${riffEntryKey(e.type, nodes, combos)}*${e.lengthSteps}`).join(' ')}${it.occurrences?.length ? `~${JSON.stringify(it.occurrences)}` : ''}`)
      .sort();
    return `riff|${layer.drum ?? ''}|${layer.summary ?? ''}|${items.join('\n')}`;
  }
  return `${layer.type}|${(layer.items as object[]).map(plain).sort().join('\n')}`;
}

/** A layer of yours, from the same source, that already says what `made`
 *  says — or null when the copy would be new. */
export function sameCopy(
  made: CopiedLayer,
  layers: readonly AnnotationLayer[],
): AnnotationLayer | null {
  const want = copyFingerprint(made);
  return layers.find((l) => !l.readOnly && l.type === made.type
    && l.importedFrom === made.importedFrom && copyFingerprint(l) === want) ?? null;
}
