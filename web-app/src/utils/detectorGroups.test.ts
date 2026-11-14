import { describe, expect, it } from 'vitest';

import {
  buildDetectorBands, detectorCopyGroup, detectorGroupId, detectorsInGroup, isDetectorGroupId,
  sharedDetectorGroups,
} from './detectorGroups';

const REGISTRY = [
  { name: 'rhythmic_rolls', group: 'Rhythmic figures', status: 'ok' },
  { name: 'rhythmic_figures', group: 'Rhythmic figures', status: 'ok' },
  { name: 'pulse', group: 'Pulse', status: 'ok' },
  { name: 'broken', group: 'Pulse', status: 'error' },
  { name: 'loose', group: null, status: 'ok' },
];

const LANES = [
  { rowId: 'span-layer:detector-span:rhythmic_rolls', detectorName: 'rhythmic_rolls', color: '#f87171' },
  { rowId: 'cue-layer:detector-cue:rhythmic_figures', detectorName: 'rhythmic_figures', color: '#38bdf8' },
  { rowId: 'span-layer:detector-span:pulse', detectorName: 'pulse', color: '#a3e635' },
];

describe('sharedDetectorGroups', () => {
  it('keeps only groups two or more usable detectors share', () => {
    const shared = sharedDetectorGroups(REGISTRY);
    expect([...shared.keys()]).toEqual(['Rhythmic figures']);
    expect(shared.get('Rhythmic figures')).toEqual(['rhythmic_rolls', 'rhythmic_figures']);
  });
});

describe('detectorCopyGroup', () => {
  it('names the shared group a copy belongs in, and none for a group of one', () => {
    expect(detectorCopyGroup('rhythmic_rolls', REGISTRY)).toBe('Rhythmic figures');
    expect(detectorCopyGroup('pulse', REGISTRY)).toBeNull();
    expect(detectorCopyGroup('loose', REGISTRY)).toBeNull();
    expect(detectorCopyGroup('nope', REGISTRY)).toBeNull();
  });
});

describe('buildDetectorBands', () => {
  it('puts the lanes of a shared group in one band, and a lone detector in none', () => {
    const { groups, rowGroupId, groupState } = buildDetectorBands(LANES, REGISTRY, new Set(), new Set());
    const id = detectorGroupId('Rhythmic figures');
    expect(groups).toEqual([{ id, name: 'Rhythmic figures', color: '#f87171', collapsed: false }]);
    expect(rowGroupId).toEqual({
      'span-layer:detector-span:rhythmic_rolls': id,
      'cue-layer:detector-cue:rhythmic_figures': id,
    });
    expect(groupState[id]).toEqual({ visibility: 'all', count: 2 });
  });

  it('leaves a hidden lane out of the band and says the band is partly shown', () => {
    const id = detectorGroupId('Rhythmic figures');
    const { groups, rowGroupId, groupState } = buildDetectorBands(
      LANES, REGISTRY, new Set(['rhythmic_rolls']), new Set([id]),
    );
    expect(Object.keys(rowGroupId)).toEqual(['cue-layer:detector-cue:rhythmic_figures']);
    expect(groupState[id].visibility).toBe('some');
    expect(groups[0].color).toBe('#38bdf8');
    expect(groups[0].collapsed).toBe(true);
  });

  it('draws no member rows when every lane of the group is hidden', () => {
    const id = detectorGroupId('Rhythmic figures');
    const { rowGroupId, groupState } = buildDetectorBands(
      LANES, REGISTRY, new Set(['rhythmic_rolls', 'rhythmic_figures']), new Set(),
    );
    expect(rowGroupId).toEqual({});
    expect(groupState[id].visibility).toBe('none');
  });
});

describe('buildDetectorBands — one detector, several lanes', () => {
  it('bands the part lanes of one detector under its group', () => {
    const lanes = [
      { rowId: 'span-layer:detector-span:pulse~kick', detectorName: 'pulse', color: '#f00' },
      { rowId: 'span-layer:detector-span:pulse~snare', detectorName: 'pulse', color: '#0f0' },
      { rowId: 'span-layer:detector-span:loose', detectorName: 'loose', color: '#00f' },
    ];
    const { groups, rowGroupId, groupState } = buildDetectorBands(lanes, REGISTRY, new Set(), new Set());
    const id = detectorGroupId('Pulse');
    expect(groups).toEqual([{ id, name: 'Pulse', color: '#f00', collapsed: false }]);
    expect(rowGroupId).toEqual({
      'span-layer:detector-span:pulse~kick': id,
      'span-layer:detector-span:pulse~snare': id,
    });
    expect(groupState[id]).toEqual({ visibility: 'all', count: 2 });
  });

  it('names the band after the detector when it has no group', () => {
    const lanes = [
      { rowId: 'a', detectorName: 'loose', color: '#f00' },
      { rowId: 'b', detectorName: 'loose', color: '#0f0' },
    ];
    const { groups } = buildDetectorBands(lanes, REGISTRY, new Set(), new Set());
    expect(groups.map((g) => g.name)).toEqual(['loose']);
  });
});

describe('detectorsInGroup', () => {
  it('lists the detectors a band toggles, and nothing for an annotation group', () => {
    expect(detectorsInGroup(detectorGroupId('Rhythmic figures'), REGISTRY)).toHaveLength(2);
    expect(detectorsInGroup('g-123', REGISTRY)).toEqual([]);
    expect(isDetectorGroupId('g-123')).toBe(false);
  });
});

describe('buildDetectorBands with lanes that name their own band', () => {
  it('bands each lane group of one detector apart', () => {
    const lanes = [
      { rowId: 'cue-layer:detector-cue:il~kick_notes', detectorName: 'il', color: '#1', band: 'Kick' },
      { rowId: 'groove-lane:detector-groove:il~kick_pattern', detectorName: 'il', color: '#1', band: 'Kick' },
      { rowId: 'cue-layer:detector-cue:il~bass_notes', detectorName: 'il', color: '#1', band: 'Bass' },
    ];
    const reg = [{ name: 'il', group: null, status: 'ok' }];
    const bands = buildDetectorBands(lanes, reg, new Set(), new Set());
    expect(bands.groups.map((g) => g.name)).toEqual(['Kick', 'Bass']);
    expect(bands.rowGroupId['groove-lane:detector-groove:il~kick_pattern']).toBe(detectorGroupId('Kick'));
    // Hiding is still the detector's: every band of it goes.
    expect(buildDetectorBands(lanes, reg, new Set(['il']), new Set()).groupState[detectorGroupId('Kick')].visibility)
      .toBe('none');
  });
});
