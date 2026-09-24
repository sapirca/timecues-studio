/**
 * Two-axis drag for prominence breakpoints.
 *
 * Deliberately NOT built on useTimelineDrag: that hook is horizontal-only and
 * reports a single `t`, whereas a breakpoint handle moves in x (time) AND y
 * (which of the four level rows it snaps to). Same document-listener shape,
 * the same pointer handling (pointer events so a finger can drag a handle,
 * pointercancel ends the drag, a second finger is ignored) and the same
 * `clamp` escape hatch, so the two read alike.
 *
 * x is measured against the timeline container (shared with every other lane
 * drag, so time maps identically); y against the four-row editor strip, whose
 * geometry is captured at pointerdown since it can't change mid-drag.
 */

import { useCallback, useEffect, useRef } from 'react';
import { isSamePointer, isSecondaryPointer, pointerIdOf, type PressEvent } from './useTimelineDrag';

export interface UseProminenceDragOptions<TPayload> {
  /** Timeline container — the same element the lane's other drags measure x against. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The four-row editor strip — supplies the y → level-row mapping. */
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** Track duration in seconds. */
  duration: number;
  /** How many level rows the strip is divided into. */
  rows: number;
  /** Fires on every pointermove with the new track-seconds time and row index. */
  onDrag: (payload: TPayload, timeSeconds: number, rowIndex: number) => void;
  onDragStart?: (payload: TPayload) => void;
  onDragEnd?: (payload: TPayload) => void;
  /** Constrain the raw time — used to keep breakpoints inside the item and
   *  ordered relative to their neighbours. */
  clamp?: (payload: TPayload, rawSeconds: number) => number;
}

export interface ProminenceDragHandle<TPayload> {
  startDrag: (payload: TPayload, e: PressEvent) => void;
  isDraggingRef: React.MutableRefObject<TPayload | null>;
}

export function useProminenceDrag<TPayload>({
  containerRef,
  stripRef,
  duration,
  rows,
  onDrag,
  onDragStart,
  onDragEnd,
  clamp,
}: UseProminenceDragOptions<TPayload>): ProminenceDragHandle<TPayload> {
  const dragRef = useRef<TPayload | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const stripRectRef = useRef<DOMRect | null>(null);
  const durationRef = useRef(duration);
  const rowsRef = useRef(rows);
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const clampRef = useRef(clamp);

  durationRef.current = duration;
  rowsRef.current = rows;
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

      // y → row. Falls back to row 0 if the strip vanished mid-drag (the
      // popover closing under the cursor), which keeps time-only dragging
      // working rather than throwing.
      const strip = stripRectRef.current;
      const n = Math.max(1, rowsRef.current);
      let row = 0;
      if (strip && strip.height > 0) {
        row = Math.floor(((e.clientY - strip.top) / strip.height) * n);
        row = Math.max(0, Math.min(n - 1, row));
      }
      onDragRef.current(payload, t, row);
    };
    // pointercancel ends the drag where it stands, exactly like pointerup:
    // the breakpoint has been moving live, so there is nothing to roll back.
    const onUp = (e: PointerEvent) => {
      const payload = dragRef.current;
      if (payload && !isSamePointer(pointerIdRef.current, e)) return;
      if (payload && onDragEndRef.current) onDragEndRef.current(payload);
      dragRef.current = null;
      pointerIdRef.current = null;
      stripRectRef.current = null;
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
    stripRectRef.current = stripRef.current?.getBoundingClientRect() ?? null;
    e.preventDefault();
    e.stopPropagation();
  }, [onDragStart, stripRef]);

  return { startDrag, isDraggingRef: dragRef };
}
