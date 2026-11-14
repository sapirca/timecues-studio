import { StrictMode } from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoableState } from './useUndoableState';

/** Rendered inside StrictMode, the way the app mounts it (main.tsx), because
 *  that is where an impure updater shows up: React invokes updaters twice,
 *  so history bookkeeping done inside one would stack two entries per edit. */
const render = <T,>(initial: T) =>
  renderHook(() => useUndoableState<T>(initial), { wrapper: StrictMode });

describe('useUndoableState', () => {
  it('undoes one edit per edit under StrictMode', () => {
    const { result } = render(0);
    act(() => result.current[1](1));
    act(() => result.current[1](2));
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);

    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(2);
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(1);
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(0);
    expect(result.current[2].canUndo).toBe(false);
  });

  it('redoes back up the stack', () => {
    const { result } = render('a');
    act(() => result.current[1]('b'));
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe('a');
    expect(result.current[2].canRedo).toBe(true);
    act(() => result.current[2].redo());
    expect(result.current[0]).toBe('b');
    expect(result.current[2].canRedo).toBe(false);
  });

  it('collapses a run sharing one coalesceKey into a single step', () => {
    const { result } = render(0);
    act(() => result.current[1](1, { coalesceKey: 'drag' }));
    act(() => result.current[1](2, { coalesceKey: 'drag' }));
    act(() => result.current[1](3, { coalesceKey: 'drag' }));
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(0);
    expect(result.current[2].canUndo).toBe(false);
  });

  it('starts a new step when the coalesceKey changes', () => {
    const { result } = render(0);
    act(() => result.current[1](1, { coalesceKey: 'a' }));
    act(() => result.current[1](2, { coalesceKey: 'b' }));
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(1);
  });

  it('leaves no trace of a skipHistory write', () => {
    const { result } = render(0);
    act(() => result.current[1](1));
    act(() => result.current[1](2, { skipHistory: true }));
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(0);
    expect(result.current[2].canUndo).toBe(false);
  });

  it('sees the latest value in a functional update issued in the same tick', () => {
    const { result } = render(0);
    act(() => {
      result.current[1]((n) => n + 1);
      result.current[1]((n) => n + 1);
    });
    expect(result.current[0]).toBe(2);
    act(() => result.current[2].undo());
    expect(result.current[0]).toBe(1);
  });

  it('drops the redo stack once a new edit forks the timeline', () => {
    const { result } = render(0);
    act(() => result.current[1](1));
    act(() => result.current[2].undo());
    act(() => result.current[1](9));
    expect(result.current[2].canRedo).toBe(false);
  });

  it('clears both stacks on reset', () => {
    const { result } = render(0);
    act(() => result.current[1](1));
    act(() => result.current[2].reset(42));
    expect(result.current[0]).toBe(42);
    expect(result.current[2].canUndo).toBe(false);
    expect(result.current[2].canRedo).toBe(false);
  });

  it('scrub erases a dropped draft from the present and the history alike', () => {
    // Items as strings; the draft is 'D'. Base edit, add the draft, edit the
    // draft twice, then drop it: undo must go straight to before the base
    // edit, never resurrect the draft or spend presses on draft-only edits.
    const { result } = render<string[]>([]);
    act(() => result.current[1](['a']));
    act(() => result.current[1](['a', 'D']));
    act(() => result.current[1](['a', 'D', 'D-label']));
    const drop = (v: string[]) => (v.some((x) => x.startsWith('D')) ? v.filter((x) => !x.startsWith('D')) : v);
    act(() => result.current[2].scrub(drop, (a, b) => JSON.stringify(a) === JSON.stringify(b)));
    expect(result.current[0]).toEqual(['a']);
    act(() => result.current[2].undo());
    expect(result.current[0]).toEqual([]);
    expect(result.current[2].canUndo).toBe(false);
  });
});
