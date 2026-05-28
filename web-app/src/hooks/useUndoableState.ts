import { useState, useRef, useCallback } from 'react';

const MAX_HISTORY = 50;

export type SetUndoableOptions = {
  /** Don't snapshot the prior value to history (e.g. server load, status toggles). */
  skipHistory?: boolean;
  /**
   * If two consecutive setValue calls share the same coalesceKey, the second
   * call updates the value but does NOT push a new history entry. Use for
   * keystroke-streaming inputs (label typing) or drag mousemoves so a whole
   * gesture undoes as one operation.
   */
  coalesceKey?: string;
};

export type SetUndoableState<T> = (
  next: T | ((prev: T) => T),
  opts?: SetUndoableOptions,
) => void;

export interface UndoControls<T> {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Replace value AND clear history (use on context switches like song change). */
  reset: (next: T) => void;
}

export function useUndoableState<T>(
  initial: T,
): [T, SetUndoableState<T>, UndoControls<T>] {
  const [value, setValueState] = useState<T>(initial);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const historyRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const lastKeyRef = useRef<string | null>(null);

  const setValue = useCallback<SetUndoableState<T>>((next, opts) => {
    setValueState((prev) => {
      const computed = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      if (Object.is(prev, computed)) return prev;

      if (!opts?.skipHistory) {
        const key = opts?.coalesceKey ?? null;
        const shouldCoalesce = key !== null && key === lastKeyRef.current;
        if (!shouldCoalesce) {
          const h = historyRef.current;
          if (h.length >= MAX_HISTORY) h.shift();
          h.push(prev);
          setCanUndo(true);
        }
        lastKeyRef.current = key;
        // Any new edit forks the timeline — drop the redo stack.
        if (futureRef.current.length > 0) {
          futureRef.current = [];
          setCanRedo(false);
        }
      }

      return computed;
    });
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const prior = h.pop()!;
    lastKeyRef.current = null;
    setValueState((cur) => {
      const f = futureRef.current;
      if (f.length >= MAX_HISTORY) f.shift();
      f.push(cur);
      setCanRedo(true);
      return prior;
    });
    setCanUndo(h.length > 0);
  }, []);

  const redo = useCallback(() => {
    const f = futureRef.current;
    if (f.length === 0) return;
    const nextVal = f.pop()!;
    lastKeyRef.current = null;
    setValueState((cur) => {
      const h = historyRef.current;
      if (h.length >= MAX_HISTORY) h.shift();
      h.push(cur);
      setCanUndo(true);
      return nextVal;
    });
    setCanRedo(f.length > 0);
  }, []);

  const reset = useCallback((next: T) => {
    historyRef.current = [];
    futureRef.current = [];
    lastKeyRef.current = null;
    setValueState(next);
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  return [value, setValue, { undo, redo, canUndo, canRedo, reset }];
}
