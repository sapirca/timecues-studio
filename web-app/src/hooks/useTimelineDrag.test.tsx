/**
 * The timeline's drag machinery, driven the way a phone drives it.
 *
 * A touchscreen never sends mousemove while a finger is down — only pointer
 * events — so every gesture here is fired as pointer events. The cases that
 * matter on a phone and never came up with a mouse get their own tests:
 * pointercancel (the browser taking the touch back to scroll the page) must
 * leave nothing armed, and a second finger must neither start nor steer a
 * gesture.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { useRef } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useBodyMoveDrag, useRegionSelectDrag, useTimelineDrag } from './useTimelineDrag';

const ROW_WIDTH = 1000;
const DURATION = 100; // 10px per second

beforeAll(() => {
  // jsdom lays nothing out, so the row has no width to map clientX onto.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: ROW_WIDTH, bottom: 40,
    width: ROW_WIDTH, height: 40, toJSON: () => ({}),
  } as DOMRect);
});

/** A finger: primary, pointer 1, touch. Spread over per-event fields. */
const finger = (init: Record<string, unknown> = {}) => ({ isPrimary: true, pointerId: 1, pointerType: 'touch', ...init });

// ── useRegionSelectDrag ──────────────────────────────────────────────────────

function RegionSurface(props: {
  onRegion: (a: number, b: number) => void;
  onClick: (t: number) => void;
  onDragStart?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRegionSelectDrag({
    containerRef: ref,
    durationGetter: () => DURATION,
    onDragStart: props.onDragStart,
    onClick: props.onClick,
    onRegion: (a, b) => props.onRegion(a, b),
  });
  return (
    <div ref={ref} data-testid="surface" onPointerDown={drag.onPointerDown}>
      {drag.preview && <span data-testid="preview">{`${drag.preview.s}-${drag.preview.e}`}</span>}
    </div>
  );
}

function mountRegion() {
  const onRegion = vi.fn();
  const onClick = vi.fn();
  const onDragStart = vi.fn();
  const utils = render(<RegionSurface onRegion={onRegion} onClick={onClick} onDragStart={onDragStart} />);
  return { ...utils, surface: utils.getByTestId('surface'), onRegion, onClick, onDragStart };
}

describe('useRegionSelectDrag with pointer events', () => {
  it('paints a region from a touch drag', () => {
    const { surface, onRegion, onClick, queryByTestId } = mountRegion();
    fireEvent.pointerDown(surface, finger({ clientX: 100 }));
    fireEvent.pointerMove(document, finger({ clientX: 400 }));
    expect(queryByTestId('preview')?.textContent).toBe('10-40');
    fireEvent.pointerUp(document, finger({ clientX: 400 }));
    expect(onRegion).toHaveBeenCalledWith(10, 40);
    expect(onClick).not.toHaveBeenCalled();
    expect(queryByTestId('preview')).toBeNull();
  });

  it('reads a tap as a seek at the down-time', () => {
    const { surface, onRegion, onClick } = mountRegion();
    fireEvent.pointerDown(surface, finger({ clientX: 300 }));
    fireEvent.pointerUp(document, finger({ clientX: 303 }));
    expect(onRegion).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith(30);
  });

  it('abandons the gesture on pointercancel — neither a region nor a seek', () => {
    const { surface, onRegion, onClick, queryByTestId } = mountRegion();
    fireEvent.pointerDown(surface, finger({ clientX: 100 }));
    fireEvent.pointerMove(document, finger({ clientX: 400 }));
    fireEvent.pointerCancel(document, finger());
    expect(queryByTestId('preview')).toBeNull();
    // Nothing is left listening: a later release is not taken as the end of it.
    fireEvent.pointerUp(document, finger({ clientX: 400 }));
    expect(onRegion).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ignores a second finger, both as a start and as a move', () => {
    const { surface, onRegion, onDragStart, queryByTestId } = mountRegion();
    fireEvent.pointerDown(surface, finger({ isPrimary: false, pointerId: 2, clientX: 100 }));
    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.pointerDown(surface, finger({ clientX: 100 }));
    fireEvent.pointerMove(document, finger({ pointerId: 2, isPrimary: false, clientX: 900 }));
    expect(queryByTestId('preview')).toBeNull();
    // The second finger lifting doesn't end the first finger's gesture.
    fireEvent.pointerUp(document, finger({ pointerId: 2, isPrimary: false, clientX: 900 }));
    expect(onRegion).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, finger({ clientX: 500 }));
    expect(onRegion).toHaveBeenCalledWith(10, 50);
  });

  it('cancels a touch pointerdown, but lets a mouse press reach document mousedown listeners', () => {
    const { surface } = mountRegion();
    const touchDown = fireEvent.pointerDown(surface, finger({ clientX: 100 }));
    expect(touchDown).toBe(false); // defaultPrevented
    fireEvent.pointerCancel(document, finger());

    // Outside-click closers listen for mousedown on the document; a mouse
    // press on a row must still reach them, with its default (text
    // selection, focus) cancelled as the old mousedown handler did.
    const mouseDown = fireEvent.pointerDown(surface, { isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 100 });
    expect(mouseDown).toBe(true);
    const onDocMouseDown = vi.fn();
    document.addEventListener('mousedown', onDocMouseDown);
    const compat = fireEvent.mouseDown(surface, { clientX: 100 });
    document.removeEventListener('mousedown', onDocMouseDown);
    expect(onDocMouseDown).toHaveBeenCalled();
    expect(compat).toBe(false);
    fireEvent.pointerUp(document, { isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 100 });
  });
});

// ── useTimelineDrag ──────────────────────────────────────────────────────────

function Handle(props: {
  onDrag: (t: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { startDrag } = useTimelineDrag<{ id: string }>({
    containerRef: ref,
    duration: DURATION,
    onDragStart: props.onDragStart,
    onDragEnd: props.onDragEnd,
    onDrag: (_p, t) => props.onDrag(t),
    // Keep the marker off the last ten seconds, to prove the clamp is used.
    clamp: (_p, raw) => Math.max(0, Math.min(90, raw)),
  });
  return (
    <div ref={ref} data-testid="row">
      <span data-testid="handle" onPointerDown={(e) => startDrag({ id: 'a' }, e)} onClick={props.onClick} />
    </div>
  );
}

function mountHandle() {
  const onDrag = vi.fn();
  const onDragStart = vi.fn();
  const onDragEnd = vi.fn();
  const onClick = vi.fn();
  const utils = render(<Handle onDrag={onDrag} onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onClick} />);
  return { ...utils, handle: utils.getByTestId('handle'), onDrag, onDragStart, onDragEnd, onClick };
}

describe('useTimelineDrag with pointer events', () => {
  it('drags a marker with a finger, clamped, and ends on pointerup', () => {
    const { handle, onDrag, onDragStart, onDragEnd } = mountHandle();
    const down = fireEvent.pointerDown(handle, finger({ clientX: 200 }));
    expect(down).toBe(false); // defaultPrevented: no emulated mouse events, no page pan
    expect(onDragStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(document, finger({ clientX: 350 }));
    expect(onDrag).toHaveBeenLastCalledWith(35);
    fireEvent.pointerMove(document, finger({ clientX: 990 }));
    expect(onDrag).toHaveBeenLastCalledWith(90);
    fireEvent.pointerUp(document, finger({ clientX: 990 }));
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(document, finger({ clientX: 100 }));
    expect(onDrag).toHaveBeenCalledTimes(2);
  });

  it('ends the drag on pointercancel, so nothing is left armed', () => {
    const { handle, onDrag, onDragEnd } = mountHandle();
    fireEvent.pointerDown(handle, finger({ clientX: 200 }));
    fireEvent.pointerMove(document, finger({ clientX: 300 }));
    fireEvent.pointerCancel(document, finger());
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    // A later pointer wandering over the page must not move the marker.
    fireEvent.pointerMove(document, finger({ pointerId: 7, clientX: 700 }));
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it('ignores a second finger', () => {
    const { handle, onDrag, onDragStart, onDragEnd } = mountHandle();
    fireEvent.pointerDown(handle, finger({ isPrimary: false, pointerId: 2, clientX: 200 }));
    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, finger({ clientX: 200 }));
    fireEvent.pointerMove(document, finger({ isPrimary: false, pointerId: 2, clientX: 800 }));
    expect(onDrag).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, finger({ isPrimary: false, pointerId: 2 }));
    expect(onDragEnd).not.toHaveBeenCalled();
    fireEvent.pointerMove(document, finger({ clientX: 400 }));
    expect(onDrag).toHaveBeenLastCalledWith(40);
    fireEvent.pointerUp(document, finger());
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('still accepts a plain mouse press from a caller that has not been ported', () => {
    function MouseHandle({ onDrag }: { onDrag: (t: number) => void }) {
      const ref = useRef<HTMLDivElement | null>(null);
      const { startDrag } = useTimelineDrag<{ id: string }>({
        containerRef: ref, duration: DURATION, onDrag: (_p, t) => onDrag(t),
      });
      return (
        <div ref={ref}>
          <span data-testid="legacy" onMouseDown={(e) => startDrag({ id: 'a' }, e)} />
        </div>
      );
    }
    const onDrag = vi.fn();
    const { getByTestId } = render(<MouseHandle onDrag={onDrag} />);
    fireEvent.mouseDown(getByTestId('legacy'), { clientX: 100 });
    // A real mouse sends pointermove alongside mousemove; the hook follows those.
    fireEvent.pointerMove(document, { isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 250 });
    expect(onDrag).toHaveBeenLastCalledWith(25);
    fireEvent.pointerUp(document, { isPrimary: true, pointerId: 1, pointerType: 'mouse' });
  });
});

// ── useBodyMoveDrag ──────────────────────────────────────────────────────────

function Band(props: { onMove: (s: number, e: number) => void; onMoveEnd: () => void; onClickBand: (dragged: boolean) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef: ref,
    durationGetter: () => DURATION,
    onMove: (_id, s, e) => props.onMove(s, e),
    onMoveEnd: props.onMoveEnd,
  });
  return (
    <div ref={ref}>
      <button
        data-testid="band"
        onPointerDown={(e) => startBodyMove('b', 20, 30, e)}
        onClick={() => props.onClickBand(wasDraggedRef.current)}
      />
    </div>
  );
}

describe('useBodyMoveDrag with pointer events', () => {
  it('leaves a tap as a click, and a drag as a move', () => {
    const onMove = vi.fn();
    const onMoveEnd = vi.fn();
    const onClickBand = vi.fn();
    const { getByTestId } = render(<Band onMove={onMove} onMoveEnd={onMoveEnd} onClickBand={onClickBand} />);
    const band = getByTestId('band');

    // A tap: the press is not cancelled, so the click that follows opens the band.
    expect(fireEvent.pointerDown(band, finger({ clientX: 250, clientY: 10 }))).toBe(true);
    fireEvent.pointerUp(document, finger({ clientX: 251, clientY: 10 }));
    fireEvent.click(band);
    expect(onClickBand).toHaveBeenLastCalledWith(false);
    expect(onMove).not.toHaveBeenCalled();

    // A drag: moved past the threshold, the band follows and the click is skipped.
    fireEvent.pointerDown(band, finger({ clientX: 250, clientY: 10 }));
    fireEvent.pointerMove(document, finger({ clientX: 350, clientY: 10 }));
    expect(onMove).toHaveBeenLastCalledWith(30, 40);
    fireEvent.pointerUp(document, finger({ clientX: 350, clientY: 10 }));
    expect(onMoveEnd).toHaveBeenCalledTimes(1);
    fireEvent.click(band);
    expect(onClickBand).toHaveBeenLastCalledWith(true);
  });

  it('closes the move on pointercancel and stops listening', () => {
    const onMove = vi.fn();
    const onMoveEnd = vi.fn();
    const { getByTestId } = render(<Band onMove={onMove} onMoveEnd={onMoveEnd} onClickBand={() => {}} />);
    fireEvent.pointerDown(getByTestId('band'), finger({ clientX: 250, clientY: 10 }));
    fireEvent.pointerMove(document, finger({ clientX: 350, clientY: 10 }));
    fireEvent.pointerCancel(document, finger());
    expect(onMoveEnd).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(document, finger({ clientX: 600, clientY: 10 }));
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
