/**
 * A lyric word's onsets: one lane says what was sung and where each part of it
 * began — a tick per onset, its syllable beside it, a bare tick where no
 * syllable was laid, and nothing outside a word trimmed by hand.
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { LyricsLayerRow } from './LyricsLayerRow';
import { nearestGrip, packRows } from './lyricsGrip';

describe('LyricsLayerRow onsets', () => {
  it('draws each onset inside the word, with its syllable', () => {
    const { container } = render(
      <LyricsLayerRow
        duration={100}
        color="#22d3ee"
        items={[{
          id: 'w', time: 10, end: 12, text: 'a-la-ta', kind: 'word',
          onsets: [{ time: 9, text: 'x' }, { time: 10, text: 'a' }, { time: 10.5 }, { time: 11, text: 'la' }, { time: 11.5, text: 'ta' }],
        }]}
      />,
    );
    const ticks = [...container.querySelectorAll<HTMLElement>('span.h-1\\/2')];
    // The onset at 9 s lies before the (trimmed) word and is not drawn.
    expect(ticks.map((t) => t.style.left)).toEqual(['10%', '10.5%', '11%', '11.5%']);
    expect(ticks.map((t) => t.textContent)).toEqual(['a', '', 'la', 'ta']);
    // Each label may run only until the next onset (or the word's end).
    expect(ticks.map((t) => parseFloat(t.style.width))).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe('LyricsLayerRow envelopes', () => {
  it('draws each sound up to its peak, down to its sustain, held and released', () => {
    const { container } = render(
      <LyricsLayerRow
        duration={100}
        color="#22d3ee"
        items={[
          { id: 'loud', time: 10, end: 12, text: 'a-la', kind: 'word',
            envelope: { start: 9.9, peak: 10.2, decayEnd: 10.5, release: 11.5, end: 13, peakDb: -10, sustainDb: -15 } },
          // 15 dB quieter, and a hit: no sustain.
          { id: 'hit', time: 20, end: 20.3, text: '[bark]', kind: 'word',
            envelope: { start: 20, peak: 20.05, decayEnd: 20.2, release: 20.2, end: 20.6, peakDb: -25 } },
          { id: 'bare', time: 30, text: 'oh', kind: 'word' },
        ]}
      />,
    );
    const shapes = [...container.querySelectorAll('polygon')].map((p) => p.getAttribute('points'));
    // y runs 1 (silent) … 0 (the lane's loudest peak); 30 dB spans the lane.
    expect(shapes).toEqual([
      '9.9,1 10.2,0 10.5,0.5 11.5,0.5 13,1',
      '20,1 20.05,0.5 20.6,1',
    ]);
    expect(container.querySelector('button[title*="a-la"]')?.getAttribute('title'))
      .toContain('attack 300 ms, decay 300 ms, sustain 1000 ms at -15 dB, release 1500 ms');
  });
});

describe('nearestGrip', () => {
  // Two aligned words back to back at 100 px/s: A 1.00–1.10, B 1.10–1.30.
  // A's end and B's tick are 3 px apart, and A's end handle is drawn over B's
  // tick — the press must go to whichever the pointer is nearer.
  const placed = [
    { item: { id: 'A', time: 1.0, end: 1.1, text: 'a', kind: 'word' as const }, widthPct: 1 },
    { item: { id: 'B', time: 1.1, end: 1.3, text: 'b', kind: 'word' as const }, widthPct: 1 },
  ];
  const at = (x: number) => nearestGrip(placed, x, 100, true, true);

  it("a press on the right word's tick moves the right word", () => {
    expect(at(113)).toEqual({ id: 'B', kind: 'move' });
    expect(at(112)).toEqual({ id: 'B', kind: 'move' });
  });

  it('a press on the boundary itself trims the left word', () => {
    expect(at(110)).toEqual({ id: 'A', kind: 'end' });
  });

  it('nothing within reach leaves the press to the element it landed on', () => {
    expect(at(120)).toBeNull();
  });

  it('a lane that only trims never answers with a move', () => {
    expect(nearestGrip(placed, 113, 100, false, true)).toEqual({ id: 'A', kind: 'end' });
  });
});

describe('LyricsLayerRow overlaps', () => {
  const w = (id: string, time: number, end: number) => ({ id, time, end, text: id, kind: 'word' as const });

  it('words back to back share one row; an overlapping word gets its own', () => {
    expect(packRows([w('a', 1, 2), w('b', 2, 3), w('c', 3, 4)])).toEqual({ rows: [0, 0, 0], counts: [1, 1, 1], count: 1 });
    expect(packRows([w('a', 1, 2.5), w('b', 2, 3), w('c', 3, 4)])).toEqual({ rows: [0, 1, 0], counts: [2, 2, 1], count: 2 });
  });

  it('a line over its words keeps the top row, even once a word starts before it', () => {
    const line = { id: 'L', time: 2, end: 6, text: 'bird turkey', kind: 'line' as const };
    expect(packRows([line, w('b', 2, 3), w('t', 4, 6)]).rows).toEqual([0, 1, 1]);
    // The word dragged earlier than its line sorts first and still sits below.
    expect(packRows([w('b', 1, 3), line, w('t', 4, 6)]).rows).toEqual([1, 0, 1]);
  });

  it('a pile of words at one instant splits only its own stretch of the lane', () => {
    // A clean line, then three words Whisper stacked on one moment.
    const pile = [w('p1', 85, 85.3), w('p2', 85, 85.3), w('p3', 85, 85.3)];
    const { rows, counts } = packRows([w('a', 9, 9.5), w('b', 9.5, 10), ...pile, w('z', 90, 91)]);
    expect(rows).toEqual([0, 0, 0, 1, 2, 0]);
    expect(counts).toEqual([1, 1, 3, 3, 3, 1]);
    const { container } = render(
      <LyricsLayerRow duration={100} color="#22d3ee" items={[w('a', 9, 9.5), ...pile]} />,
    );
    expect(container.querySelector<HTMLElement>('button[title^="a @"]')!.closest<HTMLElement>('[style*="height"]')!.style.height).toBe('100%');
  });

  it('hatches the overlapping stretch and names it in both tooltips', () => {
    const { container } = render(
      <LyricsLayerRow duration={100} color="#22d3ee" items={[w('ah', 10, 12), w('na', 11, 13)]} />,
    );
    const hatch = container.querySelector<HTMLElement>('[data-lyric-overlap]')!;
    expect(hatch.style.left).toBe('11%');
    expect(parseFloat(hatch.style.width)).toBe(1);
    expect(container.querySelector('button[title^="ah"]')?.getAttribute('title')).toContain('overlaps "na"');
    expect(container.querySelector('button[title^="na"]')?.getAttribute('title')).toContain('overlaps "ah"');
  });

  it("a press in the lower row grabs the lower row's word, not the one above", () => {
    const placed = [
      { item: w('A', 1.0, 1.2), widthPct: 1, row: 0, rows: 2 },
      { item: w('B', 1.1, 1.3), widthPct: 1, row: 1, rows: 2 },
    ];
    // 113 px is B's tick and 3 px from nothing in row 0 (the lower half).
    expect(nearestGrip(placed, 113, 100, true, true, 0.75)).toEqual({ id: 'B', kind: 'move' });
    // At A's end (120 px), row 1 answers with nothing; row 0 trims A.
    expect(nearestGrip(placed, 120, 100, true, true, 0.75)).toBeNull();
    expect(nearestGrip(placed, 120, 100, true, true, 0.25)).toEqual({ id: 'A', kind: 'end' });
  });
});

describe('LyricsLayerRow height grip', () => {
  const items = [
    { id: 'a', time: 1, end: 5, text: 'line', kind: 'line' as const },
    { id: 'b', time: 2, end: 3, text: 'word', kind: 'word' as const },
  ];

  it('drags the bottom edge down, remembers it, and double-click resets', () => {
    localStorage.removeItem('tc:test-lane-h');
    const { container, unmount } = render(
      <LyricsLayerRow duration={10} color="#22d3ee" items={items} heightKey="tc:test-lane-h" />,
    );
    const lane = container.firstElementChild as HTMLElement;
    const grip = container.querySelector<HTMLElement>('[data-lyrics-height-grip]')!;
    expect(lane.style.minHeight).toBe('26px');
    Object.defineProperty(lane, 'offsetHeight', { configurable: true, value: 26 });
    fireEvent.pointerDown(grip, { clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 160 });
    fireEvent.pointerUp(window, { clientY: 160 });
    expect(lane.style.minHeight).toBe('86px');
    expect(localStorage.getItem('tc:test-lane-h')).toBe('86');
    unmount();

    const again = render(
      <LyricsLayerRow duration={10} color="#22d3ee" items={items} heightKey="tc:test-lane-h" />,
    );
    const lane2 = again.container.firstElementChild as HTMLElement;
    expect(lane2.style.minHeight).toBe('86px');
    fireEvent.doubleClick(again.container.querySelector('[data-lyrics-height-grip]')!);
    expect(lane2.style.minHeight).toBe('26px');
    expect(localStorage.getItem('tc:test-lane-h')).toBeNull();
  });

  it('has no grip without a place to remember the height', () => {
    const { container } = render(<LyricsLayerRow duration={10} color="#22d3ee" items={items} />);
    expect(container.querySelector('[data-lyrics-height-grip]')).toBeNull();
  });
});
