/**
 * Layer groups. The cases worth pinning are the ones the canvas depends on
 * being true: members stay contiguous in the document's own order (that is the
 * only ordering there is), the two ways to end a group differ in exactly one
 * respect, and a detector lane can never acquire a groupId it could not
 * persist.
 */

import { describe, it, expect } from 'vitest';
import {
  deleteGroupAndLayers,
  groupLayers,
  groupPillDisplay,
  groupVisibility,
  layersInGroup,
  newBoundaryLayer,
  newCueLayer,
  newSpanLayer,
  normalizeGroupOrder,
  pruneGroups,
  setGroupVisible,
  setLayerGroup,
  ungroupLayers,
  updateGroup,
  type AnnotationLayer,
  type AnnotationLayersDocument,
} from './annotationLayer';

function doc(layers: AnnotationLayer[]): AnnotationLayersDocument {
  return { song: 'a-song', annotated_at: '2026-01-01T00:00:00.000Z', layers };
}

function names(d: AnnotationLayersDocument): string[] {
  return d.layers.map((l) => l.name);
}

describe('groupLayers', () => {
  it('pulls members together at the first one and leaves the rest alone', () => {
    const map = newBoundaryLayer('chorus map', '#cbd5e1');
    const hits = newCueLayer('hits', '#34d399');
    const bg = newSpanLayer('bg vox', '#c4b5fd');
    const lead = newSpanLayer('lead vox', '#60a5fa');
    const { doc: next, group } = groupLayers(doc([map, hits, bg, lead]), [map.id, lead.id], 'Chorus study');

    expect(group).not.toBeNull();
    // lead vox moved up next to the chorus map; bg vox kept its place after them.
    expect(names(next)).toEqual(['chorus map', 'lead vox', 'hits', 'bg vox']);
    expect(layersInGroup(next, group!.id).map((l) => l.name)).toEqual(['chorus map', 'lead vox']);
    expect(next.groups).toHaveLength(1);
  });

  it('refuses detector lanes — a groupId on one would not survive the round trip', () => {
    const hits = newCueLayer('hits', '#34d399');
    const det: AnnotationLayer = {
      ...newSpanLayer('RMS vocals', '#64748b'),
      readOnly: true,
      source: 'detector:rms-vocals',
    };
    const { doc: next, group } = groupLayers(doc([hits, det]), [hits.id, det.id], 'Vocals');

    expect(layersInGroup(next, group!.id).map((l) => l.name)).toEqual(['hits']);
    expect(next.layers.find((l) => l.id === det.id)?.groupId).toBeUndefined();
  });

  it('creates nothing when every named layer is ineligible', () => {
    const det: AnnotationLayer = { ...newSpanLayer('RMS vocals', '#64748b'), readOnly: true };
    const before = doc([det]);
    const { doc: after, group } = groupLayers(before, [det.id], 'Vocals');

    expect(group).toBeNull();
    expect(after).toBe(before);
  });
});

describe('normalizeGroupOrder', () => {
  it('returns the same array when every group is already contiguous', () => {
    const a = { ...newCueLayer('a', '#34d399'), groupId: 'g1' };
    const b = { ...newCueLayer('b', '#60a5fa'), groupId: 'g1' };
    const c = newCueLayer('c', '#fbbf24');
    const layers = [a, b, c];
    expect(normalizeGroupOrder(layers)).toBe(layers);
  });

  it('keeps two groups apart when they are interleaved', () => {
    const a1 = { ...newCueLayer('a1', '#34d399'), groupId: 'g1' };
    const b1 = { ...newCueLayer('b1', '#60a5fa'), groupId: 'g2' };
    const a2 = { ...newCueLayer('a2', '#fbbf24'), groupId: 'g1' };
    const b2 = { ...newCueLayer('b2', '#f472b6'), groupId: 'g2' };

    expect(normalizeGroupOrder([a1, b1, a2, b2]).map((l) => l.name))
      .toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});

describe('setLayerGroup', () => {
  it('moves a lane into a group and back out again', () => {
    const hits = newCueLayer('hits', '#34d399');
    const lead = newSpanLayer('lead vox', '#60a5fa');
    const { doc: grouped, group } = groupLayers(doc([hits, lead]), [hits.id], 'Chorus study');

    const joined = setLayerGroup(grouped, lead.id, group!.id);
    expect(layersInGroup(joined, group!.id)).toHaveLength(2);

    const left = setLayerGroup(joined, lead.id, null);
    expect(layersInGroup(left, group!.id).map((l) => l.name)).toEqual(['hits']);
    expect('groupId' in left.layers.find((l) => l.id === lead.id)!).toBe(false);
  });

  it('is a no-op when the lane is already where it is being sent', () => {
    const hits = newCueLayer('hits', '#34d399');
    const { doc: grouped, group } = groupLayers(doc([hits]), [hits.id], 'Chorus study');
    expect(setLayerGroup(grouped, hits.id, group!.id)).toBe(grouped);
  });
});

describe('ending a group', () => {
  it('ungroup keeps every lane; delete takes them with it', () => {
    const hits = newCueLayer('hits', '#34d399');
    const lead = newSpanLayer('lead vox', '#60a5fa');
    const loose = newCueLayer('claps', '#fbbf24');
    const { doc: grouped, group } = groupLayers(doc([hits, lead, loose]), [hits.id, lead.id], 'Chorus study');

    const dissolved = ungroupLayers(grouped, group!.id);
    expect(names(dissolved)).toEqual(['hits', 'lead vox', 'claps']);
    expect(dissolved.groups).toHaveLength(0);
    expect(dissolved.layers.every((l) => l.groupId === undefined)).toBe(true);

    const deleted = deleteGroupAndLayers(grouped, group!.id);
    expect(names(deleted)).toEqual(['claps']);
    expect(deleted.groups).toHaveLength(0);
  });
});

describe('group visibility', () => {
  it('reads all / some / none across its members', () => {
    const hits = newCueLayer('hits', '#34d399');
    const lead = newSpanLayer('lead vox', '#60a5fa');
    const { doc: grouped, group } = groupLayers(doc([hits, lead]), [hits.id, lead.id], 'Chorus study');
    expect(groupVisibility(grouped, group!.id)).toBe('all');

    const half = {
      ...grouped,
      layers: grouped.layers.map((l) => (l.id === hits.id ? { ...l, visible: false } : l)),
    };
    expect(groupVisibility(half, group!.id)).toBe('some');
    expect(groupVisibility(setGroupVisible(half, group!.id, false), group!.id)).toBe('none');
    expect(groupVisibility(setGroupVisible(half, group!.id, true), group!.id)).toBe('all');
  });

  it('calls an empty group hidden rather than shown', () => {
    const hits = newCueLayer('hits', '#34d399');
    const { doc: grouped, group } = groupLayers(doc([hits]), [hits.id], 'Chorus study');
    const emptied = setLayerGroup(grouped, hits.id, null);
    expect(groupVisibility(emptied, group!.id)).toBe('none');
  });
});

describe('groupPillDisplay', () => {
  it('reads reviewed only when every member does', () => {
    const hits: AnnotationLayer = { ...newCueLayer('hits', '#34d399'), items: [{ id: 'c1', time: 1, label: '' }] };
    const lead: AnnotationLayer = {
      ...newSpanLayer('lead vox', '#60a5fa'),
      items: [{ id: 's1', start: 1, end: 2, label: '' }],
    };
    const { doc: grouped, group } = groupLayers(doc([hits, lead]), [hits.id, lead.id], 'Chorus study');

    const bothReviewed = { ...grouped, statusByType: { cues: 'reviewed', spans: 'reviewed' } as const };
    expect(groupPillDisplay(bothReviewed, group!.id)).toBe('reviewed');

    const oneOpen = { ...grouped, statusByType: { cues: 'reviewed' } as const };
    expect(groupPillDisplay(oneOpen, group!.id)).toBe('in_progress');
  });

  it('reads not_started while no member has an item', () => {
    const hits = newCueLayer('hits', '#34d399');
    const { doc: grouped, group } = groupLayers(doc([hits]), [hits.id], 'Chorus study');
    expect(groupPillDisplay(grouped, group!.id)).toBe('not_started');
  });
});

describe('pruneGroups', () => {
  it('clears a groupId whose group is gone and leaves clean documents alone', () => {
    const orphan = { ...newCueLayer('hits', '#34d399'), groupId: 'vanished' };
    const cleaned = pruneGroups(doc([orphan]));
    expect(cleaned.layers[0].groupId).toBeUndefined();

    const clean = doc([newCueLayer('hits', '#34d399')]);
    expect(pruneGroups(clean)).toBe(clean);
  });

  it('drops a duplicated group id', () => {
    const hits = newCueLayer('hits', '#34d399');
    const { doc: grouped, group } = groupLayers(doc([hits]), [hits.id], 'Chorus study');
    const dupes = { ...grouped, groups: [group!, { ...group!, name: 'copy' }] };
    expect(pruneGroups(dupes).groups).toHaveLength(1);
    expect(pruneGroups(dupes).groups![0].name).toBe('Chorus study');
  });
});

describe('updateGroup', () => {
  it('patches only the named group', () => {
    const hits = newCueLayer('hits', '#34d399');
    const lead = newSpanLayer('lead vox', '#60a5fa');
    const first = groupLayers(doc([hits, lead]), [hits.id], 'Chorus study');
    const second = groupLayers(first.doc, [lead.id], 'Kick work');

    const collapsed = updateGroup(second.doc, first.group!.id, { collapsed: true, name: 'Chorus' });
    expect(collapsed.groups!.find((g) => g.id === first.group!.id)).toMatchObject({
      name: 'Chorus', collapsed: true,
    });
    expect(collapsed.groups!.find((g) => g.id === second.group!.id)).toMatchObject({
      name: 'Kick work', collapsed: false,
    });
  });
});
