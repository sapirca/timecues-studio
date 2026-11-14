/**
 * A cue's decay can be pulled out on the lane: a nub at the end of its tail
 * (or beside a tick that doesn't ring yet) sets how long it rings, and pulling
 * it back onto the tick clears it. The nub only exists where the cue could be
 * edited anyway.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CueLayerRow } from './CueLayerRow';
import type { CueItem } from '../../types/annotationLayer';

// A 1000px lane over a 10s song: 100px per second.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 1000, bottom: 22, width: 1000, height: 22, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

const ringing: CueItem = { id: 't', time: 4, label: 'tom', decay: 0.5 };
const plain: CueItem = { id: 'p', time: 2, label: 'plain' };

function lane(items: CueItem[], extra: Partial<React.ComponentProps<typeof CueLayerRow>> = {}) {
  const onCueDecayDrag = vi.fn();
  const onCueDecayDragStart = vi.fn();
  const onCueClick = vi.fn();
  const onCueDrag = vi.fn();
  render(
    <CueLayerRow
      items={items} color="#eab308" duration={10}
      onCueClick={onCueClick} onCueDrag={onCueDrag}
      onCueDecayDrag={onCueDecayDrag} onCueDecayDragStart={onCueDecayDragStart}
      {...extra}
    />,
  );
  return { onCueDecayDrag, onCueDecayDragStart, onCueClick, onCueDrag };
}

function drag(el: HTMLElement, fromX: number, toX: number) {
  fireEvent.pointerDown(el, { isPrimary: true, button: 0, clientX: fromX });
  fireEvent.pointerMove(document, { isPrimary: true, clientX: toX });
  fireEvent.pointerUp(document, { isPrimary: true, clientX: toX });
}

describe('CueLayerRow decay handle', () => {
  it('puts a nub at the end of the tail, and one beside a tick with no decay', () => {
    lane([ringing, plain]);
    const handles = screen.getAllByTestId('cue-decay-handle');
    expect(handles).toHaveLength(2);
    const byLabel = Object.fromEntries(handles.map((h) => [h.getAttribute('aria-label'), h]));
    // The pill rides the right end of a track from the tick: 4s + 0.5s of a
    // 10s song. A cue with no decay gets a track of just its min-width, so its
    // pill sits 7px right of the tick — as does a decay too short to clear it.
    const track = (h: HTMLElement) => h.parentElement as HTMLElement;
    expect(track(byLabel['Decay of tom']).style.left).toBe('40%');
    expect(track(byLabel['Decay of tom']).style.width).toBe('5%');
    expect(track(byLabel['Decay of plain']).style.left).toBe('20%');
    expect(track(byLabel['Decay of plain']).style.width).toBe('0%');
    expect(track(byLabel['Decay of plain']).style.minWidth).toBe('7px');
    expect(byLabel['Decay of plain'].className).toContain('right-0');
    expect(byLabel['Decay of plain'].title).toMatch(/Drag to set how long it rings \(decay\)/);
    expect(byLabel['Decay of tom'].getAttribute('role')).toBe('slider');
    expect(byLabel['Decay of tom'].getAttribute('aria-valuetext')).toBe('decay 500 ms');
    expect(byLabel['Decay of plain'].getAttribute('aria-valuetext')).toBe('no decay');
  });

  it('offers no nub on a read-only lane or in review mode', () => {
    render(<CueLayerRow items={[ringing, plain]} color="#eab308" duration={10} />);
    expect(screen.queryByTestId('cue-decay-handle')).toBeNull();
  });

  it('offers no nub in review mode even when the callback is wired', () => {
    lane([ringing], { reviewState: {} });
    expect(screen.queryByTestId('cue-decay-handle')).toBeNull();
  });

  it('sets the decay from the drag, measured from the tick, and never moves the cue', () => {
    const { onCueDecayDrag, onCueDecayDragStart, onCueDrag } = lane([plain]);
    drag(screen.getByTestId('cue-decay-handle'), 207, 262); // to 2.62s
    expect(onCueDecayDragStart).toHaveBeenCalledWith('p');
    expect(onCueDecayDrag).toHaveBeenLastCalledWith('p', 0.62);
    expect(onCueDrag).not.toHaveBeenCalled();
  });

  it('shows the live value while dragging', () => {
    lane([ringing]);
    const h = screen.getByTestId('cue-decay-handle');
    fireEvent.pointerDown(h, { isPrimary: true, button: 0, clientX: 450 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 442 });
    expect(screen.getByTestId('cue-decay-readout').textContent).toBe('decay 420 ms');
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 442 });
    expect(screen.queryByTestId('cue-decay-readout')).toBeNull();
  });

  it('clears the decay when pulled back onto (or past) the tick', () => {
    const { onCueDecayDrag } = lane([ringing]);
    drag(screen.getByTestId('cue-decay-handle'), 450, 403); // 3px from the tick
    expect(onCueDecayDrag).toHaveBeenLastCalledWith('t', undefined);
    drag(screen.getByTestId('cue-decay-handle'), 450, 300); // past it
    expect(onCueDecayDrag).toHaveBeenLastCalledWith('t', undefined);
  });

  it('stops the tail at the end of the song', () => {
    const { onCueDecayDrag } = lane([ringing]);
    drag(screen.getByTestId('cue-decay-handle'), 450, 1400);
    expect(onCueDecayDrag).toHaveBeenLastCalledWith('t', 6);
  });

  it('a click on the nub does not open the cue card', () => {
    const { onCueClick } = lane([ringing]);
    const h = screen.getByTestId('cue-decay-handle');
    fireEvent.pointerDown(h, { isPrimary: true, button: 0, clientX: 450 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 450 });
    fireEvent.click(h);
    expect(onCueClick).not.toHaveBeenCalled();
  });

  it('dragging the tick still moves the cue, decay untouched', () => {
    const { onCueDrag, onCueDecayDrag } = lane([ringing]);
    const tick = [...document.querySelectorAll('button')].find((b) => /^tom/.test(b.title))!;
    drag(tick, 400, 500);
    expect(onCueDrag).toHaveBeenLastCalledWith('t', 5);
    expect(onCueDecayDrag).not.toHaveBeenCalled();
  });
});

function onKey(items: CueItem[], extra: Partial<React.ComponentProps<typeof CueLayerRow>> = {}) {
  const onCueDecayKey = vi.fn();
  render(<CueLayerRow items={items} color="#eab308" duration={10} onCueDrag={() => {}} onCueDecayDrag={() => {}} onCueDecayKey={onCueDecayKey} {...extra} />);
  return onCueDecayKey;
}

describe('CueLayerRow decay handle — keyboard', () => {
  it('is focusable; arrows step the decay, Shift the coarse step, Delete clears', () => {
    const onCueDecayKey = onKey([ringing]);
    const h = screen.getByTestId('cue-decay-handle');
    expect(h.tabIndex).toBe(0);
    fireEvent.keyDown(h, { key: 'ArrowRight' });
    expect(onCueDecayKey).toHaveBeenLastCalledWith('t', 0.51, false);
    fireEvent.keyDown(h, { key: 'ArrowLeft', shiftKey: true });
    expect(onCueDecayKey).toHaveBeenLastCalledWith('t', 0.4, false);
    fireEvent.keyDown(h, { key: 'ArrowRight', repeat: true });
    expect(onCueDecayKey).toHaveBeenLastCalledWith('t', 0.51, true);
    fireEvent.keyDown(h, { key: 'Delete' });
    expect(onCueDecayKey).toHaveBeenLastCalledWith('t', undefined, false);
  });

  it('creates a decay from nothing, and stepping back onto the tick clears it', () => {
    const onCueDecayKey = onKey([plain, { id: 'q', time: 3, label: 'short', decay: 0.01 }]);
    const [p, q] = screen.getAllByTestId('cue-decay-handle');
    fireEvent.keyDown(p, { key: 'ArrowRight' });
    expect(onCueDecayKey).toHaveBeenLastCalledWith('p', 0.01, false);
    fireEvent.keyDown(q, { key: 'ArrowLeft' });
    expect(onCueDecayKey).toHaveBeenLastCalledWith('q', undefined, false);
  });

  it('keeps its keys from the page: an arrow does not seek, Delete does not remove the cue', () => {
    onKey([ringing]);
    const page = vi.fn();
    window.addEventListener('keydown', page);
    fireEvent.keyDown(screen.getByTestId('cue-decay-handle'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByTestId('cue-decay-handle'), { key: 'Backspace' });
    window.removeEventListener('keydown', page);
    expect(page).not.toHaveBeenCalled();
  });

  it('shows no keyboard control on a read-only lane', () => {
    render(<CueLayerRow items={[ringing]} color="#eab308" duration={10} onCueDecayKey={vi.fn()} />);
    expect(screen.queryByTestId('cue-decay-handle')).toBeNull();
  });
});

describe('CueLayerRow decay readout placement', () => {
  it('reads right of the nub, and flips left where it would run off the lane', () => {
    lane([ringing]);
    const h = screen.getByTestId('cue-decay-handle');
    fireEvent.pointerDown(h, { isPrimary: true, button: 0, clientX: 450 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 500 });
    expect(screen.getByTestId('cue-decay-readout').getAttribute('data-side')).toBe('right');
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 960 });
    const readout = screen.getByTestId('cue-decay-readout');
    expect(readout.getAttribute('data-side')).toBe('left');
    expect(readout.className).toContain('right-2');
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 960 });
  });
});

describe('CueLayerRow decay readout on keyboard focus', () => {
  it('reads right of a focused nub in the middle of the lane', () => {
    onKey([ringing]);
    const h = screen.getByTestId('cue-decay-handle');
    fireEvent.focus(h);
    const readout = h.querySelector('[data-side]') as HTMLElement;
    expect(readout.getAttribute('data-side')).toBe('right');
    expect(readout.textContent).toBe('decay 500 ms');
    expect(readout.className).toContain('group-focus-visible/decay:block');
  });
});

describe('CueLayerRow decay nub in a crowd', () => {
  const cluster: CueItem[] = [
    { id: 'a', time: 2, label: 'a' },
    { id: 'b', time: 2.05, label: 'b' }, // its tick lands on a's nub
  ];

  it('sits under the ticks until its own cue is selected, then rises over them', () => {
    const { rerender } = render(<CueLayerRow items={cluster} color="#eab308" duration={10} onCueDrag={() => {}} onCueDecayDrag={() => {}} />);
    const nubOfA = () => screen.getAllByTestId('cue-decay-handle').find((h) => h.getAttribute('aria-label') === 'Decay of a')!.parentElement!;
    expect(nubOfA().className).toMatch(/(^| )z-0( |$)/);
    expect(nubOfA().className).toContain('group-hover/cuewrap:z-20');
    rerender(<CueLayerRow items={cluster} color="#eab308" duration={10} onCueDrag={() => {}} onCueDecayDrag={() => {}} focusedItemId="a" />);
    expect(nubOfA().className).toMatch(/(^| )z-20( |$)/);
    // Ticks stack at z 1-7, so a selected cue's nub (20) is above every one of them.
    const tickB = [...document.querySelectorAll('button')].find((b) => /^b @/.test(b.title))!;
    expect(Number(tickB.style.zIndex)).toBeLessThan(20);
  });

  it('rises above everything while dragged', () => {
    render(<CueLayerRow items={cluster} color="#eab308" duration={10} onCueDrag={() => {}} onCueDecayDrag={() => {}} />);
    const nub = screen.getAllByTestId('cue-decay-handle')[0];
    fireEvent.pointerDown(nub, { isPrimary: true, button: 0, clientX: 207 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 260 });
    expect(screen.getAllByTestId('cue-decay-track')[0].className).toMatch(/(^| )z-30( |$)/);
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 260 });
  });
});
