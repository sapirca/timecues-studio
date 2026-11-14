// Detector groups: lanes that belong together, drawn as one band.
//
// A detector's `group` names a family of detectors that read one thing
// between them — Phrase edges is a spans lane (breakdowns, fills, rolls)
// and a cues lane (drops, hits). When two or more registered
// detectors share a group, their lanes get the same band on the timeline that
// an annotator's own layer group gets, and a copy of any of them into the
// annotator's layers lands in an annotation group of that name.
//
// One detector can also draw several lanes — Pulse draws a lane per part
// (kick, snare, bass …) — and those get a band too, under its group, or its
// own name when it has none. A `lanes` detector names its lanes' bands itself
// (`DetectorLaneRow.band`): Instrument layers draws a band per instrument.
//
// The band is read-only. Detector lanes are re-derived every render and never
// persisted, so there is no document to rename it in or ungroup it from; it
// can be collapsed (remembered per browser) and shown or hidden (which toggles
// its lanes, the same switch the Detectors sidebar flips). A group of one
// detector is just a detector, and gets no band.

import type { AnnotationLayerGroup } from '../types/annotationLayer';

export const DETECTOR_GROUP_PREFIX = 'detector-group:';

export function detectorGroupId(group: string): string {
  return `${DETECTOR_GROUP_PREFIX}${group}`;
}

export function isDetectorGroupId(id: string): boolean {
  return id.startsWith(DETECTOR_GROUP_PREFIX);
}

interface GroupedDetector {
  name: string;
  group: string | null;
  status?: string;
}

/** group → its detectors' names, for every group two or more usable
 *  detectors share. */
export function sharedDetectorGroups(
  registry: readonly GroupedDetector[],
): Map<string, string[]> {
  const byGroup = new Map<string, string[]>();
  for (const d of registry) {
    if (!d.group || (d.status !== undefined && d.status !== 'ok')) continue;
    const list = byGroup.get(d.group) ?? [];
    list.push(d.name);
    byGroup.set(d.group, list);
  }
  for (const [g, names] of byGroup) if (names.length < 2) byGroup.delete(g);
  return byGroup;
}

/** The annotation group a copy of detector `name` belongs in, or null when
 *  its group is not shared. */
export function detectorCopyGroup(
  name: string,
  registry: readonly GroupedDetector[],
): string | null {
  const group = registry.find((d) => d.name === name)?.group;
  if (!group) return null;
  return sharedDetectorGroups(registry).get(group)?.includes(name) ? group : null;
}

export interface DetectorLaneRow {
  /** The canvas row id, e.g. `span-layer:detector-span:rhythmic_rolls`. */
  rowId: string;
  detectorName: string;
  color: string;
  /** The band this lane is drawn in when its detector says so itself — a
   *  `lanes` detector's lane group ("Kick" for the kick's notes and loop).
   *  Overrides the detector's own band; show / hide is still the detector's. */
  band?: string | null;
}

export interface DetectorBands {
  groups: AnnotationLayerGroup[];
  rowGroupId: Record<string, string>;
  groupState: Record<string, { visibility: 'all' | 'some' | 'none'; count: number }>;
}

/** The bands over the detector lanes on this song: one per group two or more
 *  detectors share, and one per detector drawing two or more lanes. A lane
 *  joins its band only while it is shown — a hidden lane has no row to put
 *  in it — and the band itself appears only while one of its lanes is. */
export function buildDetectorBands(
  lanes: readonly DetectorLaneRow[],
  registry: readonly GroupedDetector[],
  hidden: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): DetectorBands {
  const shared = sharedDetectorGroups(registry);
  const groupOf = new Map<string, string>();
  for (const [g, names] of shared) for (const n of names) groupOf.set(n, g);
  const laneCount = new Map<string, number>();
  for (const l of lanes) laneCount.set(l.detectorName, (laneCount.get(l.detectorName) ?? 0) + 1);
  for (const [n, count] of laneCount) {
    if (count < 2 || groupOf.has(n)) continue;
    groupOf.set(n, registry.find((d) => d.name === n)?.group ?? n);
  }

  const groups: AnnotationLayerGroup[] = [];
  const rowGroupId: Record<string, string> = {};
  const groupState: DetectorBands['groupState'] = {};
  const members = new Map<string, DetectorLaneRow[]>();
  for (const lane of lanes) {
    const g = lane.band || groupOf.get(lane.detectorName);
    if (!g) continue;
    const list = members.get(g) ?? [];
    list.push(lane);
    members.set(g, list);
  }
  for (const [g, list] of members) {
    const id = detectorGroupId(g);
    const shown = list.filter((l) => !hidden.has(l.detectorName));
    groups.push({
      id,
      name: g,
      color: (shown[0] ?? list[0]).color,
      collapsed: collapsed.has(id),
    });
    for (const l of shown) rowGroupId[l.rowId] = id;
    groupState[id] = {
      visibility: shown.length === 0 ? 'none' : shown.length === list.length ? 'all' : 'some',
      count: list.length,
    };
  }
  return { groups, rowGroupId, groupState };
}

/** The detectors behind a band — what its show / hide switch toggles. */
export function detectorsInGroup(
  groupId: string,
  registry: readonly GroupedDetector[],
): string[] {
  if (!isDetectorGroupId(groupId)) return [];
  return sharedDetectorGroups(registry).get(groupId.slice(DETECTOR_GROUP_PREFIX.length)) ?? [];
}
