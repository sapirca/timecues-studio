import { describe, it, expect } from 'vitest';
import { zoomCenterFor } from './zoomCenter';

describe('zoomCenterFor', () => {
  it('follows the playhead when nothing is selected', () => {
    expect(zoomCenterFor(null, 83.4, 166.8)).toBe(83.4);
  });

  it('lets a nominated focus win over the playhead', () => {
    expect(zoomCenterFor(135, 0, 166.8)).toBe(135);
    expect(zoomCenterFor(0, 120, 166.8)).toBe(0);   // 0 is a real focus, not "none"
  });

  it('follows the playhead even where it cannot reach the middle', () => {
    // The case that used to hand over to "the middle of what is on screen",
    // stranding a cursor near either end off the side of the viewport.
    expect(zoomCenterFor(null, 9.9, 166.8)).toBe(9.9);
    expect(zoomCenterFor(null, 166.0, 166.8)).toBe(166.0);
  });

  it('clamps to the track', () => {
    expect(zoomCenterFor(null, -5, 166.8)).toBe(0);
    expect(zoomCenterFor(null, 999, 166.8)).toBe(166.8);
    expect(zoomCenterFor(500, 10, 166.8)).toBe(166.8);
  });

  it('ignores a non-finite focus and falls back to the playhead', () => {
    expect(zoomCenterFor(NaN, 42, 166.8)).toBe(42);
    expect(zoomCenterFor(Infinity, 42, 166.8)).toBe(42);
    expect(zoomCenterFor(undefined, 42, 166.8)).toBe(42);
  });

  it('survives a track whose duration is not known yet', () => {
    expect(zoomCenterFor(null, 12, 0)).toBe(12);
    expect(zoomCenterFor(null, -3, 0)).toBe(0);
    expect(zoomCenterFor(null, NaN, 0)).toBe(0);
  });
});
