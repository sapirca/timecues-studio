/**
 * The groove lane draws bars, not tiles: one cell per bar, a fill and a
 * drop-out visibly different from the groove, the bar's hits only once it is
 * wide enough to show them, and the groove itself in the card a cell opens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { PlayheadClockContext, createPlayheadClock } from '../../hooks/usePlayhead';
import { GrooveLaneRow } from './GrooveLaneRow';
import { riffGrooveLane } from './riffGrooves';
import type { GrooveLaneModel } from './drumGrooves';
import {
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  type RiffNode,
  type RiffOccurrence,
  type RiffPatternItem,
} from '../../types/annotationLayer';

// jsdom has no ResizeObserver; the lane measures its width once without it,
// but the card's popover hook needs one to exist.
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function mockLaneWidth(width: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: 36,
    width, height: 36, toJSON: () => ({}),
  } as DOMRect);
}

const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

/** A node of one-16th hits at `steps`, `beats` long (a bar is 4). */
function node(name: string, steps: number[], accent?: number, extra: Partial<RiffNode> = {}, beats = 4): RiffNode {
  return {
    ...newRiffNode(name, '#f59e0b', beats),
    segments: steps.map((st) => ({
      start: st / 4, end: (st + 1) / 4, kind: 'tick' as const, ...(accent != null ? { accent } : {}),
    })),
    ...extra,
  };
}

/** `reps` plays of `n` from 0 s; a bar is 2 s at 120 BPM. */
function item(n: RiffNode, reps: number, occurrences?: RiffOccurrence[]): RiffPatternItem {
  return {
    ...newRiffPatternItem(0, n.stepsPerCycle / 8, n.name),
    sequence: [newRiffSeqEntry(n.id, n.stepsPerCycle)],
    repeatCount: reps,
    ...(occurrences ? { occurrences } : {}),
  };
}

function laneOf(drum: string, n: RiffNode, it: RiffPatternItem): GrooveLaneModel {
  return riffGrooveLane({ ...newRiffPatternLayer('Groove', '#f59e0b'), drum, nodes: [n], items: [it] }, GRID).model;
}

// Groove A on the kick, three bars: as written, a fill (one kick added on the
// third 16th), a drop-out (every kick left out).
const A = node('A', [0, 4, 8, 12], 120, { names: ['four on the floor'] });
const FILL: RiffOccurrence = { index: 1, event: 'fill', added: [{ start: 0.5, end: 0.75 }] };
const DROP: RiffOccurrence = { index: 2, event: 'drop', missing: [0, 1, 2, 3].map((start) => ({ start })) };
const MODEL = laneOf('kick', A, item(A, 3, [FILL, DROP]));

function renderLane(visualize = false, clock = createPlayheadClock(0)) {
  return render(
    <PlayheadClockContext.Provider value={clock}>
      <GrooveLaneRow laneId="g" model={MODEL} duration={6} visualize={visualize} />
    </PlayheadClockContext.Provider>,
  );
}

const cells = () => [...document.querySelectorAll<HTMLElement>('[title^="Bar "]')];

describe('GrooveLaneRow', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('draws one cell per bar, each saying what it is', () => {
    mockLaneWidth(60);
    renderLane();
    expect(cells().map((c) => c.title.split(' · ').slice(0, 3).join(' · '))).toEqual([
      'Bar 1 · A · as the groove',
      'Bar 2 · A · fill (+1 kick)',
      'Bar 3 · A · drop-out (−4 kick)',
    ]);
  });

  it('shows a run once, lettered with its length, and draws its exact repeats as strong as the first', () => {
    // Bars 1, 2, 4 and 5 play A as written, bar 3 is a fill.
    const run = laneOf('kick', A, item(A, 5, [{ ...FILL, index: 2 }]));
    mockLaneWidth(200); // 40 px a bar: room for "A ×5", too narrow for the hits
    render(
      <PlayheadClockContext.Provider value={createPlayheadClock(0)}>
        <GrooveLaneRow laneId="g" model={run} duration={10} />
      </PlayheadClockContext.Provider>,
    );
    const [first, again, fill, after, later] = cells();
    const labels = [...document.querySelectorAll('[data-run-label]')].map((l) => l.textContent);
    expect(labels).toEqual(['A ×5']);
    expect(first.textContent).toBe('');
    expect(again.textContent).toBe('');
    // One pattern, one colour, one strength: every exact play of A is drawn
    // alike, with a rule at the start of each; the fill strays and is lighter.
    const alpha = (c: HTMLElement) => c.style.backgroundColor;
    expect(alpha(again)).toBe(alpha(first));
    expect(alpha(after)).toBe(alpha(first));
    expect(alpha(later)).toBe(alpha(first));
    expect(alpha(fill)).not.toBe(alpha(first));
    for (const c of [again, after, later]) expect(c.style.boxShadow).toContain('inset 1px 0 0');
  });

  it('letters a run whose bars are each too narrow to hold it', () => {
    mockLaneWidth(24); // 8 px a bar, 24 px the run
    renderLane();
    expect([...document.querySelectorAll('[data-run-label]')].map((l) => l.textContent)).toEqual(['A']);
  });

  it('marks a fill and a drop-out on the cell itself', () => {
    mockLaneWidth(60);
    renderLane();
    const [exact, fill, drop] = cells();
    expect(exact.style.boxShadow).not.toContain('#fde68a');
    expect(fill.style.boxShadow).toContain('inset 0 3px 0 #fde68a');
    expect(drop.style.backgroundImage).toContain('repeating-linear-gradient');
  });

  it('draws a bar\'s hits only when the bar is wide enough to show them', () => {
    mockLaneWidth(60);             // 20 px a bar: too narrow for 16 steps
    const { unmount } = renderLane();
    expect(document.querySelectorAll('rect')).toHaveLength(0);
    unmount();
    mockLaneWidth(3000);           // 1000 px a bar
    renderLane();
    // Bar 1: 4 kicks; bar 2: 4 + 1 added; bar 3: 4 dropped kicks.
    expect(document.querySelectorAll('rect')).toHaveLength(13);
  });

  it('opens the groove card from a cell: its names, the groove and that bar', () => {
    mockLaneWidth(60);
    renderLane();
    fireEvent.click(cells()[1]);
    expect(screen.getByText(/Groove A/)).toBeTruthy();
    expect(screen.getByText(/four on the floor/)).toBeTruthy();
    expect(screen.getByText('Bar 2')).toBeTruthy();
    // The groove sits behind the bar as a grey ghost: the node's four kicks.
    const ghost = document.querySelector('[data-annotation-popover] [data-testid="groove-ghost"]')!;
    expect(ghost.querySelectorAll('rect')).toHaveLength(4);
  });

  it('names a 2-bar loop\'s cell by both its bars, and the card by its length', () => {
    const long = node('A', [0, 8, 16, 20, 24, 28], undefined, {}, 8);
    mockLaneWidth(60);
    render(
      <PlayheadClockContext.Provider value={createPlayheadClock(0)}>
        <GrooveLaneRow laneId="g" model={laneOf('kick', long, item(long, 2))} duration={8} />
      </PlayheadClockContext.Provider>,
    );
    const titles = [...document.querySelectorAll<HTMLElement>('[title^="Bar"]')].map((c) => c.title.split(' · ')[0]);
    expect(titles).toEqual(['Bars 1–2', 'Bars 3–4']);
    fireEvent.click(document.querySelector<HTMLElement>('[title^="Bars 1–2"]')!);
    expect(screen.getByText(/2-bar loop/)).toBeTruthy();
    expect(screen.getByTestId('groove-run').title).toBe('Bars 1–4 · ×2');
  });

  it('lays the whole run out in the card, bar by bar, and a bar there opens its own card', () => {
    mockLaneWidth(60);
    renderLane();
    fireEvent.click(cells()[0]);
    const run = screen.getByTestId('groove-run');
    expect(run.title).toBe('Bars 1–3 · ×3');
    const runBars = [...run.querySelectorAll<HTMLElement>('[data-run-bar]')];
    expect(runBars.map((b) => b.dataset.runBar)).toEqual(['1', '2', '3']);
    expect(runBars[0].style.boxShadow).toContain('#ffffff');          // the card's bar
    expect(runBars[1].style.boxShadow).toContain('#fde68a');          // the fill
    expect(runBars[2].style.backgroundImage).toContain('repeating-linear-gradient');
    fireEvent.click(runBars[2]);
    expect(screen.getByText('Bar 3')).toBeTruthy();
  });

  it('plays every repeat of the run from the card, and stops it while it plays', () => {
    mockLaneWidth(60);
    const onPlay = vi.fn();
    const onStop = vi.fn();
    const clock = createPlayheadClock(2.5);
    const { rerender } = render(
      <PlayheadClockContext.Provider value={clock}>
        <GrooveLaneRow laneId="g" model={MODEL} duration={6} onPlay={onPlay} onStop={onStop} />
      </PlayheadClockContext.Provider>,
    );
    fireEvent.click(cells()[1]);
    fireEvent.click(screen.getByTestId('groove-play'));
    expect(onPlay).toHaveBeenCalledWith(0, 6);
    rerender(
      <PlayheadClockContext.Provider value={clock}>
        <GrooveLaneRow laneId="g" model={MODEL} duration={6} onPlay={onPlay} onStop={onStop} isPlaying />
      </PlayheadClockContext.Provider>,
    );
    fireEvent.click(screen.getByTestId('groove-play'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('plays the open card along, karaoke-style, with no toggle', () => {
    mockLaneWidth(60);
    const clock = createPlayheadClock(0.5);        // bar 1, step 4: a kick
    renderLane(false, clock);
    fireEvent.click(cells()[0]);
    const lit = () => [...document.querySelectorAll('[data-annotation-popover] rect[data-lit]')];
    // Bar 1's kick, and bar 1's kick in the run strip.
    expect(lit()).toHaveLength(2);
    act(() => clock.set(2.0));                      // bar 2, step 0: the groove's kick
    expect(screen.getByText('Bar 2')).toBeTruthy(); // the card follows on to bar 2
    expect(lit()).toHaveLength(2);                  // bar 2's kick, and bar 2 in the strip
    act(() => clock.set(4.0));                      // bar 3 dropped the kick: nothing lights
    expect(lit()).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="staff-now"]').length).toBeGreaterThan(0);
  });

  it('opens on the bar clicked, not the one playing, and follows only once playback moves', () => {
    mockLaneWidth(60);
    const clock = createPlayheadClock(4.5);        // bar 3 is sounding, paused
    renderLane(false, clock);
    fireEvent.click(cells()[0]);
    expect(screen.getByText('Bar 1')).toBeTruthy();
    act(() => clock.set(4.9));                      // still bar 3: the card stays
    expect(screen.getByText('Bar 1')).toBeTruthy();
    act(() => clock.set(2.0));                      // bar 2 now: the card turns to it
    expect(screen.getByText('Bar 2')).toBeTruthy();
  });

  it('plays along only when visualized: nothing lights until it is on', () => {
    mockLaneWidth(60);
    renderLane(false, createPlayheadClock(1));
    expect(screen.queryByTestId('drum-flash-kick')).toBeNull();
    expect(cells().every((c) => !c.style.boxShadow.includes('rgba(255, 255, 255'))).toBe(true);
  });

  it('lights the bar under the playhead and flashes each drum as it is struck', () => {
    mockLaneWidth(60);
    const clock = createPlayheadClock(2.0);        // bar 2, step 0: a kick
    renderLane(true, clock);
    expect(cells()[1].style.boxShadow).toContain('inset 0 0 0 2px');
    const kick = screen.getByTestId('drum-flash-kick');
    expect(Number(kick.style.opacity)).toBeGreaterThan(0.5);
    act(() => clock.set(2.25));                     // step 2: the kick the fill added
    expect(Number(kick.style.opacity)).toBeGreaterThan(0.5);
    act(() => clock.set(3.25));                     // step 8 struck a quarter second ago: nearly out
    expect(Number(kick.style.opacity)).toBeLessThan(0.15);
    act(() => clock.set(3.3));                      // 0.3 s on: the kick has faded
    expect(Number(kick.style.opacity)).toBe(0);
    act(() => clock.set(3.5));                      // step 12: the next kick
    expect(Number(kick.style.opacity)).toBeGreaterThan(0.5);
  });

  it('gives a bass lane its bass row and its own flash', () => {
    mockLaneWidth(60);
    const bass = node('A', [0, 6], 110);
    render(
      <PlayheadClockContext.Provider value={createPlayheadClock(2.0)}>
        <GrooveLaneRow laneId="g" model={laneOf('bass', bass, item(bass, 3))} duration={6} visualize />
      </PlayheadClockContext.Provider>,
    );
    expect(Number(screen.getByTestId('drum-flash-bass').style.opacity)).toBeGreaterThan(0.5);
    expect(screen.queryByTestId('drum-flash-kick')).toBeNull();  // not this lane's, not drawn
  });

  it('draws no bass row on a drum lane', () => {
    mockLaneWidth(60);
    renderLane(true, createPlayheadClock(2.0));
    expect(screen.queryByTestId('drum-flash-bass')).toBeNull();
  });

  it('never flashes a hit the bar dropped', () => {
    mockLaneWidth(60);
    renderLane(true, createPlayheadClock(4.0));    // bar 3 dropped every kick
    expect(Number(screen.getByTestId('drum-flash-kick').style.opacity)).toBe(0);
  });
});
