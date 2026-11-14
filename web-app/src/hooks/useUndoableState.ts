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
  /** Rewrite the present AND every past/future snapshot through `fn`, as if
   *  what it removes had never been there — for a draft that was never kept
   *  (a lane-created item whose card closed without Done). Snapshots that
   *  `same` finds equal to their successor collapse, so ⌘Z doesn't spend a
   *  press on an edit that only ever touched the draft. Leaves the coalesce
   *  key and the redo stack's existence alone. */
  scrub: (fn: (v: T) => T, same: (a: T, b: T) => boolean) => void;
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
  // The current value, readable synchronously. Pushing history is a side
  // effect, so it must NOT live inside a setState updater: React invokes
  // updaters twice under StrictMode (and may replay them), which would stack
  // two identical entries per edit and make every other ⌘Z a no-op. Keeping
  // the value here lets every mutator compute its next state, do its
  // bookkeeping once, and hand React a plain value.
  const valueRef = useRef<T>(initial);

  const commit = useCallback((nextValue: T) => {
    valueRef.current = nextValue;
    setValueState(nextValue);
  }, []);

  const setValue = useCallback<SetUndoableState<T>>((next, opts) => {
    const prev = valueRef.current;
    const computed = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
    if (Object.is(prev, computed)) return;

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

    commit(computed);
  }, [commit]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const prior = h.pop()!;
    lastKeyRef.current = null;
    const f = futureRef.current;
    if (f.length >= MAX_HISTORY) f.shift();
    f.push(valueRef.current);
    setCanRedo(true);
    setCanUndo(h.length > 0);
    commit(prior);
  }, [commit]);

  const redo = useCallback(() => {
    const f = futureRef.current;
    if (f.length === 0) return;
    const nextVal = f.pop()!;
    lastKeyRef.current = null;
    const h = historyRef.current;
    if (h.length >= MAX_HISTORY) h.shift();
    h.push(valueRef.current);
    setCanUndo(true);
    setCanRedo(f.length > 0);
    commit(nextVal);
  }, [commit]);

  const reset = useCallback((next: T) => {
    historyRef.current = [];
    futureRef.current = [];
    lastKeyRef.current = null;
    setCanUndo(false);
    setCanRedo(false);
    commit(next);
  }, [commit]);

  const scrub = useCallback((fn: (v: T) => T, same: (a: T, b: T) => boolean) => {
    const present = fn(valueRef.current);
    // Walk back from the present: keep a snapshot only when it differs from
    // the one after it.
    const history: T[] = [];
    let after = present;
    for (const v of historyRef.current.map(fn).reverse()) {
      if (!same(v, after)) { history.unshift(v); after = v; }
    }
    const future: T[] = [];
    let before = present;
    for (const v of futureRef.current.map(fn).reverse()) {
      if (!same(v, before)) { future.unshift(v); before = v; }
    }
    historyRef.current = history;
    futureRef.current = future;
    setCanUndo(history.length > 0);
    setCanRedo(future.length > 0);
    commit(present);
  }, [commit]);

  return [value, setValue, { undo, redo, canUndo, canRedo, reset, scrub }];
}
