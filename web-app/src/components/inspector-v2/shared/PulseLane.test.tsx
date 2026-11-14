/**
 * Zoomed out, a fast pulse puts more ticks in a band than it has pixels, and
 * the marks merge into stripes that hide the band itself. Past that point the
 * rate is named in one chip instead; zoomed in, the ticks come back.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { PlayheadClockContext, createPlayheadClock } from '../../../hooks/usePlayhead';
import { PulseTicks, labelNamesPulseRate } from './PulseLane';

const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 }; // a beat every 0.5 s

function withWidth(px: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(px);
}

afterEach(() => vi.restoreAllMocks());

describe('PulseTicks density', () => {
  // 16ths over 10 s = 80 ticks, 0.125 s apart.
  const props = { rate: '16th' as const, start: 0, end: 10, color: '#22d3ee', grid: GRID };

  it('draws the ticks when the band has room for them', () => {
    withWidth(2000); // 25 px between ticks
    const { container, queryByTestId } = render(<div style={{ position: 'relative' }}><PulseTicks {...props} /></div>);
    expect(queryByTestId('pulse-rate-chip')).toBeNull();
    expect(container.querySelectorAll('.w-px').length).toBeGreaterThan(50);
  });

  it('names the rate in a chip instead once the ticks would merge', () => {
    withWidth(200); // 2.5 px between ticks
    const { container, getByTestId } = render(<div style={{ position: 'relative' }}><PulseTicks {...props} /></div>);
    expect(getByTestId('pulse-rate-chip').textContent).toBe('1/4 beat');
    expect(container.querySelectorAll('.w-px').length).toBe(0);
  });
});

describe('PulseTicks never draws a pulse as nothing', () => {
  it('names the rate when the song has no tempo to tick against', () => {
    withWidth(2000);
    const { getByTestId } = render(<div style={{ position: 'relative' }}>
      <PulseTicks rate="beat" start={0} end={10} color="#22d3ee" grid={undefined} />
    </div>);
    expect(getByTestId('pulse-rate-chip').textContent).toBe('1 beat');
  });
});

describe('PulseTicks steps aside for a label that already names the rate', () => {
  it('draws neither ticks nor a chip over "Kick · Beat" once zoomed out', () => {
    withWidth(200); // 2.5 px between 16ths
    const { container, queryByTestId } = render(<div style={{ position: 'relative' }}>
      <PulseTicks rate="16th" start={0} end={10} color="#22d3ee" grid={GRID} labelNamesRate />
    </div>);
    expect(queryByTestId('pulse-rate-chip')).toBeNull();
    expect(container.querySelectorAll('.w-px').length).toBe(0);
  });

  it('matches the rate only as a whole " · " part of the label', () => {
    expect(labelNamesPulseRate('Kick · Beat · 24 bars', 'beat')).toBe(true);
    expect(labelNamesPulseRate('Hat · 1/4 beat', '16th')).toBe(true);
    expect(labelNamesPulseRate('Upbeat stabs', 'beat')).toBe(false);
    expect(labelNamesPulseRate('Kick · Beat', '16th')).toBe(false);
    expect(labelNamesPulseRate('Kick · Beat', undefined)).toBe(false);
  });
});

describe('PulseTicks blinks with the playhead', () => {
  function renderAt(t: number, blink: boolean) {
    const clock = createPlayheadClock(t);
    const view = render(
      <PlayheadClockContext.Provider value={clock}>
        <div style={{ position: 'relative' }}>
          <PulseTicks rate="beat" start={2} end={6} color="#f87171" grid={GRID} blink={blink} />
        </div>
      </PlayheadClockContext.Provider>,
    );
    return { ...view, clock };
  }
  function atTime(t: number) {
    const { getByTestId, clock } = renderAt(t, true);
    return { flash: getByTestId('pulse-flash'), clock };
  }

  it('does not blink unless the lane is visualized', () => {
    const { queryByTestId } = renderAt(3.0, false);
    expect(queryByTestId('pulse-flash')).toBeNull();
  });

  it('lights on a tick and is dark again before the next', () => {
    const { flash, clock } = atTime(3.0);          // a beat, 120 BPM
    expect(Number(flash.style.opacity)).toBeGreaterThan(0.5);
    act(() => clock.set(3.3));                      // 0.3 s on, the next beat at 3.5
    expect(Number(flash.style.opacity)).toBe(0);
    act(() => clock.set(3.5));
    expect(Number(flash.style.opacity)).toBeGreaterThan(0.5);
  });

  it('stays dark outside its span', () => {
    const { flash } = atTime(8.0);
    expect(Number(flash.style.opacity)).toBe(0);
  });
});
