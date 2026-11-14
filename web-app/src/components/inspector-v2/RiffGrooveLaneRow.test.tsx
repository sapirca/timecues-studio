/**
 * The riff row's playhead. Every other lane on the canvas (Cue, Span, Loop,
 * Lead) draws the same white hairline at the cursor, and a riff row without
 * one is the place where "which repeat am I hearing?" has no answer.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { PlayheadClockContext, createPlayheadClock } from '../../hooks/usePlayhead';
import { RiffGrooveLaneRow } from './RiffGrooveLaneRow';
import {
  newRiffNode, newRiffPatternItem, newRiffPatternLayer, newRiffSeqEntry, type RiffNode, type RiffPatternItem,
} from '../../types/annotationLayer';

function layerWith(items: RiffPatternItem[] = []) {
  return { ...newRiffPatternLayer('Riffs', '#38bdf8'), items };
}

/** The hairline is the only full-height, zero-width, non-interactive child. */
function cursor(): HTMLElement | null {
  return document.querySelector('.absolute.top-0.bottom-0.w-px.pointer-events-none');
}

/** Where the hairline sits, as a share of the row. jsdom has no layout, so
 *  every box is given a 400 px width to measure against. */
function cursorAt(): number {
  const m = /translate3d\(([-\d.]+)px/.exec(cursor()?.style.transform ?? '');
  return m ? Number(m[1]) / 400 : NaN;
}

/** The row under a playhead clock standing at `time`. */
function atPlayhead(time: number, duration: number) {
  const clock = createPlayheadClock(time);
  const view = render(
    <PlayheadClockContext.Provider value={clock}>
      <RiffGrooveLaneRow layer={layerWith()} duration={duration} />
    </PlayheadClockContext.Provider>,
  );
  return { clock, view };
}

describe('RiffGrooveLaneRow playhead', () => {
  beforeEach(() => { vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws the cursor at the playhead as a fraction of the track', () => {
    atPlayhead(50, 200);
    expect(cursorAt()).toBe(0.25);
  });

  it('follows the clock without the row being rendered again', () => {
    const { clock } = atPlayhead(0, 200);
    act(() => clock.set(100));
    expect(cursorAt()).toBe(0.5);
  });

  it('sits at the left edge before playback starts, and with no clock given', () => {
    const { view } = atPlayhead(0, 200);
    expect(cursorAt()).toBe(0);
    view.unmount();
    render(<RiffGrooveLaneRow layer={layerWith()} duration={200} />);
    expect(cursorAt()).toBe(0);
  });

  it('never runs past the row when the clock overshoots a stale duration', () => {
    atPlayhead(99, 10);
    expect(cursorAt()).toBe(1);
  });

  it('stays put — at the left edge — while the duration is still unknown', () => {
    atPlayhead(12, 0);
    expect(cursorAt()).toBe(0);
  });
});

/**
 * Lane packing decides the row's HEIGHT, and it does so for the whole lane at
 * once: one pair of instances the packer thinks overlap adds a lane to every
 * row in the song. A run of bars is stored as `start + cycle x repeats` with
 * `cycle` rounded to whole milliseconds, so consecutive runs routinely end a
 * millisecond past where the next one begins — on a real 124 BPM track that
 * turned a three-row drum groove into a six-lane row with half of it empty.
 */

/** The row's own element is the one carrying an explicit pixel height. */
function rowHeight(container: HTMLElement): number {
  // The row's floor: a sideways lane title may stretch it taller, but the
  // lanes it packs are what set the minimum.
  const el = container.querySelector('[style*="min-height"]') as HTMLElement;
  return parseFloat(el.style.minHeight);
}

function at(start: number, end: number, repeats = 1): RiffPatternItem {
  return { ...newRiffPatternItem(start, end, 'n'), repeatCount: repeats };
}

describe('RiffGrooveLaneRow lane packing', () => {
  it('keeps runs that touch in one lane, despite millisecond rounding', () => {
    // 32.020 + 1.934 x 5 = 41.690, and the next run's own measured start is
    // 41.690 — arrived at by a different sum, so it lands a hair earlier.
    const { container } = render(
      <RiffGrooveLaneRow layer={layerWith([at(32.02, 33.954, 5), at(41.6899, 43.62, 2)])} duration={200} />,
    );
    const stacked = render(
      <RiffGrooveLaneRow layer={layerWith([at(32.02, 33.954, 5)])} duration={200} />,
    );
    expect(rowHeight(container)).toBe(rowHeight(stacked.container));
  });

  it('still stacks instances that genuinely overlap', () => {
    // Three instances that start together overlap for their whole length,
    // and must not be drawn over one another.
    const { container } = render(
      <RiffGrooveLaneRow layer={layerWith([at(0, 2), at(0, 2), at(0, 2)])} duration={200} />,
    );
    const single = render(<RiffGrooveLaneRow layer={layerWith([at(0, 2)])} duration={200} />);
    expect(rowHeight(container)).toBeGreaterThan(rowHeight(single.container));
  });

  it('does not merge instances a person placed a step apart', () => {
    // The tolerance is 20 ms; a 16th note is 75 ms even at 200 BPM, so an
    // overlap a person can create by dragging must still open a lane.
    const { container } = render(
      <RiffGrooveLaneRow layer={layerWith([at(0, 2), at(1.9, 3.9)])} duration={200} />,
    );
    const single = render(<RiffGrooveLaneRow layer={layerWith([at(0, 2)])} duration={200} />);
    expect(rowHeight(container)).toBeGreaterThan(rowHeight(single.container));
  });
});

/**
 * A run the lane letters as one — A ×3, A³, A — is three instances on disk.
 * Dragging any bar of it has to carry all three: moving only the instance
 * under the pointer tore the run apart, its first part sliding off and the
 * rest left behind.
 */
describe('RiffGrooveLaneRow drag', () => {
  // 400 px over a 200 s song: 2 px a second.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const A: RiffNode = newRiffNode('A', '#f59e0b', 4);
  const play = (start: number, n: RiffNode, reps = 1): RiffPatternItem =>
    ({ ...newRiffPatternItem(start, start + 2, ''), sequence: [newRiffSeqEntry(n.id, 16)], repeatCount: reps });
  // The middle instance plays A with a fill: still A, so still the run.
  const run = [play(0, A, 3), { ...play(6, A), occurrences: [{ index: 0, event: 'fill' as const, added: [{ start: 2, end: 2.25 }] }] }, play(8, A)];
  const apart = play(50, A);
  const riffs = { ...newRiffPatternLayer('Hat', '#38bdf8'), nodes: [A], items: [...run, apart] };

  function drag(cellIndex: number, fromX: number, toX: number) {
    const onItemsMove = vi.fn();
    const { container } = render(<RiffGrooveLaneRow layer={riffs} duration={200} onItemsMove={onItemsMove} />);
    const cells = container.querySelectorAll('[title*="drag to move it"]');
    fireEvent.pointerDown(cells[cellIndex], { isPrimary: true, clientX: fromX, clientY: 10 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: toX, clientY: 10 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: toX, clientY: 10 });
    return onItemsMove.mock.calls.at(-1)?.[0] as { id: string; start: number; end: number }[];
  }

  it('moves every instance of the run by the same amount, and nothing outside it', () => {
    const moves = drag(0, 2, 22);   // +10 s
    expect(moves.map((m) => [m.id, m.start, m.end])).toEqual(run.map((it) => [it.id, it.start + 10, it.end + 10]));
  });

  it('carries the whole run from a bar in its middle, too', () => {
    const moves = drag(4, 18, 38);  // the last A, +10 s
    expect(moves.map((m) => m.id)).toEqual(run.map((it) => it.id));
    expect(moves[0].start).toBe(10);
  });

  it('stops at the song\'s end with the whole run, not its first instance, inside it', () => {
    const moves = drag(0, 2, 1000);
    // The run is 10 s long, so its first start can go no later than 190 s.
    expect(moves[0].start).toBe(190);
    expect(moves.at(-1)!.end).toBe(200);
  });
});

/**
 * A phrase — several nodes in order, played as one instance — is bracketed
 * over its bars and named, so "I F I F K G" reads as one thing and the second
 * time it comes round says where the first was.
 */
describe('RiffGrooveLaneRow phrases', () => {
  const I: RiffNode = newRiffNode('I', '#f472b6', 4);
  const F: RiffNode = newRiffNode('F', '#2dd4bf', 4);
  const phrase = (start: number, reps = 1): RiffPatternItem => ({
    ...newRiffPatternItem(start, start + 4, 'I F'),
    sequence: [newRiffSeqEntry(I.id, 16), newRiffSeqEntry(F.id, 16)],
    repeatCount: reps,
  });
  const spans = () => [...document.querySelectorAll<HTMLElement>('[data-lane-span]')];

  beforeEach(() => { vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('brackets each several-node instance over all its repeats, and says where it came before', () => {
    const layer = { ...layerWith([phrase(0, 2), phrase(20, 2)]), nodes: [I, F] };
    render(<RiffGrooveLaneRow layer={layer} duration={40} />);
    const [first, again] = spans();
    expect(spans()).toHaveLength(2);
    expect(first.style.left).toBe('0%');
    expect(first.style.width).toBe('20%');
    expect(first.title).toBe('One instance: I F ×2');
    expect(again.title).toBe('One instance: I F ×2, the same as the one at 0:00');
  });

  it('leaves a one-node instance to its run label', () => {
    const one = { ...newRiffPatternItem(0, 2, 'I'), sequence: [newRiffSeqEntry(I.id, 16)], repeatCount: 3 };
    render(<RiffGrooveLaneRow layer={{ ...layerWith([one]), nodes: [I] }} duration={40} />);
    expect(spans()).toHaveLength(0);
  });
});
