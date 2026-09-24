/**
 * The row order a grouped canvas actually draws. The cases that matter are the
 * ones `rowOrder` creates on its own: members scattered across the per-type
 * blocks, two groups interleaved, and a collapsed group that has to contribute
 * its header without its lanes.
 */

import { describe, it, expect } from 'vitest';
import { GROUP_ROW_PREFIX, buildGroupedRowOrder, moveRowInOrder, resolveGroupDrop } from './layerGroupRows';

const NONE = new Set<string>();

describe('buildGroupedRowOrder', () => {
  it('leaves an ungrouped order untouched, by reference', () => {
    const order = ['waveform', 'cue-layer:a', 'span-layer:b'];
    expect(buildGroupedRowOrder(order, {}, NONE)).toBe(order);
    expect(buildGroupedRowOrder(order, undefined, NONE)).toBe(order);
  });

  it('pulls scattered members up behind one header', () => {
    // What rowOrder really looks like: cues and spans land in separate blocks.
    const order = ['waveform', 'cue-layer:a', 'cue-layer:c', 'span-layer:b', 'loop-layer:d'];
    const out = buildGroupedRowOrder(order, { 'cue-layer:a': 'g1', 'span-layer:b': 'g1' }, NONE);

    expect(out).toEqual([
      'waveform',
      `${GROUP_ROW_PREFIX}g1`,
      'cue-layer:a',
      'span-layer:b',
      'cue-layer:c',
      'loop-layer:d',
    ]);
  });

  it('keeps two interleaved groups apart, each at its first member', () => {
    const order = ['cue-layer:a', 'cue-layer:b', 'span-layer:c', 'span-layer:d'];
    const out = buildGroupedRowOrder(order, {
      'cue-layer:a': 'g1', 'span-layer:c': 'g1',
      'cue-layer:b': 'g2', 'span-layer:d': 'g2',
    }, NONE);

    expect(out).toEqual([
      `${GROUP_ROW_PREFIX}g1`, 'cue-layer:a', 'span-layer:c',
      `${GROUP_ROW_PREFIX}g2`, 'cue-layer:b', 'span-layer:d',
    ]);
  });

  it('collapses to the header alone', () => {
    const order = ['waveform', 'cue-layer:a', 'span-layer:b'];
    const out = buildGroupedRowOrder(
      order,
      { 'cue-layer:a': 'g1', 'span-layer:b': 'g1' },
      new Set(['g1']),
    );

    expect(out).toEqual(['waveform', `${GROUP_ROW_PREFIX}g1`]);
  });

  it('still draws the header when a group has one member', () => {
    const out = buildGroupedRowOrder(['cue-layer:a'], { 'cue-layer:a': 'g1' }, NONE);
    expect(out).toEqual([`${GROUP_ROW_PREFIX}g1`, 'cue-layer:a']);
  });

  it('ignores a membership whose row is not in the order', () => {
    const order = ['waveform', 'cue-layer:a'];
    const out = buildGroupedRowOrder(order, { 'span-layer:gone': 'g1' }, NONE);
    expect(out).toBe(order);
  });
});

describe('resolveGroupDrop', () => {
  const rowGroupId = { 'cue-layer:a': 'g1', 'span-layer:b': 'g1' };

  it('reads a header as the top of its band', () => {
    expect(resolveGroupDrop(`${GROUP_ROW_PREFIX}g1`, rowGroupId))
      .toEqual({ groupId: 'g1', beforeRowId: null });
  });

  it('reads a member lane as "into that band, above this lane"', () => {
    expect(resolveGroupDrop('span-layer:b', rowGroupId))
      .toEqual({ groupId: 'g1', beforeRowId: 'span-layer:b' });
  });

  it('reads any row outside a band as ungrouped', () => {
    expect(resolveGroupDrop('waveform', rowGroupId))
      .toEqual({ groupId: null, beforeRowId: 'waveform' });
    expect(resolveGroupDrop('waveform', undefined))
      .toEqual({ groupId: null, beforeRowId: 'waveform' });
  });
});

describe('moveRowInOrder', () => {
  // The band is g1, led by cue-layer:a; loop-layer:d is the outsider.
  const order = ['waveform', 'loop-layer:d', 'cue-layer:a', 'span-layer:b', 'cue-layer:c'];
  const rowGroupId = { 'cue-layer:a': 'g1', 'span-layer:b': 'g1' };

  it('puts a header drop above the band\'s current first member', () => {
    const out = moveRowInOrder(order, 'loop-layer:d', { groupId: 'g1', beforeRowId: null }, rowGroupId);
    expect(out).toEqual(['waveform', 'loop-layer:d', 'cue-layer:a', 'span-layer:b', 'cue-layer:c']);
  });

  it('keeps the band where it was drawn when a lane joins at the top', () => {
    // A lane from *below* the band joining at its top must not drag the header
    // down with it: the header draws at the first member's slot.
    const from = ['cue-layer:a', 'span-layer:b', 'loop-layer:d'];
    const out = moveRowInOrder(from, 'loop-layer:d', { groupId: 'g1', beforeRowId: null }, rowGroupId);
    expect(out).toEqual(['loop-layer:d', 'cue-layer:a', 'span-layer:b']);
  });

  it('inserts above the member a lane was dropped on', () => {
    const out = moveRowInOrder(order, 'loop-layer:d', { groupId: 'g1', beforeRowId: 'span-layer:b' }, rowGroupId);
    expect(out).toEqual(['waveform', 'cue-layer:a', 'loop-layer:d', 'span-layer:b', 'cue-layer:c']);
  });

  it('carries a member out of its band to the drop position', () => {
    const out = moveRowInOrder(order, 'span-layer:b', { groupId: null, beforeRowId: 'waveform' }, rowGroupId);
    expect(out).toEqual(['span-layer:b', 'waveform', 'loop-layer:d', 'cue-layer:a', 'cue-layer:c']);
  });

  it('leaves the order alone when the band has no member row to aim at', () => {
    const out = moveRowInOrder(order, 'loop-layer:d', { groupId: 'g9', beforeRowId: null }, rowGroupId);
    expect(out).toBe(order);
  });

  it('leaves the order alone when the row is not in it', () => {
    const out = moveRowInOrder(order, 'cue-layer:gone', { groupId: 'g1', beforeRowId: null }, rowGroupId);
    expect(out).toBe(order);
  });
});
