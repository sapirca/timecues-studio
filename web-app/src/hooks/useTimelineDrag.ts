/**
 * useTimelineDrag — shared mouse-drag-to-reposition machinery for every
 * annotation marker on the visualization canvas.
 *
 * Boundary handles, cue/anchor points, loop/span/pattern edges all
 * share the same physics: grab the marker, document-level mousemove maps
 * x-pixels → song-time within the row's container rect, mouseup ends.
 * The payload is generic so callers can encode whatever target identity
 * they need (an itemId, a {layerId,itemId,edge} tuple, an anchor index…).
 *
 * Refs are updated synchronously in the render body — not via useEffect —
 * so the latest duration / callback values are visible to the mousemove
 * handler on the very next render. useEffect sync would lag by one commit,
 * which leaves duration stale at 0 on the first drag attempt after the
 * audio finishes decoding.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** Minimum gap between start/end while edge-dragging an interval (seconds). */
export const EDGE_DRAG_MIN_MARGIN_SEC = 0.05;

/**
 * Build the clamp function for interval edge-dragging used by every
 * start/end-bounded annotation lane (Loops, Spans, Patterns). Keeps the
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
   *  it through a ref so document mousemove sees the freshest number. */
  duration: number;
  /** Called continuously while dragging. Receives the payload supplied to
   *  startDrag plus the new time (already clamped if a clamp fn was given). */
  onDrag: (payload: TPayload, time: number) => void;
  /** Called once when the drag begins. Use this to snapshot for undo. */
  onDragStart?: (payload: TPayload) => void;
  /** Called once when the drag ends (mouseup). */
  onDragEnd?: (payload: TPayload) => void;
  /** Optional per-drag clamp. Default clamps to [0, duration]. */
  clamp?: (payload: TPayload, rawTime: number) => number;
}

export interface TimelineDragHandle<TPayload> {
  /** Wire this to a marker's onMouseDown. Auto-stops propagation and
   *  prevents default so the host row's click/seek logic doesn't fire. */
  startDrag: (payload: TPayload, e: React.MouseEvent) => void;
  /** True while a drag is in flight — useful for hover suppression. */
  isDraggingRef: RefObject<TPayload | null>;
}

/**
 * useBodyMoveDrag — drag-or-click helper for band/tile bodies.
 *
 * Differs from useTimelineDrag in two ways:
 *  • Doesn't preventDefault on mousedown, so the underlying click still fires
 *    when the user just taps (needed because clicking a band opens its edit
 *    popover).
 *  • Only commits to a "move" past a small pixel threshold; below threshold
 *    the gesture is treated as a click and `wasDraggedRef` stays false.
 *
 * Returns `wasDraggedRef` so the click handler can check it and skip the
 * click action when the mousedown was actually a drag (mouseup → click are
 * synchronous, so the flag set during the drag is still visible to the
 * click handler).
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
  /** Wire to the band's onMouseDown. `itemStart`/`itemEnd` are the item's
   *  current times in seconds. */
  startBodyMove: (id: string, itemStart: number, itemEnd: number, e: React.MouseEvent) => void;
  /** True when the most recent mousedown crossed the drag threshold. Read
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

  const startBodyMove = useCallback((id: string, itemStart: number, itemEnd: number, e: React.MouseEvent) => {
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

    const onDocMove = (ev: MouseEvent) => {
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
    const onDocUp = () => {
      document.removeEventListener('mousemove', onDocMove);
      document.removeEventListener('mouseup', onDocUp);
      if (moved) onMoveEnd?.(id);
    };
    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);
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
  const durationRef = useRef(duration);
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const clampRef = useRef(clamp);

  durationRef.current = duration;
  onDragRef.current = onDrag;
  onDragEndRef.current = onDragEnd;
  clampRef.current = clamp;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const payload = dragRef.current;
      const container = containerRef.current;
      const dur = durationRef.current;
      if (!payload || !container || dur <= 0) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const raw = ((e.clientX - rect.left) / rect.width) * dur;
      const t = clampRef.current
        ? clampRef.current(payload, raw)
        : Math.max(0, Math.min(dur, raw));
      onDragRef.current(payload, t);
    };
    const onUp = () => {
      const payload = dragRef.current;
      if (payload && onDragEndRef.current) onDragEndRef.current(payload);
      dragRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [containerRef]);

  const startDrag = useCallback((payload: TPayload, e: React.MouseEvent) => {
    onDragStart?.(payload);
    dragRef.current = payload;
    e.preventDefault();
    e.stopPropagation();
  }, [onDragStart]);

  return { startDrag, isDraggingRef: dragRef };
}
