import { describe, expect, it } from 'vitest';
import { isHorizontalWheel } from './wheel';

const wheel = (deltaX: number, deltaY: number) => ({ deltaX, deltaY }) as WheelEvent;

describe('isHorizontalWheel', () => {
  it('leaves a vertical swipe with sideways drift to the browser', () => {
    expect(isHorizontalWheel(wheel(2, 40))).toBe(false);
    expect(isHorizontalWheel(wheel(-1, -12))).toBe(false);
  });
  it('takes a mostly sideways swipe', () => {
    expect(isHorizontalWheel(wheel(30, 4))).toBe(true);
    expect(isHorizontalWheel(wheel(-30, 0))).toBe(true);
  });
  it('takes nothing from an event with no movement', () => {
    expect(isHorizontalWheel(wheel(0, 0))).toBe(false);
  });
});
