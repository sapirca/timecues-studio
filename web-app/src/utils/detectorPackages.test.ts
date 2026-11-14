import { describe, it, expect } from 'vitest';
import { clusterByDetectorGroup, groupByDetectorPackage } from './detectorPackages';

const d = (name: string, is_default: boolean, pkg: string | null = null, title: string | null = null) =>
  ({ name, is_default, package: pkg, package_title: title });

const shape = (groups: ReturnType<typeof groupByDetectorPackage<ReturnType<typeof d>>>) =>
  groups.map((g) => [g.title, g.packageId, g.items.map((i) => i.name)]);

describe('groupByDetectorPackage', () => {
  it('lists each package under its title, then loose Custom, then Default', () => {
    const groups = groupByDetectorPackage([
      d('template', true),
      d('pulse', false, 'visualizer', 'Visualizer'),
      d('mine', false),
      d('beats', false, 'beat-kit', 'Beat kit'),
      d('energy_arcs', false, 'visualizer', 'Visualizer'),
    ]);
    expect(shape(groups)).toEqual([
      ['Beat kit', 'beat-kit', ['beats']],
      ['Visualizer', 'visualizer', ['pulse', 'energy_arcs']],
      ['Custom', null, ['mine']],
      ['Default', null, ['template']],
    ]);
  });

  it('puts shipped packages after the user’s own', () => {
    const groups = groupByDetectorPackage([d('a', true, 'aaa', 'Aaa'), d('z', false, 'zzz', 'Zzz')]);
    expect(groups.map((g) => g.title)).toEqual(['Zzz', 'Aaa']);
  });

  it('titles a lone loose group beside a package', () => {
    const groups = groupByDetectorPackage([d('pulse', false, 'viz', 'Viz'), d('template', true)]);
    expect(shape(groups)).toEqual([['Viz', 'viz', ['pulse']], ['Default', null, ['template']]]);
  });

  it('falls back to the package id when there is no title', () => {
    expect(groupByDetectorPackage([d('a', false, 'viz', null)])[0].title).toBe('viz');
  });

  it('keeps an empty package as a section of its own, in title order', () => {
    const groups = groupByDetectorPackage(
      [d('pulse', false, 'viz', 'Viz')],
      [{ id: 'viz', title: 'Viz', is_default: false }, { id: 'new', title: 'Another', is_default: false }],
    );
    expect(shape(groups)).toEqual([
      ['Another', 'new', []],
      ['Viz', 'viz', ['pulse']],
    ]);
  });

  it('renders flat, like before, when there are no packages and one origin', () => {
    expect(shape(groupByDetectorPackage([d('mine', false), d('other', false)]))).toEqual([
      [null, null, ['mine', 'other']],
    ]);
  });
});

describe('clusterByDetectorGroup', () => {
  const g = (name: string, group: string | null) => ({ name, group });
  const shape = (cs: ReturnType<typeof clusterByDetectorGroup<ReturnType<typeof g>>>) =>
    cs.map((c) => [c.title, c.items.map((i) => i.name)]);

  it('clusters by group alphabetically, keeping order, the ungrouped last as Other', () => {
    expect(shape(clusterByDetectorGroup([
      g('pulse', 'Pulse'), g('booms', 'Energy'), g('loose', null), g('arcs', 'Energy'), g('kick', 'Hits'),
    ]))).toEqual([
      ['Energy', ['booms', 'arcs']],
      ['Hits', ['kick']],
      ['Pulse', ['pulse']],
      ['Other', ['loose']],
    ]);
  });

  it('stays one flat untitled list when nobody declares a group', () => {
    expect(shape(clusterByDetectorGroup([g('a', null), g('b', '  ')]))).toEqual([[null, ['a', 'b']]]);
    expect(clusterByDetectorGroup([])).toEqual([]);
  });
});
