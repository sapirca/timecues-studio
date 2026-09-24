/**
 * Prominence envelope helpers. The interesting cases are the ones a
 * hand-authored envelope can't be trusted to avoid: unsorted points, two
 * points on the same instant, a ramp on the very first point (nothing to ramp
 * from), and a start-edge resize dragged clean past a breakpoint.
 */

import { describe, it, expect } from 'vitest';
import {
  PROMINENCE_INFO,
  normalizeProminence,
  prominenceAt,
  removeProminencePoint,
  setProminenceAt,
  shiftProminenceForStartEdge,
  toggleProminenceRamp,
  prominenceSummary,
  type ProminencePoint,
} from './annotationLayer';

describe('normalizeProminence', () => {
  it('collapses an empty or absent envelope to undefined', () => {
    expect(normalizeProminence([])).toBeUndefined();
    expect(normalizeProminence(undefined)).toBeUndefined();
  });

  it('sorts by t and anchors the earliest point at 0', () => {
    expect(normalizeProminence([{ t: 5, level: 'counter' }, { t: 2, level: 'lead' }]))
      .toEqual([{ t: 0, level: 'lead' }, { t: 5, level: 'counter' }]);
  });

  it('drops a neighbour that repeats the level already in effect', () => {
    expect(normalizeProminence([
      { t: 0, level: 'lead' }, { t: 3, level: 'lead' }, { t: 6, level: 'backing' },
    ])).toEqual([{ t: 0, level: 'lead' }, { t: 6, level: 'backing' }]);
  });

  it('lets the later point win when two land on the same instant', () => {
    expect(normalizeProminence([{ t: 0, level: 'lead' }, { t: 0, level: 'backing' }]))
      .toEqual([{ t: 0, level: 'backing' }]);
  });

  it('strips a ramp off the first point, which has nothing to arrive from', () => {
    expect(normalizeProminence([
      { t: 0, level: 'lead', ramp: 'ramp' }, { t: 4, level: 'silent' },
    ])).toEqual([{ t: 0, level: 'lead' }, { t: 4, level: 'silent' }]);
  });

  it('rejects a point carrying an unknown level', () => {
    expect(normalizeProminence([{ t: 0, level: 'bogus' as never }, { t: 2, level: 'lead' }]))
      .toEqual([{ t: 0, level: 'lead' }]);
  });
});

describe('prominenceAt', () => {
  const arc: ProminencePoint[] = [{ t: 0, level: 'lead' }, { t: 10, level: 'backing' }];

  it('reads the level in effect at, before, and after each breakpoint', () => {
    expect(prominenceAt(arc, 0)).toEqual({ level: 'lead', weight: 1 });
    expect(prominenceAt(arc, 9.9)).toEqual({ level: 'lead', weight: 1 });
    expect(prominenceAt(arc, 10)).toEqual({ level: 'backing', weight: PROMINENCE_INFO.backing.weight });
    expect(prominenceAt(arc, 99)).toEqual({ level: 'backing', weight: PROMINENCE_INFO.backing.weight });
  });

  it('clamps a playhead sitting before the item to the first point', () => {
    expect(prominenceAt(arc, -5)).toEqual({ level: 'lead', weight: 1 });
  });

  it('returns null for an unannotated item', () => {
    expect(prominenceAt(undefined, 3)).toBeNull();
  });

  // Mid-crossfade the weight slides but the level still reads as the one being
  // left: a part easing back is still the lead until it has handed over.
  it('interpolates the weight across a ramp while the level holds', () => {
    const ramped: ProminencePoint[] = [{ t: 0, level: 'lead' }, { t: 10, level: 'silent', ramp: 'ramp' }];
    expect(prominenceAt(ramped, 0)).toEqual({ level: 'lead', weight: 1 });
    expect(prominenceAt(ramped, 2.5)).toEqual({ level: 'lead', weight: 0.75 });
    expect(prominenceAt(ramped, 5)).toEqual({ level: 'lead', weight: 0.5 });
    expect(prominenceAt(ramped, 10)).toEqual({ level: 'silent', weight: 0 });
  });
});

describe('setProminenceAt', () => {
  it('creates the t=0 anchor on an unannotated item', () => {
    expect(setProminenceAt(undefined, 0, 'lead')).toEqual([{ t: 0, level: 'lead' }]);
  });

  it('adds a breakpoint mid-item', () => {
    expect(setProminenceAt([{ t: 0, level: 'lead' }], 6, 'counter'))
      .toEqual([{ t: 0, level: 'lead' }, { t: 6, level: 'counter' }]);
  });

  it('replaces rather than stacks at the same instant', () => {
    expect(setProminenceAt([{ t: 0, level: 'lead' }, { t: 6, level: 'counter' }], 6, 'silent'))
      .toEqual([{ t: 0, level: 'lead' }, { t: 6, level: 'silent' }]);
  });

  it('keeps the ramp flag', () => {
    expect(setProminenceAt([{ t: 0, level: 'lead' }], 6, 'backing', 'ramp'))
      .toEqual([{ t: 0, level: 'lead' }, { t: 6, level: 'backing', ramp: 'ramp' }]);
  });

  it('brings an opening anchor when the first breakpoint lands past the start', () => {
    // Without one, normalize would pull that point back to t=0 to serve as the
    // anchor itself, and a click at 0:12 would silently land at 0:00.
    expect(setProminenceAt(undefined, 12, 'counter'))
      .toEqual([{ t: 0, level: 'lead' }, { t: 12, level: 'counter' }]);
  });

  it('collapses the anchor when that first breakpoint is itself lead', () => {
    // Nothing left to say: the whole annotation leads.
    expect(setProminenceAt(undefined, 12, 'lead')).toEqual([{ t: 0, level: 'lead' }]);
  });

  it('clamps a negative t onto the anchor', () => {
    expect(setProminenceAt([{ t: 0, level: 'lead' }], -3, 'silent'))
      .toEqual([{ t: 0, level: 'silent' }]);
  });
});

describe('toggleProminenceRamp', () => {
  const arc: ProminencePoint[] = [{ t: 0, level: 'lead' }, { t: 8, level: 'backing' }];

  it('turns a step into a crossfade and back', () => {
    const ramped = toggleProminenceRamp(arc, 1);
    expect(ramped).toEqual([{ t: 0, level: 'lead' }, { t: 8, level: 'backing', ramp: 'ramp' }]);
    expect(toggleProminenceRamp(ramped, 1)).toEqual(arc);
  });

  it('refuses index 0, which has nothing to arrive from', () => {
    expect(toggleProminenceRamp(arc, 0)).toEqual(arc);
  });
});

describe('removeProminencePoint', () => {
  it('clears the annotation once the last point goes', () => {
    expect(removeProminencePoint([{ t: 0, level: 'lead' }], 0)).toBeUndefined();
  });

  it('promotes the next point to t=0 when the anchor is removed', () => {
    expect(removeProminencePoint([{ t: 0, level: 'lead' }, { t: 8, level: 'backing' }], 0))
      .toEqual([{ t: 0, level: 'backing' }]);
  });
});

// A span at 40→80 reading "lead until +10, then backing" — the switch sits at
// track time 50 and must stay there however the start edge is dragged.
describe('shiftProminenceForStartEdge', () => {
  const arc: ProminencePoint[] = [{ t: 0, level: 'lead' }, { t: 10, level: 'backing' }];

  it('keeps the arc on the audio when the start moves later', () => {
    expect(shiftProminenceForStartEdge(arc, 4))
      .toEqual([{ t: 0, level: 'lead' }, { t: 6, level: 'backing' }]);
  });

  it('keeps the arc on the audio when the start moves earlier', () => {
    expect(shiftProminenceForStartEdge(arc, -4))
      .toEqual([{ t: 0, level: 'lead' }, { t: 14, level: 'backing' }]);
  });

  it('promotes the surviving level when the start is dragged past a breakpoint', () => {
    expect(shiftProminenceForStartEdge(arc, 12)).toEqual([{ t: 0, level: 'backing' }]);
  });

  it('is identity for a zero delta and for an unannotated item', () => {
    expect(shiftProminenceForStartEdge(arc, 0)).toEqual(arc);
    expect(shiftProminenceForStartEdge(undefined, 5)).toBeUndefined();
  });
});

describe('prominenceSummary', () => {
  it('names a single level, and first → last for an arc', () => {
    expect(prominenceSummary([{ t: 0, level: 'lead' }])).toBe('Lead');
    expect(prominenceSummary([{ t: 0, level: 'lead' }, { t: 9, level: 'backing' }]))
      .toBe('Lead → Backing');
    expect(prominenceSummary(undefined)).toBeNull();
  });
});
