/** Tap Along's capture rule: the press and the release ARE the note, so every
 *  hold keeps its own release however short — nothing is rounded to a step
 *  and no length is invented for the user. */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';
import { TapRefineControls, useBoundaryTapRefine, useTapAlong } from './BeatChipControls';

/** 32 steps at 4 subbeats/beat = an 8-beat node; a step is a quarter beat. */
const NODE = { stepsPerCycle: 32, subbeatsPerBeat: 4 };

/** Starts a session and runs the 3-2-1 count-in out, so taps are armed. */
function startSession() {
  const saved: { taps: unknown[]; numBeats: number }[] = [];
  const view = renderHook(
    ({ playheadStep }: { playheadStep: number | null }) => useTapAlong({
      ...NODE,
      playheadStep,
      onSaveTaps: (taps, numBeats) => { saved.push({ taps, numBeats }); },
    }),
    { initialProps: { playheadStep: 0 as number | null } },
  );
  act(() => { view.result.current.start(); });
  act(() => { vi.advanceTimersByTime(3000); });
  return { view, saved };
}

/** Presses Space at `fromStep` and releases it at `toStep`. */
function press(view: ReturnType<typeof startSession>['view'], fromStep: number, toStep: number | null) {
  view.rerender({ playheadStep: fromStep });
  act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); });
  view.rerender({ playheadStep: toStep });
  act(() => { document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true })); });
}

afterEach(() => { vi.useRealTimers(); });

describe('useTapAlong — press and release', () => {
  it('keeps every press-to-release, however short', () => {
    vi.useFakeTimers();
    const { view } = startSession();
    // A hold across two steps, and one that never leaves its own step — both
    // come back with the exact release, in beats.
    press(view, 4, 5);
    press(view, 8, 8.2);
    expect(view.result.current.tapEvents.map((t) => [t.beat, t.endBeat])).toEqual([
      [1, 1.25],
      [2, 2.05],
    ]);
  });

  it('closes a press at the node end when the release cannot be read', () => {
    vi.useFakeTimers();
    const { view } = startSession();
    // The loop wrapped while the key was down (the playhead is back near 0),
    // and then a release taken while the node isn't sounding at all. Either
    // way the key was still down when the node ended.
    press(view, 28, 1);
    press(view, 20, null);
    expect(view.result.current.tapEvents.map((t) => [t.beat, t.endBeat])).toEqual([
      [7, 8],
      [5, 8],
    ]);
  });
});

describe('TapRefineControls', () => {
  /** The two dials, wired to the hook that owns them, as a popover does. */
  function Harness({ passes }: { passes: number }) {
    const refine = useBoundaryTapRefine();
    return (
      <>
        <TapRefineControls {...refine} passes={passes} />
        <output>{`${refine.clusterBeats} / ${refine.minPasses}`}</output>
      </>
    );
  }

  it('offers a vote no larger than the take has passes', () => {
    render(<Harness passes={3} />);
    const keep = screen.getByLabelText(/Keep hits tapped in at least/) as HTMLSelectElement;
    expect([...keep.options].map((o) => o.textContent)).toEqual(['any pass', '2 passes', '3 passes']);
  });

  it('starts at the long-standing defaults and reports every change', () => {
    render(<Harness passes={4} />);
    // A session nobody touches behaves exactly as it did before the dials.
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('0.25 / 1');
    fireEvent.change(screen.getByLabelText(/Fold taps within/), { target: { value: '0.125' } });
    fireEvent.change(screen.getByLabelText(/Keep hits tapped in at least/), { target: { value: '3' } });
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('0.125 / 3');
  });

  it('disables the vote when nothing is being folded — there are no groups to count', () => {
    render(<Harness passes={4} />);
    fireEvent.change(screen.getByLabelText(/Fold taps within/), { target: { value: '0' } });
    expect((screen.getByLabelText(/Keep hits tapped in at least/) as HTMLSelectElement).disabled).toBe(true);
  });
});
