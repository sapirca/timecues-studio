/**
 * Visualize with playback lights the cue the playhead crossed last. The light
 * follows the clock on its own: crossing a hit must not re-render the lane's
 * ticks, which on a drum lane are thousands of buttons.
 */

import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { CueLayerRow } from './CueLayerRow';
import { PlayheadClockContext, createPlayheadClock } from '../../hooks/usePlayhead';
import type { CueItem } from '../../types/annotationLayer';

const items: CueItem[] = [
  { id: 'a', time: 1, label: 'kick', velocity: 120 },
  { id: 'b', time: 2, label: 'snare', velocity: 100 },
  { id: 'c', time: 3, label: 'hat', velocity: 60 },
];

const lit = () => document.querySelector<HTMLElement>('[data-testid="cue-active"]');

describe('CueLayerRow visualize', () => {
  it('lights the last cue crossed, and nothing before the first', () => {
    const clock = createPlayheadClock(0.5);
    render(
      <PlayheadClockContext.Provider value={clock}>
        <CueLayerRow items={items} color="#eab308" duration={10} visualize />
      </PlayheadClockContext.Provider>,
    );
    expect(lit()).toBeNull();
    act(() => clock.set(2.5));
    expect(lit()?.style.left).toBe('20%');
    act(() => clock.set(9));
    expect(lit()?.style.left).toBe('30%');
  });

  it('crossing a hit leaves the ticks alone', () => {
    const clock = createPlayheadClock(0);
    render(
      <PlayheadClockContext.Provider value={clock}>
        <CueLayerRow items={items} color="#eab308" duration={10} visualize />
      </PlayheadClockContext.Provider>,
    );
    const before = [...document.querySelectorAll('button')];
    const titles = before.map((b) => b.title);
    for (let f = 1; f <= 40; f++) act(() => clock.set(f * 0.1));
    const after = [...document.querySelectorAll('button')];
    expect(after).toEqual(before);
    expect(after.map((b) => b.title)).toEqual(titles);
    // The ticks themselves never take the lit look — the overlay does.
    expect(after.every((b) => b.querySelector('span')?.className.includes('w-[3px]'))).toBe(true);
  });

  it('draws no light when visualize is off', () => {
    const clock = createPlayheadClock(5);
    render(
      <PlayheadClockContext.Provider value={clock}>
        <CueLayerRow items={items} color="#eab308" duration={10} />
      </PlayheadClockContext.Provider>,
    );
    expect(lit()).toBeNull();
  });
});
