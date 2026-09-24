/**
 * useTimelineDrag — shared pointer-drag-to-reposition machinery for every
 * annotation marker on the visualization canvas.
 *
 * Boundary handles, cue/anchor points, loop/span edges all
 * share the same physics: grab the marker, document-level pointermove maps
 * x-pixels → song-time within the row's container rect, pointerup ends.
 * The payload is generic so callers can encode whatever target identity
 * they need (an itemId, a {layerId,itemId,edge} tuple, an anchor index…).
 *
 * Pointer Events rather than mouse events, because a phone never sends a
 * mousemove while a finger is down: a touch that lands on a handle produces
 * pointerdown / pointermove / pointerup and nothing else until it lifts, so a
 * mouse-only drag simply could not be started from a touchscreen. A mouse
 * produces the same pointer events, so one code path serves both. Every
 * gesture also listens for pointercancel — the browser taking the touch back
 * to scroll the page, a system gesture, the pen leaving range — and treats it
 * as the end of the gesture, so nothing is left armed waiting for a pointerup
 * that will never come. A second finger (a non-primary pointer) never starts
 * or steers a gesture.
 *
 * Refs are updated synchronously in the render body — not via useEffect —
 * so the latest duration / callback values are visible to the pointermove
 * handler on the very next render. useEffect sync would lag by one commit,
 * which leaves duration stale at 0 on the first drag attempt after the
 * audio finishes decoding.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** What a drag can be started from. Pointer events are what every surface
 *  wires now; a plain mouse event is still accepted so a caller that has not
 *  been ported keeps working (PointerEvent extends MouseEvent). */
export type PressEvent = React.PointerEvent | React.MouseEvent;

/**
 * True for a press no drag should start from, or a move/up that belongs to a
 * different pointer than the one driving the gesture: the second finger of a
 * pinch, a non-primary pen. A plain MouseEvent carries no `isPrimary` and is
 * always accepted, as a mouse always is.
 */
export function isSecondaryPointer(e: PressEvent | MouseEvent): boolean {
  return 'isPrimary' in e && e.isPrimary === false;
}

/** The pointer that started a gesture, or null when it began from a mouse
 *  event (which has no id, so every later move is accepted). */
export function pointerIdOf(e: PressEvent | MouseEvent): number | null {
  return 'pointerId' in e && typeof e.pointerId === 'number' ? e.pointerId : null;
}

/** Whether a document-level move/up/cancel belongs to the gesture started by
 *  `activeId` — keeps a second finger from dragging or ending someone else's
 *  drag. */
export function isSamePointer(activeId: number | null, ev: MouseEvent): boolean {
  if (activeId === null) return true;
  return !('pointerId' in ev) || (ev as PointerEvent).pointerId === activeId;
}

/**
 * The pointer-event equivalent of `preventDefault()` on the old mousedown,
 * for a surface that does NOT stop propagation — the region-select rows.
 *
 * Cancelling a pointerdown is stronger than cancelling a mousedown was: the
 * browser then never fires the compatibility mousedown at all. For a mouse
 * that used to matter, because the outside-click closers all over the app
 * (menus, pickers, popovers) listened for `mousedown` on the document, and
 * clicking a row to seek has always dismissed them. The closers listen for
 * `pointerdown` now — the only event a tap on a row still delivers, since on
 * touch the pointerdown IS cancelled — but anything else that listens for a
 * mousedown still gets one from a mouse: the pointerdown is left alone and the
 * compatibility mousedown that follows has its default cancelled instead — no
 * text selection, no focus change, exactly as before — while still bubbling
 * to whoever listens. Touch and pen have no such listeners worth keeping, and
 * there the cancelled pointerdown is what stops the late emulated mouse events
 * from arriving after the finger lifts.
 */
export function preventPressDefault(e: PressEvent): void {
  const pointerType = 'pointerType' in e ? e.pointerType : undefined;
  if (pointerType !== 'mouse') { e.preventDefault(); return; }
  e.currentTarget.addEventListener('mousedown', (ev) => ev.preventDefault(), { once: true });
}

/** Minimum gap between start/end while edge-dragging an interval (seconds). */
export const EDGE_DRAG_MIN_MARGIN_SEC = 0.05;

/**
 * Build the clamp function for interval edge-dragging used by every
 * start/end-bounded annotation lane (Loops, Spans). Keeps the
 * dragged edge inside [0, duration] AND on the correct side of its sibling
 * edge by `minMargin` so the band can't invert or collapse to zero width.
 */
export function createEdgeItemClamp<T extends { id: string; start: number; end: number }>(
  itemsRef: RefObject<readonly T[]>,
  duration: number,
  minMargin: number = EDGE_DRAG_MIN_MARGIN_SEC,
) {
  return (payload: { id: string; edge: 'start' | 'end' }, raw: number): number => {
    const item = itemsRef.current?.find((x) => x.id === payload.id);
    if (!item) return Math.max(0, Math.min(duration, raw));
    if (payload.edge === 'start') return Math.max(0, Math.min(item.end - minMargin, raw));
    return Math.max(item.start + minMargin, Math.min(duration, raw));
  };
}

export interface UseTimelineDragOptions<TPayload> {
  /** Container whose bounding rect defines the time-axis. */
  containerRef: RefObject<HTMLElement | null>;
  /** Song duration in seconds. Always pass the live value — the hook reads
   *  it through a ref so document pointermove sees the freshest number. */
  duration: number;
  /** Called continuously while dragging. Receives the payload supplied to
   *  startDrag plus the new time (already clamped if a clamp fn was given). */
  onDrag: (payload: TPayload, time: number) => void;
  /** Called once when the drag begins. Use this to snapshot for undo. */
  onDragStart?: (payload: TPayload) => void;
  /** Called once when the drag ends (pointerup, or pointercancel — the
   *  browser taking the touch away still ends the gesture). */
  onDragEnd?: (payload: TPayload) => void;
  /** Optional per-drag clamp. Default clamps to [0, duration]. */
  clamp?: (payload: TPayload, rawTime: number) => number;
}

export interface TimelineDragHandle<TPayload> {
  /** Wire this to a marker's onPointerDown. Auto-stops propagation and
   *  prevents default so the host row's click/seek logic doesn't fire.
   *  Cancelling the pointerdown also suppresses the compatibility mousedown
   *  (so an ancestor's onMouseDown can't fire either), but not the click —
   *  a marker that opens something on click still gets it after a tap. */
  startDrag: (payload: TPayload, e: PressEvent) => void;
  /** True while a drag is in flight — useful for hover suppression. */
  isDraggingRef: RefObject<TPayload | null>;
}

/**
 * useBodyMoveDrag — drag-or-click helper for band/tile bodies.
 *
 * Differs from useTimelineDrag in two ways:
 *  • Doesn't preventDefault on pointerdown, so the underlying click still
 *    fires when the user just taps (needed because clicking a band opens its
 *    edit popover).
 *  • Only commits to a "move" past a small pixel threshold; below threshold
 *    the gesture is treated as a click and `wasDraggedRef` stays false.
 *
 * Returns `wasDraggedRef` so the click handler can check it and skip the
 * click action when the press was actually a drag (pointerup → click are
 * synchronous, so the flag set during the drag is still visible to the
 * click handler). A touch that moved usually gets no click at all; the flag
 * is reset at the next press, so that costs nothing.
 */
export interface UseBodyMoveDragOptions {
  containerRef: RefObject<HTMLElement | null>;
  durationGetter: () => number;
  thresholdPx?: number;
  onMoveStart?: (id: string) => void;
  onMove: (id: string, newStart: number, newEnd: number) => void;
  onMoveEnd?: (id: string) => void;
}

export interface BodyMoveDragHandle {
  /** Wire to the band's onPointerDown. `itemStart`/`itemEnd` are the item's
   *  current times in seconds. */
  startBodyMove: (id: string, itemStart: number, itemEnd: number, e: PressEvent) => void;
  /** True when the most recent press crossed the drag threshold. Read
   *  inside the click handler to skip the click action. */
  wasDraggedRef: RefObject<boolean>;
}

export function useBodyMoveDrag({
  containerRef,
  durationGetter,
  thresholdPx = 3,
  onMoveStart,
  onMove,
  onMoveEnd,
}: UseBodyMoveDragOptions): BodyMoveDragHandle {
  const wasDraggedRef = useRef(false);

  const startBodyMove = useCallback((id: string, itemStart: number, itemEnd: number, e: PressEvent) => {
    if (isSecondaryPointer(e)) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dur = durationGetter();
    if (dur <= 0) return;
    const itemDur = itemEnd - itemStart;
    if (itemDur <= 0) return;

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const clickTimeInContainer = ((startClientX - rect.left) / rect.width) * dur;
    const clickOffsetSec = clickTimeInContainer - itemStart;
    wasDraggedRef.current = false;
    let moved = false;
    const pointerId = pointerIdOf(e);

    const onDocMove = (ev: PointerEvent) => {
      if (!isSamePointer(pointerId, ev)) return;
      const dx = Math.abs(ev.clientX - startClientX);
      const dy = Math.abs(ev.clientY - startClientY);
      if (!moved && (dx > thresholdPx || dy > thresholdPx)) {
        moved = true;
        wasDraggedRef.current = true;
        onMoveStart?.(id);
      }
      if (moved) {
        const tNow = ((ev.clientX - rect.left) / rect.width) * dur;
        const rawStart = tNow - clickOffsetSec;
        const maxStart = Math.max(0, dur - itemDur);
        const newStart = Math.max(0, Math.min(maxStart, rawStart));
        onMove(id, newStart, newStart + itemDur);
      }
    };
    // pointercancel ends the move where it stands, like a pointerup: the
    // band has already been moving live, and onMoveEnd is what closes the
    // undo step, so skipping it would leave that step open.
    const onDocUp = (ev: PointerEvent) => {
      if (!isSamePointer(pointerId, ev)) return;
      document.removeEventListener('pointermove', onDocMove);
      document.removeEventListener('pointerup', onDocUp);
      document.removeEventListener('pointercancel', onDocUp);
      if (moved) onMoveEnd?.(id);
    };
    document.addEventListener('pointermove', onDocMove);
    document.addEventListener('pointerup', onDocUp);
    document.addEventListener('pointercancel', onDocUp);
  }, [containerRef, durationGetter, thresholdPx, onMoveStart, onMove, onMoveEnd]);

  return { startBodyMove, wasDraggedRef };
}

export function useTimelineDrag<TPayload>({
  containerRef,
  duration,
  onDrag,
  onDragStart,
  onDragEnd,
  clamp,
}: UseTimelineDragOptions<TPayload>): TimelineDragHandle<TPayload> {
  const dragRef = useRef<TPayload | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const durationRef = useRef(duration);
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const clampRef = useRef(clamp);

  durationRef.current = duration;
  onDragRef.current = onDrag;
  onDragEndRef.current = onDragEnd;
  clampRef.current = clamp;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const payload = dragRef.current;
      const container = containerRef.current;
      const dur = durationRef.current;
      if (!payload || !container || dur <= 0) return;
      if (!isSamePointer(pointerIdRef.current, e)) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const raw = ((e.clientX - rect.left) / rect.width) * dur;
      const t = clampRef.current
        ? clampRef.current(payload, raw)
        : Math.max(0, Math.min(dur, raw));
      onDragRef.current(payload, t);
    };
    // pointercancel lands here too. The marker has been moving live, so there
    // is nothing to roll back — ending the drag where it stands (and letting
    // onDragEnd close the undo step) is the only state that isn't "armed".
    const onUp = (e: PointerEvent) => {
      const payload = dragRef.current;
      if (payload && !isSamePointer(pointerIdRef.current, e)) return;
      if (payload && onDragEndRef.current) onDragEndRef.current(payload);
      dragRef.current = null;
      pointerIdRef.current = null;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [containerRef]);

  const startDrag = useCallback((payload: TPayload, e: PressEvent) => {
    if (isSecondaryPointer(e)) return;
    onDragStart?.(payload);
    dragRef.current = payload;
    pointerIdRef.current = pointerIdOf(e);
    e.preventDefault();
    e.stopPropagation();
  }, [onDragStart]);

  return { startDrag, isDraggingRef: dragRef };
}

/**
 * useRegionSelectDrag — click-to-seek / drag-to-select-a-range gesture,
 * shared by every timeline surface that lets the annotator paint a region
 * (the 3-Band waveform, the signal/MIR rows' RegionDragOverlay, the Lead
 * lane).
 *
 * The tracking lives on `document`, not on the surface, and that is the
 * whole point. When each row listened to its own mousemove/mouseup — and
 * cancelled on mouseleave — a selection was impossible to paint from the
 * very start of the song: the sticky label gutter butts right up against
 * t=0, so the tiniest overshoot to the left (or a drag that drifted a few
 * pixels above/below the row) left the surface and silently threw the
 * gesture away. With document listeners the pointer can wander anywhere;
 * times simply clamp to [0, duration], so pulling left past the start is
 * the natural way to select "from the beginning". Escape aborts, and so does
 * pointercancel: on a phone that is the browser deciding the finger was
 * scrolling the page after all (the surfaces are `touch-action: pan-y`, so a
 * vertical swipe still scrolls and a horizontal one paints), and a scroll must
 * neither commit a region nor seek.
 */
export interface UseRegionSelectDragOptions {
  /** Surface whose bounding rect defines the time axis. */
  containerRef: RefObject<HTMLElement | null>;
  /** Live duration, read per event so a late-decoding buffer isn't stale. */
  durationGetter: () => number;
  /** Maps a raw time to the previewed/committed one — beat or bar snapping. */
  transform?: (t: number) => number;
  /** Pixels of horizontal travel before the gesture counts as a drag. */
  thresholdPx?: number;
  /** Minimum committed span in seconds. 0 = any drag commits, however short
   *  (the Lead lane widens a collapsed range itself). */
  minSpanSec?: number;
  /** Fired on pointerdown — snapshot for undo, clear a stale pending pick, … */
  onDragStart?: () => void;
  /** Gesture never passed the threshold: treat as a click at the down-time. */
  onClick?: (t: number) => void;
  /** Committed range. `meta.clientX` is the gesture's horizontal midpoint,
   *  handy for anchoring a popover over what was just painted. */
  onRegion?: (t1: number, t2: number, meta: { clientX: number }) => void;
}

export interface RegionSelectDragHandle {
  /** Wire to the surface's onPointerDown. Nothing else needs wiring. */
  onPointerDown: (e: PressEvent) => void;
  /** The same handler under its old name, for a surface still wired to
   *  onMouseDown. Prefer onPointerDown — a mouse-only surface can't be
   *  painted from a touchscreen. */
  onMouseDown: (e: PressEvent) => void;
  /** Live selection in seconds while dragging, else null. Render it however
   *  the surface likes; it's already transform-applied. */
  preview: { s: number; e: number } | null;
}

export function useRegionSelectDrag(opts: UseRegionSelectDragOptions): RegionSelectDragHandle {
  const [preview, setPreview] = useState<{ s: number; e: number } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Set while a gesture is in flight so an unmount mid-drag doesn't leak the
  // document listeners.
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);

  const onPointerDown = useCallback((e: PressEvent) => {
    const o = optsRef.current;
    if (isSecondaryPointer(e)) return;
    if (!o.containerRef.current || o.durationGetter() <= 0) return;
    // Recomputed per event rather than snapshotted: the viz scrolls
    // horizontally, and a drag that pans it would otherwise map to stale x.
    const timeAt = (clientX: number) => {
      const rect = o.containerRef.current?.getBoundingClientRect();
      const dur = o.durationGetter();
      if (!rect || rect.width <= 0 || dur <= 0) return 0;
      return Math.max(0, Math.min(dur, ((clientX - rect.left) / rect.width) * dur));
    };
    const threshold = o.thresholdPx ?? 6;
    const xf = o.transform ?? ((t: number) => t);
    const startX = e.clientX;
    const startTime = timeAt(startX);
    const pointerId = pointerIdOf(e);

    teardownRef.current?.();
    o.onDragStart?.();
    preventPressDefault(e);

    const onMove = (ev: PointerEvent) => {
      if (!isSamePointer(pointerId, ev)) return;
      if (Math.abs(ev.clientX - startX) > threshold) {
        setPreview({ s: xf(startTime), e: xf(timeAt(ev.clientX)) });
      } else {
        setPreview(null);
      }
    };
    const finish = (endClientX: number | null) => {
      teardown();
      setPreview(null);
      if (endClientX === null) return; // Escape / pointercancel — abandon the gesture
      const cur = optsRef.current;
      const endTime = timeAt(endClientX);
      const lo = xf(Math.min(startTime, endTime));
      const hi = xf(Math.max(startTime, endTime));
      const minSpan = cur.minSpanSec ?? 0.1;
      if (Math.abs(endClientX - startX) > threshold && (minSpan <= 0 || hi - lo > minSpan)) {
        cur.onRegion?.(lo, hi, { clientX: (startX + endClientX) / 2 });
      } else {
        cur.onClick?.(startTime);
      }
    };
    const onUp = (ev: PointerEvent) => { if (isSamePointer(pointerId, ev)) finish(ev.clientX); };
    const onCancel = (ev: PointerEvent) => { if (isSamePointer(pointerId, ev)) finish(null); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(null); };
    const teardown = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
      teardownRef.current = null;
    };
    teardownRef.current = teardown;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  }, []);

  return { onPointerDown, onMouseDown: onPointerDown, preview };
}
