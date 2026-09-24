/** Outside-click closers listen for `pointerdown`, not `mousedown`.
 *
 *  Every timeline surface cancels its pointerdown on a touchscreen, and a
 *  cancelled pointerdown never produces the compatibility mousedown — so a
 *  closer on `mousedown` stayed open over whatever a finger tapped. These pin
 *  the new event and the two things that must not change with it: a press
 *  inside the menu (portal included) keeps it open, and pressing the trigger
 *  of an open menu still closes it rather than closing and reopening. */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, renderHook, act } from '@testing-library/react';
import { AnnotationSourcePicker } from './shared/AnnotationSourcePicker';
import { LayerAudioControls, DEFAULT_LAYER_AUDIO } from './LayerAudioControls';
import { useSectionEditPopover } from './useSectionEditPopover';
import { BandEdgeHandle } from './shared/BandEdgeHandle';

afterEach(cleanup);

/** What a real tap or click delivers, in order. A touch whose pointerdown was
 *  cancelled stops after the first one. */
function press(el: Element) {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

function renderPicker() {
  const outside = document.createElement('div');
  document.body.appendChild(outside);
  const view = render(
    <AnnotationSourcePicker
      category="cues"
      value="manual"
      onChange={() => {}}
      options={[{ id: 'manual', label: 'Manual' }, { id: 'autoGuess', label: 'Auto-guess' }]}
    />,
  );
  const trigger = view.getByLabelText('Select source for cues');
  const isOpen = () => view.queryByText('Auto-guess') !== null;
  return { view, trigger, isOpen, outside };
}

describe('outside-click closers', () => {
  it('close on a bare pointerdown outside — a touch that never becomes a mousedown', () => {
    const { trigger, isOpen, outside } = renderPicker();
    press(trigger);
    expect(isOpen()).toBe(true);

    fireEvent.pointerDown(outside);
    expect(isOpen()).toBe(false);
    outside.remove();
  });

  it('stay open for a press inside the menu', () => {
    const { view, trigger, isOpen } = renderPicker();
    press(trigger);
    fireEvent.pointerDown(view.getByText('Auto-guess'));
    expect(isOpen()).toBe(true);
  });

  it('close, and stay closed, when the trigger of an open menu is pressed', () => {
    const { trigger, isOpen } = renderPicker();
    press(trigger);
    expect(isOpen()).toBe(true);
    press(trigger);
    expect(isOpen()).toBe(false);
  });

  it('treat a press inside a portal-rendered popover as inside', () => {
    vi.stubGlobal('AudioContext', class {});
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const view = render(
      <LayerAudioControls value={{ ...DEFAULT_LAYER_AUDIO }} onChange={() => {}} label="Cues" />,
    );
    press(view.getByText('Cues'));
    const pip = view.getByTitle('Play one pip at current settings');

    fireEvent.pointerDown(pip);
    expect(view.queryByTitle('Play one pip at current settings')).not.toBeNull();

    fireEvent.pointerDown(outside);
    expect(view.queryByTitle('Play one pip at current settings')).toBeNull();
    outside.remove();
    vi.unstubAllGlobals();
  });

  it('useSectionEditPopover closes on pointerdown outside and reports it', () => {
    const onClose = vi.fn();
    const popover = document.createElement('div');
    const outside = document.createElement('div');
    document.body.append(popover, outside);
    const { result } = renderHook(() => useSectionEditPopover({ onClose }));
    (result.current.popoverRef as { current: HTMLDivElement | null }).current = popover;

    act(() => result.current.open(2));
    act(() => { fireEvent.pointerDown(popover); });
    expect(result.current.editingIdx).toBe(2);

    act(() => { fireEvent.pointerDown(outside); });
    expect(result.current.editingIdx).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    popover.remove();
    outside.remove();
  });
});

describe('BandEdgeHandle', () => {
  it('widens the grip itself on touch, capped to a share of the band, instead of .tc-hit', () => {
    const view = render(
      <div style={{ position: 'relative', overflow: 'hidden' }}>
        <BandEdgeHandle edge="end" widthClass="w-2" label="Drag to move loop end" onPointerDown={() => {}} />
      </div>,
    );
    const grip = view.getByLabelText('Drag to move loop end');
    // .tc-hit's ::before reached 10px both ways; inside an overflow-hidden
    // band only the inward half survived, and on a narrow band it covered the
    // whole body.
    expect(grip.className).not.toContain('tc-hit');
    expect(grip.className).toContain('pointer-coarse:w-[18px]');
    expect(grip.style.maxWidth).toBe('30%');
    // The visible wash keeps the desktop width inside the wider grip.
    const wash = grip.firstElementChild as HTMLElement;
    expect(wash.className).toContain('w-2');
    expect(wash.className).toContain('right-0');
  });

  it('keeps the click from reaching the band, which would open its card', () => {
    const onBandClick = vi.fn();
    const onPointerDown = vi.fn();
    const view = render(
      <button onClick={onBandClick}>
        <BandEdgeHandle edge="start" widthClass="w-1.5" label="Drag to move span start" onPointerDown={onPointerDown} />
      </button>,
    );
    const grip = view.getByLabelText('Drag to move span start');
    fireEvent.pointerDown(grip);
    fireEvent.click(grip);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onBandClick).not.toHaveBeenCalled();
  });
});
