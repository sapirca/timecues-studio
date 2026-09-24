/**
 * The snap flash is a one-shot confirmation, not a state.
 *
 * Placing a cue that lands on a beat line pings a violet ring for 800 ms so
 * "your click was snapped" is visible. That ping used to be held by a single
 * timer owned by the effect that started it — so the *next* re-run with a new
 * `items` array (another cue placed, any edit to the doc) cleared the timer,
 * found no changed times, and returned before scheduling a replacement. The
 * ring stayed on screen forever, and every cue placed on the grid added
 * another one: a lane of permanently flashing cues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render } from '@testing-library/react';
import { CueLayerRow } from './CueLayerRow';
import type { CueItem } from '../../types/annotationLayer';

const DURATION = 8;
const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 }; // a beat every 0.5 s

// Raw `act` (we drive timers, not events) needs the flag RTL's own render
// sets only around its calls.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cue = (id: string, time: number): CueItem => ({ id, time, label: id });

/** The `animate-ping` rings currently on screen. */
const pings = (root: HTMLElement) => root.querySelectorAll('.animate-ping');

describe('CueLayerRow snap flash', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stops pinging a snapped cue 800 ms after it is placed', () => {
    const { container, rerender } = render(
      <CueLayerRow items={[]} color="#4ade80" duration={DURATION} currentTime={0} gridProps={GRID} />,
    );
    rerender(
      <CueLayerRow items={[cue('a', 1.0)]} color="#4ade80" duration={DURATION} currentTime={0} gridProps={GRID} />,
    );
    expect(pings(container)).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(900); });
    expect(pings(container)).toHaveLength(0);
  });

  it('does not strand the first cue when a second one is placed mid-flash', () => {
    const { container, rerender } = render(
      <CueLayerRow items={[]} color="#4ade80" duration={DURATION} currentTime={0} gridProps={GRID} />,
    );
    rerender(
      <CueLayerRow items={[cue('a', 1.0)]} color="#4ade80" duration={DURATION} currentTime={0} gridProps={GRID} />,
    );
    act(() => { vi.advanceTimersByTime(400); });
    // Second cue lands while the first is still pinging — a fresh `items`
    // array, which is exactly what used to kill the first cue's timer.
    rerender(
      <CueLayerRow items={[cue('a', 1.0), cue('b', 2.0)]} color="#4ade80" duration={DURATION} currentTime={0} gridProps={GRID} />,
    );
    expect(pings(container)).toHaveLength(2);

    act(() => { vi.advanceTimersByTime(500); }); // 900 ms for 'a', 500 ms for 'b'
    expect(pings(container)).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(400); });
    expect(pings(container)).toHaveLength(0);
  });

  it('keeps quiet while the playhead moves over the cues', () => {
    const items = [cue('a', 1.0), cue('b', 2.0)];
    const { container, rerender } = render(
      <CueLayerRow items={items} color="#4ade80" duration={DURATION} currentTime={0} gridProps={GRID} />,
    );
    act(() => { vi.advanceTimersByTime(900); });
    for (const t of [0.5, 1.0, 1.5, 2.0, 2.5]) {
      // Playback re-renders with a fresh array every frame; nothing moved.
      rerender(
        <CueLayerRow items={[...items]} color="#4ade80" duration={DURATION} currentTime={t} gridProps={GRID} />,
      );
    }
    expect(pings(container)).toHaveLength(0);
  });
});
