/**
 * One detector's cached run → the read-only lane the canvas draws for it.
 *
 * Algorithm Inspect draws every detector's lane from these, and the Playground
 * draws the one detector it is editing from the same functions, so a lane
 * looks the same in both places and a field a detector sets reaches both or
 * neither. Each builder returns null when there is nothing to draw: no run, a
 * run that failed, a run with no items, or a detector of another output kind.
 */
import type {
  CustomBoundaryItem,
  CustomCueItem,
  CustomLaneKind,
  CustomLoopItem,
  CustomLyricsItem,
  CustomRegistryEntry,
  CustomResultEnvelope,
  CustomRiffItem,
  CustomSpanItem,
} from '../../types/customScript';
import {
  RIFF_COMBO_COLORS,
  RIFF_NODE_COLORS,
  newRiffPatternLayer,
  type AnnotationLayer,
  type CueItem,
  type LoopItem,
  type LyricsItem,
  type SpanItem,
} from '../../types/annotationLayer';
import { struckHitFields } from '../../utils/drumHits';
import { stemFilingLabel } from '../../utils/detectorStems';
import { detectorLyricsOnsets, detectorSpanFields } from './detectorConvert';

// Distinct, vivid colors cycled per detector so each lane stands out from the
// others; wraps around if there are more detectors than palette entries.
export const CUSTOM_ANNOTATION_PALETTE: string[] = [
  '#f43f5e', // rose
  '#fb923c', // orange
  '#facc15', // yellow
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#d946ef', // fuchsia
  '#ec4899', // pink
];

/** Detector name → lane colour, across every runnable detector of any kind.
 *  Indexing globally (sorted by name for stability) keeps a span lane and a
 *  cue lane from colliding on the same hue — without it each kind restarts
 *  the palette at rose. */
export function detectorColors(detectors: readonly Pick<CustomRegistryEntry, 'name' | 'status'>[]): Record<string, string> {
  const m: Record<string, string> = {};
  detectors
    .filter((d) => d.status === 'ok')
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name, i) => { m[name] = CUSTOM_ANNOTATION_PALETTE[i % CUSTOM_ANNOTATION_PALETTE.length]; });
  return m;
}

/** The detector fields a lane reads. */
type LaneDetector = Pick<CustomRegistryEntry, 'name' | 'label' | 'stem' | 'description' | 'output_kind'>;

/** Joins a `lanes` detector's name to one lane's id: `instrument_layers~kick_notes`.
 *  The same separator part lanes use, so `partLaneBaseId` reads both. */
export const DETECTOR_LANE_SEP = '~';

/** The registry and results the lane builders draw from, with every `lanes`
 *  detector (output_kind 'lanes') expanded into one single-kind entry per lane.
 *
 *  A lanes detector returns several lanes of different kinds at once — the
 *  Instrument layers' notes (cues) and loops (riffs), per instrument. Every
 *  builder below draws ONE kind from ONE envelope, so each lane becomes the
 *  detector it would have been on its own: named `<detector>~<lane>`, its own
 *  kind, label and group, its items as the envelope's. The builders then need
 *  no change; `asDetectorLane` hands each built lane back to its detector, so
 *  showing, hiding, running and the sidebar treat the detector as one.
 *
 *  A lane of a kind `allowedKinds` leaves out (riffs, with the experimental
 *  Loops & Patterns flag off) is not expanded. */
export function expandDetectorLanes(
  registry: readonly CustomRegistryEntry[],
  results: Readonly<Record<string, CustomResultEnvelope>>,
  allowedKinds?: ReadonlySet<CustomLaneKind>,
): { detectors: CustomRegistryEntry[]; results: Record<string, CustomResultEnvelope> } {
  if (!registry.some((d) => d.output_kind === 'lanes')) {
    return { detectors: [...registry], results: { ...results } };
  }
  const detectors: CustomRegistryEntry[] = [];
  const out: Record<string, CustomResultEnvelope> = { ...results };
  for (const d of registry) {
    if (d.output_kind !== 'lanes') { detectors.push(d); continue; }
    const env = results[d.name];
    // A result saved before the detector had lanes (Drum hits, before its
    // grooves joined it) is one list of one kind: it is shown as the
    // detector's single lane until the next run replaces it, rather than
    // vanishing from every song that has not been re-run.
    const lanes = env?.lanes ?? (env && env.output_kind !== 'lanes' && env.items.length > 0
      ? [{ id: 'saved', label: d.label || d.name, output_kind: env.output_kind, group: null, items: env.items }]
      : []);
    for (const lane of lanes) {
      if (allowedKinds && !allowedKinds.has(lane.output_kind)) continue;
      const name = `${d.name}${DETECTOR_LANE_SEP}${lane.id}`;
      // No stem of its own: the lane is named by its label alone ("Kick
      // notes"), and the band and sidebar row say whose it is.
      detectors.push({ ...d, name, label: lane.label, output_kind: lane.output_kind,
                       group: lane.group, stem: null });
      out[name] = {
        ...env!, name, output_kind: lane.output_kind, items: lane.items,
        // A riff lane's library travels with its items (CustomLane).
        nodes: lane.nodes, combos: lane.combos, drum: lane.drum, summary: lane.summary,
      };
    }
  }
  return { detectors, results: out };
}

/** How many items a run produced: a `lanes` detector's are in its lanes, and
 *  its `items` is empty even when every lane is full. */
export function detectorItemCount(env: Pick<CustomResultEnvelope, 'items' | 'lanes'>): number {
  return env.items.length + (env.lanes ?? []).reduce((n, l) => n + l.items.length, 0);
}

/** The detector a lane belongs to: `instrument_layers~kick_notes` →
 *  `instrument_layers`; any other name as it is. */
export function laneDetectorName(name: string): string {
  const i = name.indexOf(DETECTOR_LANE_SEP);
  return i < 0 ? name : name.slice(0, i);
}

/** A lane built from an expanded lane entry, handed back to its detector:
 *  `source` names the detector itself, so the one sidebar row, the one
 *  show / hide switch and Run all reach it; the lane keeps its own id, its
 *  label, and its items' ids (which carry the lane, see `rawDetectorItem`). */
export function asDetectorLane<T extends { source?: string }>(lane: T): T {
  const src = lane.source ?? '';
  if (!src.startsWith('detector:') || !src.includes(DETECTOR_LANE_SEP)) return lane;
  return { ...lane, source: `detector:${laneDetectorName(src.slice('detector:'.length))}` };
}

// When a detector declares a Demucs stem, swap its label's trailing
// parenthetical tag (e.g. "(curated)", "(LoCoMotif)") for that stem so the
// gutter reads "Vocals presence (vocals)" — telling the annotator which stem
// each curated layer was built upon. Falls back to the raw label when no stem
// is declared or the label has no trailing "(…)".
export function detectorLaneName(label: string, stem?: string | null): string {
  const base = label || '';
  if (!stem) return base;
  const stripped = base.replace(/\s*\([^()]*\)\s*$/, '');
  return `${stripped} (${stemFilingLabel(stem)})`;
}

/** The fields every detector lane carries, whatever it draws. */
function laneSource(d: LaneDetector, env: CustomResultEnvelope) {
  return {
    name: detectorLaneName(d.label || d.name, d.stem),
    sourceStem: d.stem ?? undefined,
    sourceDescription: d.description || undefined,
    sourceNotes: (env.notes && env.notes.length) ? env.notes : undefined,
    readOnly: true,
    source: `detector:${d.name}` as const,
  };
}

/** The run to draw, or null when there is nothing to draw for `kind`. */
function drawable(d: LaneDetector, env: CustomResultEnvelope | null | undefined, kind: string): CustomResultEnvelope | null {
  if (d.output_kind !== kind || !env || env.fatal || env.items.length === 0) return null;
  return env;
}

export function detectorCueLayer(d: LaneDetector, envelope: CustomResultEnvelope | null | undefined, color: string): AnnotationLayer<'cues'> | null {
  const env = drawable(d, envelope, 'cue');
  if (!env) return null;
  const items: CueItem[] = (env.items as CustomCueItem[]).map((it, i) => ({
    id: `${d.name}:${i}:${it.time_ms}`,
    time: it.time_ms / 1000,
    label: it.label ?? '',
    description: it.description ?? undefined,
    candidates: it.candidates && it.candidates.length > 0
      ? it.candidates.map((ms) => ms / 1000)
      : undefined,
    ...struckHitFields(it),
  }));
  return {
    id: `detector-cue:${d.name}`,
    ...laneSource(d, env),
    type: 'cues',
    visible: true,
    color,
    snap: 'beat',
    items,
  };
}

export function detectorSpanLayer(d: LaneDetector, envelope: CustomResultEnvelope | null | undefined, color: string): AnnotationLayer<'spans'> | null {
  const env = drawable(d, envelope, 'span');
  if (!env) return null;
  const items: SpanItem[] = (env.items as CustomSpanItem[]).map((it, i) => ({
    id: `${d.name}:${i}:${it.start_ms}`,
    ...detectorSpanFields(it),
  }));
  return {
    id: `detector-span:${d.name}`,
    ...laneSource(d, env),
    type: 'spans',
    visible: true,
    color,
    snap: 'beat',
    items,
  };
}

export function detectorLoopLayer(d: LaneDetector, envelope: CustomResultEnvelope | null | undefined, color: string): AnnotationLayer<'loops'> | null {
  const env = drawable(d, envelope, 'loop');
  if (!env) return null;
  const items: LoopItem[] = (env.items as CustomLoopItem[]).map((it, i) => ({
    id: `${d.name}:${i}:${it.start_ms}`,
    start: it.start_ms / 1000,
    end: (it.start_ms + it.duration_ms) / 1000,
    label: it.label ?? '',
    snapZeroCross: it.snap_zero_cross ?? undefined,
    ...(it.color ? { color: it.color } : {}),
  }));
  return {
    id: `detector-loop:${d.name}`,
    ...laneSource(d, env),
    type: 'loops',
    visible: true,
    color,
    snap: 'beat',
    items,
  };
}

export function detectorLyricsLayer(d: LaneDetector, envelope: CustomResultEnvelope | null | undefined, color: string): AnnotationLayer<'lyrics'> | null {
  const env = drawable(d, envelope, 'lyrics');
  if (!env) return null;
  const items: LyricsItem[] = (env.items as CustomLyricsItem[]).map((it, i) => ({
    id: `${d.name}:${i}:${it.time_ms}`,
    time: it.time_ms / 1000,
    text: it.text ?? '',
    kind: it.kind,
    ...(it.end_ms != null ? { end: it.end_ms / 1000 } : {}),
    ...detectorLyricsOnsets(it),
  }));
  return {
    id: `detector-lyrics:${d.name}`,
    ...laneSource(d, env),
    type: 'lyrics',
    visible: true,
    color,
    snap: 'off',
    items,
  };
}

// A riff detector's output is a riff-patterns layer already — its nodes, its
// instances and their occurrences, in the shape the layer stores — so the lane
// is that layer, read-only. A node or combo the detector gave no colour gets
// one from the palette; an instance gets an id the detector's run keeps.
export function detectorRiffLayer(
  d: LaneDetector,
  envelope: CustomResultEnvelope | null | undefined,
  color: string,
): AnnotationLayer<'riff-patterns'> | null {
  const env = drawable(d, envelope, 'riff');
  if (!env) return null;
  const { name, ...source } = laneSource(d, env);
  const id = `detector-riff:${d.name}`;
  return {
    ...newRiffPatternLayer(name, color),
    id,
    ...source,
    nodes: (env.nodes ?? []).map((n, i) => ({ ...n, color: n.color ?? RIFF_NODE_COLORS[i % RIFF_NODE_COLORS.length] })),
    combos: (env.combos ?? []).map((c, i) => ({ ...c, color: c.color ?? RIFF_COMBO_COLORS[i % RIFF_COMBO_COLORS.length] })),
    items: (env.items as CustomRiffItem[]).map((it, i) => ({ ...it, id: `${id}:${i}` })),
    ...(env.drum ? { drum: env.drum } : {}),
    ...(env.summary ? { summary: env.summary } : {}),
  };
}

// Convert a CustomResultEnvelope of boundary items into the section shape the canvas expects.
// Each detected boundary becomes the start of a section running up to the next boundary
// (or end-of-track for the final one), matching how the built-in detectors are flattened.
// `color` is per-detector and emitted on each section so the algo row paints with a vivid
// hue instead of falling through to the near-invisible slate-400 default.
export function customEnvelopeToSections(
  env: CustomResultEnvelope,
  trackDuration: number,
  color: string,
): { time: number; endTime: number; label: string; type: string; color: string; ownColor?: string; raw?: unknown }[] {
  if (env.output_kind !== 'boundary') return [];
  // Carry the original CustomBoundaryItem (importance, candidates, …) as `raw`
  // so the algo Inspect card can show the detector's full emitted object.
  const items = (env.items as CustomBoundaryItem[])
    .map((it) => ({ time: it.time_ms / 1000, label: it.label ?? '', raw: it }))
    .sort((a, b) => a.time - b.time);
  return items.map((it, i) => ({
    time: it.time,
    endTime: items[i + 1]?.time ?? (trackDuration > 0 ? trackDuration : it.time),
    label: it.label || 'boundary',
    type: 'custom',
    // The detector's own colour for this section, when it set one; the lane's
    // hue otherwise. Only the former is the section's — see ownColor.
    color: it.raw.color ?? color,
    ...(it.raw.color ? { ownColor: it.raw.color } : {}),
    raw: it.raw,
  }));
}

/** A boundary detector's lane: its boundaries as section blocks (boundaries
 *  have no AnnotationLayer of their own — they draw as an algo-overlay row). */
export function detectorBoundaryLayer(
  d: LaneDetector,
  envelope: CustomResultEnvelope | null | undefined,
  color: string,
  trackDuration: number,
) {
  const env = drawable(d, envelope, 'boundary');
  if (!env) return null;
  return {
    id: `detector-boundary:${d.name}`,
    detectorName: d.name,
    name: detectorLaneName(d.label || d.name, d.stem),
    stem: (d.stem ?? 'mix') as string,
    color,
    sections: customEnvelopeToSections(env, trackDuration, color),
  };
}

/** Whether `label` belongs to part `part`: it is the part's name, or starts
 *  with it and continues with " · " ('Kick · Beat · 8 bars' is Kick's).
 *  Mirrors item_in_parts in tools/python/custom_runner.py. */
export function labelInPart(label: string | null | undefined, part: string): boolean {
  const l = label ?? '';
  return l === part || l.startsWith(`${part} · `);
}

/** A part with fewer spans than this shares a lane with the other sparse
 *  parts rather than taking one of its own — a lane holding one or two spans
 *  is a row of mostly nothing. */
export const MIN_PART_LANE_SPANS = 3;

const PART_LANE_SEP = '~';

/** The whole lane a part lane was cut from (`detector-span:pulse~kick` →
 *  `detector-span:pulse`); the id itself for any other lane. */
export function partLaneBaseId(id: string): string {
  const i = id.indexOf(PART_LANE_SEP);
  return i < 0 ? id : id.slice(0, i);
}

/** A span lane that holds several parts (a detector with `stem_parts`, Pulse)
 *  cut into one lane per part, so kick, snare and hat stop stacking on top of
 *  one another. A part with too few spans for a lane of its own
 *  (MIN_PART_LANE_SPANS) goes in one shared lane with the others like it;
 *  spans that match no part go there too. Parts are in `stem_parts` order and
 *  the shared lane last. When that leaves a single lane, the lane is returned
 *  whole — there is nothing to split.
 *
 *  A part lane is named for its parts alone ('Snare', 'Kick · Hat'): the
 *  band around it already says whose they are, and the gutter is narrow.
 *  Each part lane is still the detector's (`source`, `sourceStem`), so hiding
 *  the detector hides them all and they stack together; the canvas bands them
 *  under the detector's group (utils/detectorGroups). Item ids are untouched,
 *  so review and copy still find each item in the detector's run. */
export function splitLaneByPart(
  layer: AnnotationLayer<'spans'>,
  stemParts: Record<string, string[]> | null | undefined,
): AnnotationLayer<'spans'>[] {
  const parts = Object.values(stemParts ?? {}).flat();
  if (parts.length < 2) return [layer];
  const byPart = new Map<string, SpanItem[]>(parts.map((p) => [p, []]));
  const rest: SpanItem[] = [];
  for (const it of layer.items) {
    const p = parts.find((q) => labelInPart(it.label, q));
    (p ? byPart.get(p)! : rest).push(it);
  }
  const lanes: { parts: string[]; items: SpanItem[] }[] = [];
  const sparse: { parts: string[]; items: SpanItem[] } = { parts: [], items: rest };
  for (const p of parts) {
    const items = byPart.get(p)!;
    if (items.length === 0) continue;
    if (items.length >= MIN_PART_LANE_SPANS) lanes.push({ parts: [p], items });
    else { sparse.parts.push(p); sparse.items.push(...items); }
  }
  if (sparse.items.length > 0) lanes.push(sparse);
  if (lanes.length < 2) return [layer];
  return lanes.map((lane) => {
    const key = lane.parts.length ? lane.parts.join('+').toLowerCase() : 'rest';
    const name = lane.parts.length ? lane.parts.join(' · ') : 'Rest';
    return {
      ...layer,
      id: `${layer.id}${PART_LANE_SEP}${key}`,
      name,
      // A lane of one part in that part's own colour, when the detector gave
      // its spans one; the detector's hue otherwise.
      color: (lane.parts.length === 1 && lane.items[0].color) || layer.color,
      items: [...lane.items].sort((a, b) => a.start - b.start),
    };
  });
}
