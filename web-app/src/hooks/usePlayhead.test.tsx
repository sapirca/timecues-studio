/**
 * The playhead clock exists so that a clock tick does NOT re-render the page.
 * These pin that down: a cursor line moves without its component rendering,
 * and a derived value re-renders only when the value itself changes.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  createPlayheadClock,
  PLAYHEAD_SLOT,
  PlayheadClockContext,
  usePaintClock,
  usePlayheadValue,
  type PlayheadClock,
} from './usePlayhead';
import { LiveLabel, PlayheadLine, PlayheadWithin } from '../components/Playhead';

function withClock(clock: PlayheadClock, ui: ReactNode) {
  return render(<PlayheadClockContext.Provider value={clock}>{ui}</PlayheadClockContext.Provider>);
}

describe('PlayheadLine', () => {
  // jsdom has no layout: give every box a 400 px width to measure against.
  beforeEach(() => { vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400); });
  afterEach(() => { vi.restoreAllMocks(); });
  const xOf = (el: HTMLElement) => Number(/translate3d\(([-\d.]+)px/.exec(el.style.transform)?.[1]);

  it('follows the clock without re-rendering its parent', () => {
    const clock = createPlayheadClock(0);
    let parentRenders = 0;
    function Row() {
      parentRenders++;
      return <div><PlayheadLine duration={100} /></div>;
    }
    const { container } = withClock(clock, <Row />);
    const line = container.firstChild!.firstChild as HTMLDivElement;
    expect(xOf(line)).toBe(0);
    for (let t = 1; t <= 60; t++) act(() => clock.set(t / 2));
    expect(xOf(line)).toBe(120);
    expect(parentRenders).toBe(1);
  });

  it('moves by transform, so following the clock never touches layout', () => {
    const clock = createPlayheadClock(0);
    const { container } = withClock(clock, <div><PlayheadLine duration={100} /></div>);
    const line = container.firstChild!.firstChild as HTMLDivElement;
    for (let t = 1; t <= 10; t++) act(() => clock.set(t));
    expect(line.style.left).toBe('0px');
    expect(line.style.willChange).toBe('transform');
    expect(xOf(line)).toBe(40);
  });

  it('clamps to the track', () => {
    const clock = createPlayheadClock(250);
    const { container } = withClock(clock, <div><PlayheadLine duration={100} /></div>);
    expect(xOf(container.firstChild!.firstChild as HTMLDivElement)).toBe(400);
  });
});

describe('usePlayheadValue', () => {
  it('re-renders only when the derived value changes', () => {
    const clock = createPlayheadClock(0);
    let renders = 0;
    function Second() {
      renders++;
      const s = usePlayheadValue((t) => Math.floor(t));
      return <span>{s}</span>;
    }
    const { container } = withClock(clock, <Second />);
    // 60 frames across 1.5 s of song: one whole-second change.
    for (let f = 1; f <= 60; f++) act(() => clock.set(f * 0.025));
    expect(container.textContent).toBe('1');
    expect(renders).toBe(2); // mount, then 0 → 1
  });
});

describe('PlayheadWithin', () => {
  it('flips only at the range edges, and only while active', () => {
    const clock = createPlayheadClock(0);
    const seen: boolean[] = [];
    const ui = (active: boolean) => (
      <PlayheadWithin start={1} end={2} active={active}>
        {(inside) => { seen.push(inside); return null; }}
      </PlayheadWithin>
    );
    const { rerender } = withClock(clock, ui(true));
    for (let f = 1; f <= 30; f++) act(() => clock.set(f * 0.1));
    expect(seen).toEqual([false, true, false]);
    rerender(<PlayheadClockContext.Provider value={clock}>{ui(false)}</PlayheadClockContext.Provider>);
    act(() => clock.set(1.5));
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe('LiveLabel', () => {
  it('fills the slot from the clock while its parent stays put', () => {
    const clock = createPlayheadClock(30);
    let parentRenders = 0;
    function Button() {
      parentRenders++;
      return <button><LiveLabel text={`Split at ${PLAYHEAD_SLOT}`} /></button>;
    }
    const { container } = withClock(clock, <Button />);
    expect(container.textContent).toBe('Split at 0:30.0');
    for (let f = 1; f <= 30; f++) act(() => clock.set(30 + f / 60));
    expect(container.textContent).toBe('Split at 0:30.5');
    expect(parentRenders).toBe(1);
  });
});

describe('the paint clock', () => {
  let now = 0;
  beforeEach(() => { vi.spyOn(performance, 'now').mockImplementation(() => now); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('leads by the reading’s age plus a frame, timed on this machine', () => {
    const clock = createPlayheadClock();
    // A 120 Hz screen: readings 8.33 ms apart, each published one frame late.
    for (let k = 0; k < 200; k++) {
      const at = k * 1000 / 120;
      now = at + 1000 / 120;
      clock.set(k / 120, { at, rate: 1 });
    }
    // Two 120 Hz frames, not the 35 ms of two 60 Hz ones.
    expect(clock.lead()).toBeCloseTo(2 / 120, 3);
  });

  it('scales the lead by the playback speed, and drops it on a seek or pause', () => {
    const clock = createPlayheadClock();
    now = 20;
    clock.set(1, { at: 0, rate: 0.5 });
    expect(clock.lead()).toBeCloseTo(((20 + 1000 / 60) / 1000) * 0.5, 5);
    clock.set(3);
    expect(clock.lead()).toBe(0);
  });

  it('is read through usePaintClock, on the same updates as the playhead', () => {
    const clock = createPlayheadClock();
    function Probe() {
      return <span data-testid="t">{usePlayheadValue((t) => t, usePaintClock())}</span>;
    }
    const { getByTestId } = withClock(clock, <Probe />);
    const seen = () => Number(getByTestId('t').textContent);
    now = 1000;
    act(() => clock.set(10, { at: 1000 - 1000 / 60, rate: 1 }));
    expect(seen()).toBeCloseTo(10 + 2 / 60, 5);
    act(() => clock.set(12));
    expect(seen()).toBe(12);
  });
});
