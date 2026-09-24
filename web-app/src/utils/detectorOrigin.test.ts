import { describe, it, expect } from 'vitest';
import { groupByDetectorOrigin } from './detectorOrigin';

const d = (name: string, is_default: boolean) => ({ name, is_default });
const byFlag = (x: { is_default: boolean }) => x.is_default;

describe('groupByDetectorOrigin', () => {
  it('titles both groups, Custom first, when both have detectors', () => {
    const groups = groupByDetectorOrigin([d('mine', false), d('template', true), d('other', false)], byFlag);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.name)])).toEqual([
      ['Custom', ['mine', 'other']],
      ['Default', ['template']],
    ]);
  });

  it('drops the titles when there are only defaults', () => {
    const groups = groupByDetectorOrigin([d('template', true), d('example_energy', true)], byFlag);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBeNull();
    expect(groups[0].items).toHaveLength(2);
  });

  it('drops the titles when there are only custom detectors', () => {
    const groups = groupByDetectorOrigin([d('mine', false)], byFlag);
    expect(groups).toEqual([{ origin: 'custom', title: null, items: [d('mine', false)] }]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupByDetectorOrigin([], byFlag)).toEqual([]);
  });
});
